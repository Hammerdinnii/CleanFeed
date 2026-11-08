import { blocklistSignal, BlocklistIndex, displayHandle } from '../../ai/detectors/blocklist';
import { compileKeywords, keywordSignals, type CompiledKeyword } from '../../ai/detectors/keywords';
import { labelSignal } from '../../ai/detectors/platform-labels';
import { compilePatterns, resolvePatterns, textPatternSignal, type CompiledPattern } from '../../ai/detectors/text-patterns';
import { textStatsSignal } from '../../ai/detectors/text-stats';
import { BUILTIN_COMMUNITIES } from '../../ai/communities';
import { combineSignals, imageSignals } from '../../ai/scoring';
import { profileText } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { send, trySend } from '../../shared/messages';
import { getLocal, onLocalChange, type LocalSchema } from '../../shared/storage';
import { mergeSettings } from '../../shared/settings';
import { LRU } from '../../shared/util';
import type { AiMode, BlockEntry, ImageAnalysis, Settings, Signal, Verdict } from '../../shared/types';
import type { SiteAdapter } from '../../sites/adapters';
import { domWatcher } from '../dom-watcher';
import { ActionUI, setTreatment } from './actions';

/**
 * AI content scanner.
 *
 * Pipeline per item (post, video card, comment, article…):
 *   discover (selector / adapter extras, on DOM batches)
 *     → wait until near the viewport (IntersectionObserver, 800px margin)
 *     → extract via the site adapter
 *     → synchronous detectors: labels, blocklist, keywords, text patterns, text stats
 *     → verdict → treatment (collapse / blur / dim / label)
 *     → asynchronous image detectors (metadata, ONNX model) refine the verdict
 *
 * Verdicts are cached per item key; recycled DOM nodes (YouTube, X) are
 * detected by fingerprint and re-evaluated.
 */
interface ItemState {
  fp: string;
  item: ItemInfo | null;
  verdict: Verdict | null;
  imageSignals: Signal[];
  imagesRequested: boolean;
  ui: ActionUI | null;
  target: Element | null;
  revealed: boolean;
  counted: boolean;
  visible: boolean;
}

interface Context {
  settings: Settings;
  mode: AiMode;
  patterns: CompiledPattern[];
  keywords: CompiledKeyword[];
  blocklist: BlocklistIndex;
  notAi: Set<string>;
  trusted: Set<string>;
  modelInstalled: boolean;
}

const MAX_IMAGES_PER_ITEM = 4;
const MAX_INFLIGHT_IMAGES = 4;
/** On sites without an adapter, analyze at most this many images per page load. */
const GENERIC_IMAGE_BUDGET = 12;

export class AiScanner {
  private states = new WeakMap<Element, ItemState>();
  private tracked = new Set<Element>();
  private ctx: Context | null = null;
  private io: IntersectionObserver;
  private unsubs: (() => void)[] = [];
  private revalidateTimer: ReturnType<typeof setInterval> | null = null;
  private lastExtras = 0;
  private extrasTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUrl = location.href;
  private imageQueue: (() => Promise<void>)[] = [];
  private inflight = 0;
  private imageCache = new LRU<string, Promise<ImageAnalysis | null>>(1500);
  private genericImagesLeft = GENERIC_IMAGE_BUDGET;
  private stopped = false;

