import { genericToken } from '../adblock/cosmetic';
import { USER_LIST_ID } from '../adblock/registry';
import type { CosmeticEntry, CosmeticFlag, PopupData } from '../adblock/types';
import type { ProceduralFilter } from '../adblock/procedural';
import { entityKeys, hostMatchesAny, hostnameAncestors } from '../shared/domain';
import { idbGet, idbGetMany, idbPut, idbReplaceAll } from '../shared/idb';
import { createLogger } from '../shared/log';
import { LRU, createMutex } from '../shared/util';
import { getStoredLists } from './lists';
import { ready } from './state';

/**
 * Merged cosmetic index across all enabled lists + user filters, persisted
 * in IndexedDB so a freshly woken service worker can answer page lookups
 * without re-reading every list:
 *
 *   cosSpec[hostname|entity|'*'] → { e: CosmeticEntry, n?: string[] }[]
 *   cosGen[".cls"|"#id"]         → selectors[]   (low-generic, injected lazily)
 *   meta.highGeneric             → selectors[]   (injected on every page)
 *   meta.genericExceptions, meta.genericNot, meta.popup
 */
const log = createLogger('cosmetic');
const mutex = createMutex();

interface IndexedEntry {
  e: CosmeticEntry;
  n?: string[];
}

interface MetaBlob {
  highGeneric: string[];
  genericExceptions: string[];
  genericNot: { s: string; not: string[] }[];
  version: number;
}

export interface PageCosmetics {
  flags: Set<CosmeticFlag>;
  /** Selectors to hide (specific + high-generic), already filtered by exceptions. */
  hide: string[];
  /** `selector { declarations }` rules. */
  styles: string[];
  procedural: ProceduralFilter[];
  scriptlets: [string, string[]][];
  /** Exceptions that apply on this page (for filtering low-generic lookups). */
  unhide: Set<string>;
  generic: boolean;
}

let meta: MetaBlob | null = null;
let genericExceptionSet: Set<string> | null = null;
const pageCache = new LRU<string, PageCosmetics>(200);
const tokenCache = new LRU<string, string[]>(5000);
let popupCache: PopupData | null = null;

async function loadMeta(): Promise<MetaBlob> {
  if (!meta) {
    meta = (await idbGet<MetaBlob>('meta', 'cosmeticMeta')) ?? {
      highGeneric: [],
      genericExceptions: [],
      genericNot: [],
      version: 0,
    };
    genericExceptionSet = new Set(meta.genericExceptions);
  }
  return meta;
}

function invalidateCaches(): void {
  meta = null;
  genericExceptionSet = null;
  popupCache = null;
  pageCache.clear();
  tokenCache.clear();
}

/** Rebuilds the merged index from the stored lists. */
export function rebuildCosmeticIndex(): Promise<void> {
  return mutex(async () => {
    const t0 = Date.now();
    const s = await ready();
    const ids = [...s.subscriptions.filter((x) => x.enabled).map((x) => x.id), USER_LIST_ID];
    const lists = await getStoredLists(ids);

    const spec = new Map<string, IndexedEntry[]>();
    const gen = new Map<string, Set<string>>();
    const high = new Set<string>();
    const genericExceptions = new Set<string>();
    const genericNot: { s: string; not: string[] }[] = [];
    const popup: PopupData = { block: [], allow: [], hosts: [] };
    const hosts = new Set<string>();

    for (const id of ids) {
      const l = lists.get(id);
      if (!l) continue;
      const c = l.cosmetic;
      for (const sel of c.generic) {
        const tok = genericToken(sel);
        if (tok) {
          let set = gen.get(tok);
          if (!set) gen.set(tok, (set = new Set()));
          set.add(sel);
        } else high.add(sel);
      }
      for (const ex of c.genericExceptions) genericExceptions.add(ex);
      genericNot.push(...c.genericNot);
      for (const r of c.specific) {
        const item: IndexedEntry = r.n ? { e: r.e, n: r.n } : { e: r.e };
        for (const d of r.d) {
          let arr = spec.get(d);
          if (!arr) spec.set(d, (arr = []));
          arr.push(item);
        }
      }
      popup.block.push(...l.popup.block);
      popup.allow.push(...l.popup.allow);
      for (const h of l.popup.hosts) hosts.add(h);
    }
    popup.hosts = [...hosts];
    for (const ex of genericExceptions) high.delete(ex);

    const prev = (await idbGet<MetaBlob>('meta', 'cosmeticMeta'))?.version ?? 0;
    await idbReplaceAll('cosSpec', spec.entries());
    await idbReplaceAll('cosGen', [...gen.entries()].map(([k, v]) => [k, [...v]] as [string, string[]]));
    await idbPut('meta', 'cosmeticMeta', {
      highGeneric: [...high],
      genericExceptions: [...genericExceptions],
      genericNot,
      version: prev + 1,
    } satisfies MetaBlob);
    await idbPut('meta', 'popup', popup);
    invalidateCaches();
    log.info(`index rebuilt in ${Date.now() - t0} ms: ${spec.size} hosts, ${gen.size} tokens, ${high.size} high-generic`);
  });
}

