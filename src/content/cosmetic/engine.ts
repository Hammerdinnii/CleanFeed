import type { ProceduralFilter } from '../../adblock/procedural';
import { send, trySend, type ContentInit } from '../../shared/messages';
import { domReady, domWatcher } from '../dom-watcher';
import { applyAction, runProcedural, watchedAttributes, type AppliedAction } from './procedural-exec';

/**
 * Content-side cosmetic filtering.
 *
 *  - Specific + high-generic CSS was already injected by the background as a
 *    user stylesheet before this runs (see background/cosmetic-service.ts).
 *  - Low-generic selectors are requested lazily: we collect id/class tokens
 *    present in the DOM and ask the background for selectors keyed by them.
 *  - Procedural filters run here, re-applied as the DOM changes.
 */
export class CosmeticEngine {
  private seenTokens = new Set<string>();
  private pendingTokens = new Set<string>();
  private tokenTimer: ReturnType<typeof setTimeout> | null = null;
  private applied: AppliedAction[] = [];
  private cssChunks: string[];
  private revealed = false;
  private procTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private attrObserver: MutationObserver | null = null;
  hiddenCount = 0;

  constructor(private init: ContentInit) {
    this.cssChunks = [...init.cosmetic.css];
  }

  get hideAttr(): string {
    return this.init.cosmetic.hideAttr;
  }

  start(): void {
    const { generic, procedural } = this.init.cosmetic;
    if (!generic && !procedural.length) return;
    const onBatch = (added: Element[]) => {
      if (this.revealed) return;
      if (generic) for (const el of added) this.collectTokens(el);
      if (procedural.length) this.scheduleProcedural();
    };
    this.unsub = domWatcher.subscribe(onBatch);
    void domReady().then(() => {
      if (generic && document.documentElement) this.collectTokens(document.documentElement);
      if (procedural.length) {
        this.runProcedural(procedural);
        const attrs = watchedAttributes(procedural);
        if (attrs.length) {
          this.attrObserver = new MutationObserver(() => this.scheduleProcedural());
          this.attrObserver.observe(document, { attributes: true, subtree: true, attributeFilter: attrs });
        }
      }
    });
  }

  private collectTokens(root: Element): void {
    const visit = (el: Element) => {
      const id = el.id;
      if (id && typeof id === 'string') this.addToken('#' + id);
      const cl = el.classList;
      if (cl) for (let i = 0; i < cl.length; i++) this.addToken('.' + cl[i]);
    };
    visit(root);
    const all = root.querySelectorAll('[id],[class]');
    for (let i = 0; i < all.length; i++) visit(all[i]!);
    if (this.pendingTokens.size && !this.tokenTimer) {
      this.tokenTimer = setTimeout(() => this.flushTokens(), 30);
    }
  }

  private addToken(t: string): void {
    if (t.length > 128 || this.seenTokens.has(t)) return;
    this.seenTokens.add(t);
    this.pendingTokens.add(t);
  }

  private async flushTokens(): Promise<void> {
    this.tokenTimer = null;
    const tokens = [...this.pendingTokens];
    this.pendingTokens.clear();
    if (!tokens.length || this.revealed) return;
    const res = await trySend('cs:generic', { tokens }, { css: null });
    if (res.css) this.cssChunks.push(res.css);
  }

  private scheduleProcedural(): void {
    if (this.procTimer || this.revealed) return;
    this.procTimer = setTimeout(() => {
      this.procTimer = null;
      this.runProcedural(this.init.cosmetic.procedural);
    }, 120);
  }

  private runProcedural(filters: ProceduralFilter[]): void {
    const deadline = performance.now() + 50; // keep each pass short; the rest runs next pass
    let newly = 0;
    for (const f of filters) {
      if (performance.now() > deadline) {
        this.scheduleProcedural();
        break;
      }
      let matched: Element[];
      try {
        matched = runProcedural(f);
      } catch {
        continue;
      }
      for (const el of matched) {
        const r = applyAction(el, f.action, this.hideAttr);
        if (r) {
          this.applied.push(r);
          newly++;
        } else if (f.action[0] === 'remove') newly++;
      }
    }
    if (newly) {
      this.hiddenCount += newly;
      void trySend('cs:count', { elements: newly }, undefined);
    }
  }

  /** Undo all element hiding on this page until reload ("reveal hidden content"). */
  async reveal(): Promise<void> {
    this.revealed = true;
    this.unsub?.();
    this.attrObserver?.disconnect();
    for (const a of this.applied) a.undo();
    this.applied = [];
    for (const css of this.cssChunks) {
      try {
        await send('cs:css', { css, remove: true });
      } catch {
        /* ignore */
      }
    }
    this.cssChunks = [];
  }
}