  constructor(
    private adapter: SiteAdapter,
    private hostname: string,
    private modeOverride: AiMode | undefined,
    /** Only run keyword rules that hide unwanted content (AI filtering is off for this site). */
    private keywordsOnly = false,
  ) {
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '800px 0px 800px 0px' });
  }

  async start(): Promise<void> {
    await this.loadContext();
    if (this.stopped) return;
    this.scanRoot(document);
    this.unsubs.push(domWatcher.subscribe((added) => this.onBatch(added)));
    this.unsubs.push(
      onLocalChange(
        ['settings', 'blocklist', 'notAi', 'trustedAuthors', 'keywordRules', 'textPatterns', 'communityLists', 'builtinCommunities', 'modelManifest'],
        () => void this.reload(),
      ),
    );
    // Revalidate visible items: catches recycled nodes and SPA navigations cheaply.
    this.revalidateTimer = setInterval(() => this.revalidate(), 1500);
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.io.disconnect();
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    for (const el of this.tracked) this.clear(el);
    this.tracked.clear();
  }

  private async loadContext(): Promise<void> {
    const keys: (keyof LocalSchema)[] = [
      'settings', 'blocklist', 'notAi', 'trustedAuthors', 'keywordRules', 'textPatterns', 'communityLists', 'builtinCommunities', 'modelManifest',
    ];
    const d = await getLocal(keys);
    const settings = mergeSettings(d.settings);
    const entries: BlockEntry[] = [...(d.blocklist ?? [])];
    for (const cl of d.communityLists ?? []) if (cl.enabled) entries.push(...cl.entries);
    if (d.builtinCommunities !== false) entries.push(...BUILTIN_COMMUNITIES);
    const isGeneric = this.adapter.id === 'generic';
    this.ctx = {
      settings,
      mode: this.modeOverride ?? (isGeneric ? settings.ai.genericMode : settings.ai.mode),
      patterns: compilePatterns(resolvePatterns(d.textPatterns)),
      keywords: compileKeywords(d.keywordRules ?? []),
      blocklist: new BlocklistIndex(entries),
      notAi: new Set(Object.keys(d.notAi ?? {})),
      trusted: new Set(d.trustedAuthors ?? []),
      modelInstalled: !!d.modelManifest,
    };
  }

  private async reload(): Promise<void> {
    await this.loadContext();
    for (const el of this.tracked) {
      const st = this.states.get(el);
      if (!st) continue;
      st.verdict = null;
      st.fp = '';
      // Collapsed items are display:none and therefore never "intersecting".
      if (st.visible || st.ui) this.evaluate(el);
    }
  }

  // --- discovery -------------------------------------------------------------

  private onBatch(added: Element[]): void {
    for (const root of added) this.scanRoot(root);
    this.scheduleExtras();
  }

  private scanRoot(root: ParentNode): void {
    const sel = this.adapter.itemSelector;
    if (root instanceof Element && root.matches(sel)) this.track(root);
    for (const el of root.querySelectorAll(sel)) this.track(el);
    if (root === document) this.runExtras();
  }

  private scheduleExtras(): void {
    if (!this.adapter.findExtra || this.extrasTimer) return;
    const wait = Math.max(0, 1000 - (performance.now() - this.lastExtras));
    this.extrasTimer = setTimeout(() => {
      this.extrasTimer = null;
      this.runExtras();
    }, wait);
  }

  private runExtras(): void {
    if (!this.adapter.findExtra) return;
    this.lastExtras = performance.now();
    if (this.adapter.id === 'google' && this.ctx?.settings.ai.googleAiOverview === 'show') return;
    if (this.adapter.id === 'generic' && !this.ctx?.settings.ai.genericImages) return;
    for (const el of this.adapter.findExtra(document)) {
      this.track(el);
      // Extras are re-checked eagerly: their fingerprint depends on page state.
      const st = this.states.get(el);
      if (st && (st.visible || st.ui)) this.evaluate(el);
    }
  }

  private track(el: Element): void {
    if (this.tracked.has(el) || el.closest('cleanfeed-bar')) return;
    this.tracked.add(el);
    this.states.set(el, {
      fp: '',
      item: null,
      verdict: null,
      imageSignals: [],
      imagesRequested: false,
      ui: null,
      target: null,
      revealed: false,
      counted: false,
      visible: false,
    });
    this.io.observe(el);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const st = this.states.get(e.target);
      if (!st) continue;
      st.visible = e.isIntersecting;
      if (e.isIntersecting) this.evaluate(e.target);
    }
  }

  private revalidate(): void {
    if (location.href !== this.lastUrl) {
      this.lastUrl = location.href;
      this.runExtras();
    }
    for (const el of this.tracked) {
      if (!el.isConnected) {
        this.clear(el);
        this.tracked.delete(el);
        this.io.unobserve(el);
        continue;
      }
      const st = this.states.get(el);
      if (st && (st.visible || st.ui)) this.evaluate(el);
    }
  }

  // --- evaluation ------------------------------------------------------------

  private evaluate(el: Element): void {
    const ctx = this.ctx;
    const st = this.states.get(el);
    if (!ctx || !st) return;
    const fp = this.adapter.fingerprint(el);
    if (st.fp === fp && st.item) return;
    if (st.fp && st.fp !== fp) this.reset(el, st); // recycled node now shows different content
    st.fp = fp;

    let item: ItemInfo | null;
    try {
      item = this.adapter.extract(el);
    } catch {
      item = null;
    }
    if (!item) {
      st.fp = ''; // retry on next pass (content may still be loading)
      return;
    }
    st.item = item;
    if (ctx.notAi.has(item.key) || (item.author && ctx.trusted.has(`${item.author.platform}:${item.author.handle}`))) {
      this.clear(el);
      return;
    }

    const verdict = this.syncVerdict(item, ctx, st.imageSignals);
    this.apply(el, st, verdict);
    this.requestImages(el, st, item, ctx);
  }

  private syncVerdict(item: ItemInfo, ctx: Context, extra: Signal[]): Verdict {
    const d = ctx.settings.ai.detectors;
    const signals: Signal[] = [];
    if (this.keywordsOnly) {
      return combineSignals(
        keywordSignals(item, ctx.keywords, this.hostname).filter((s) => s.category === 'unwanted'),
        ctx.settings.ai.sensitivity,
      );
    }
    if (d.platformLabels) {
      const s = labelSignal(item);
      if (s) signals.push(s);
    }
    if (d.blocklist) {
      const s = blocklistSignal(item, ctx.blocklist);
      if (s) signals.push(s);
    }
    if (d.keywords) signals.push(...keywordSignals(item, ctx.keywords, this.hostname));
    if ((d.textPatterns || d.textStats) && item.text && this.adapter.textKinds.has(item.kind)) {
      const profile = profileText(item.text);
      if (d.textPatterns) {
        const s = textPatternSignal(profile, ctx.patterns, ctx.settings.ai.minWords);
        if (s) signals.push(s);
      }
      if (d.textStats) {
        const s = textStatsSignal(profile);
        if (s) signals.push(s);
      }
    }
    signals.push(...extra);
    return combineSignals(signals, ctx.settings.ai.sensitivity);
  }

  private apply(el: Element, st: ItemState, verdict: Verdict): void {
    const ctx = this.ctx!;
    st.verdict = verdict;
    if (!verdict.flagged) {
      this.clear(el);
      return;
    }
    if (verdict.category === 'ai' && st.item?.kind === 'overview' && ctx.settings.ai.googleAiOverview === 'show') return;
    const target = this.adapter.target?.(el) ?? el;
    st.target = target;
    const mode: AiMode = verdict.category === 'unwanted' ? 'collapse' : st.item?.kind === 'overview' ? 'collapse' : ctx.mode;

    if (!st.ui) {
      const item = st.item!;
      st.ui = new ActionUI(target, {
        onShow: () => {
          st.revealed = true;
          this.render(st, mode);
        },
        onHideAgain: () => {
          st.revealed = false;
          // "Hide" on a label-only item escalates to a collapse for this item.
          this.render(st, mode === 'label' || mode === 'dim' ? 'collapse' : mode);
        },
        onNotAi: () => {
          this.ctx?.notAi.add(item.key);
          this.clear(el);
          void trySend('data:mutate', { op: 'notAi', key: item.key, value: true }, { ok: false });
        },
        onBlockAuthor: item.author
          ? () =>
              void send('data:mutate', {
                op: 'blockAuthor',
                entry: { platform: item.author!.platform, handle: item.author!.handle, added: Date.now(), source: 'user' },
              })
          : undefined,
        onOpenSettings: () => void trySend('cs:openOptions', { section: 'ai' }, undefined),
      });
    }
    this.render(st, mode);
    if (!st.counted) {
      st.counted = true;
      void trySend('cs:count', { ai: 1 }, undefined);
    }
  }

  private render(st: ItemState, mode: AiMode): void {
    if (!st.ui || !st.target || !st.verdict) return;
    const item = st.item;
    st.ui.render({
      mode,
      verdict: st.verdict,
      showReasons: this.ctx?.settings.ai.showReasons ?? true,
      authorLabel: item?.author ? displayHandle(item.author) : undefined,
      revealed: st.revealed,
    });
    st.ui.attach();
    setTreatment(st.target, st.revealed ? null : st.verdict.category === 'unwanted' ? 'unwanted' : mode);
  }

  private clear(el: Element): void {
    const st = this.states.get(el);
    if (!st) return;
    st.ui?.detach();
    st.ui = null;
    if (st.target) setTreatment(st.target, null);
    st.target = null;
  }

  private reset(el: Element, st: ItemState): void {
    this.clear(el);
    st.item = null;
    st.verdict = null;
    st.imageSignals = [];
    st.imagesRequested = false;
    st.revealed = false;
    st.counted = false;
  }

  // --- images ----------------------------------------------------------------

  private requestImages(el: Element, st: ItemState, item: ItemInfo, ctx: Context): void {
    if (this.keywordsOnly || st.imagesRequested || !item.images.length) return;
    if (st.verdict?.flagged && st.verdict.signals.some((s) => s.definitive)) return; // already conclusive
    const d = ctx.settings.ai.detectors;
    const wantMeta = d.metadata && ctx.settings.ai.fetchImageMetadata && !this.adapter.stripsMetadata;
    const wantModel = d.imageModel && ctx.modelInstalled;
    if (!wantMeta && !wantModel) return;
    if (this.adapter.id === 'generic') {
      if (!ctx.settings.ai.genericImages || this.genericImagesLeft <= 0) return;
      this.genericImagesLeft -= Math.min(item.images.length, MAX_IMAGES_PER_ITEM);
    }
    st.imagesRequested = true;
    const fp = st.fp;
    const imgs = item.images.slice(0, MAX_IMAGES_PER_ITEM);
    const minPx = ctx.settings.ai.imageMinPx;
    let pending = imgs.length;
    const results: ImageAnalysis[] = [];
    const done = () => {
      if (--pending > 0) return;
      if (st.fp !== fp || !st.item) return; // node was recycled meanwhile
      const sigs: Signal[] = [];
      for (const r of results) sigs.push(...imageSignals(r, ctx.settings.ai.imageModelThreshold));
      if (!sigs.length) return;
      // Keep the strongest signal per detector.
      const best = new Map<string, Signal>();
      for (const s of sigs) {
        const cur = best.get(s.detector);
        if (!cur || s.score > cur.score) best.set(s.detector, s);
      }
      st.imageSignals = [...best.values()];
      this.apply(el, st, this.syncVerdict(st.item, ctx, st.imageSignals));
    };
    for (const img of imgs) {
      const run = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const url = this.adapter.analysisUrl?.(img) ?? (img.currentSrc || img.src);
        if (!url || !/^https?:/i.test(url) || w < minPx || h < minPx) {
          done();
          return;
        }
        this.enqueueImage(url, wantMeta, wantModel).then((r) => {
          if (r) results.push(r);
          done();
        });
      };
      if (img.complete) run();
      else {
        img.addEventListener('load', run, { once: true });
        img.addEventListener('error', () => done(), { once: true });
      }
    }
  }

  private enqueueImage(url: string, metadata: boolean, model: boolean): Promise<ImageAnalysis | null> {
    const key = `${url}|${metadata}|${model}`;
    let p = this.imageCache.get(key);
    if (p) return p;
    p = new Promise<ImageAnalysis | null>((resolve) => {
      this.imageQueue.push(async () => {
        try {
          resolve(await send('cs:image', { url, metadata, model }));
        } catch {
          resolve(null);
        }
      });
      this.pump();
    });
    this.imageCache.set(key, p);
    return p;
  }

  private pump(): void {
    while (this.inflight < MAX_INFLIGHT_IMAGES && this.imageQueue.length) {
      const job = this.imageQueue.shift()!;
      this.inflight++;
      void job().finally(() => {
        this.inflight--;
        this.pump();
      });
    }
  }

  /** "Reveal all": show every flagged item on this page. */
  revealAll(): void {
    for (const el of this.tracked) {
      const st = this.states.get(el);
      if (st?.ui && st.verdict?.flagged && !st.revealed) {
        st.revealed = true;
        this.render(st, this.ctx?.mode ?? 'collapse');
      }
    }
  }

  get flaggedCount(): number {
    let n = 0;
    for (const el of this.tracked) if (this.states.get(el)?.ui) n++;
    return n;
  }
}