/** Computes everything cosmetic for one hostname. Cached per hostname. */
export async function pageCosmetics(hostname: string): Promise<PageCosmetics> {
  const cached = pageCache.get(hostname);
  if (cached) return cached;
  const m = await loadMeta();
  const keys = [...hostnameAncestors(hostname), ...entityKeys(hostname), '*'];
  const found = await idbGetMany<IndexedEntry[]>('cosSpec', keys);

  const flags = new Set<CosmeticFlag>();
  const hide = new Set<string>();
  const unhide = new Set<string>();
  const styles = new Map<string, string>();
  const proc = new Map<string, ProceduralFilter>();
  const js = new Map<string, [string, string[]]>();
  const unjs = new Set<string>();

  for (const list of found) {
    if (!list) continue;
    for (const { e, n } of list) {
      if (n && hostMatchesAny(hostname, n)) continue;
      switch (e.t) {
        case 'flag':
          flags.add(e.s);
          break;
        case 'hide':
          hide.add(e.s);
          break;
        case 'unhide':
          unhide.add(e.s);
          break;
        case 'style':
          styles.set(e.s, `${e.sel}{${e.css}}`);
          break;
        case 'proc':
          proc.set(e.s, e.p);
          break;
        case 'js':
          js.set(e.s, [e.name, e.args]);
          break;
        case 'unjs':
          unjs.add(e.s);
          break;
      }
    }
  }

  const elemhide = flags.has('elemhide');
  const specificOn = !elemhide && !flags.has('specifichide');
  const genericOn = !elemhide && !flags.has('generichide');

  const outHide: string[] = [];
  if (specificOn) for (const sel of hide) if (!unhide.has(sel)) outHide.push(sel);
  if (genericOn) {
    for (const sel of m.highGeneric) if (!unhide.has(sel)) outHide.push(sel);
    for (const g of m.genericNot) {
      if (!hostMatchesAny(hostname, g.not) && !unhide.has(g.s) && !genericExceptionSet!.has(g.s)) outHide.push(g.s);
    }
  }
  const result: PageCosmetics = {
    flags,
    hide: [...new Set(outHide)],
    styles: specificOn ? [...styles].filter(([k]) => !unhide.has(k)).map(([, v]) => v) : [],
    procedural: specificOn ? [...proc].filter(([k]) => !unhide.has(k)).map(([, v]) => v) : [],
    scriptlets: unjs.has('') ? [] : [...js].filter(([k]) => !unjs.has(k)).map(([, v]) => v),
    unhide,
    generic: genericOn,
  };
  pageCache.set(hostname, result);
  return result;
}

/** Looks up low-generic selectors for id/class tokens seen in a page. */
export async function genericSelectorsFor(tokens: string[], page: PageCosmetics): Promise<string[]> {
  if (!page.generic || !tokens.length) return [];
  await loadMeta();
  const out: string[] = [];
  const missing: string[] = [];
  for (const t of tokens) {
    const c = tokenCache.get(t);
    if (c) out.push(...c);
    else missing.push(t);
  }
  if (missing.length) {
    const found = await idbGetMany<string[]>('cosGen', missing);
    missing.forEach((t, i) => {
      const sels = found[i] ?? [];
      tokenCache.set(t, sels);
      out.push(...sels);
    });
  }
  return out.filter((s) => !page.unhide.has(s) && !genericExceptionSet!.has(s));
}

export async function popupData(): Promise<PopupData> {
  if (!popupCache) popupCache = (await idbGet<PopupData>('meta', 'popup')) ?? { block: [], allow: [], hosts: [] };
  return popupCache;
}

/** CSS text hiding the given selectors. One rule per selector so an invalid one can't void the rest. */
export function hideCss(selectors: readonly string[]): string {
  let css = '';
  for (const s of selectors) css += `${s}{display:none!important}\n`;
  return css;
}
