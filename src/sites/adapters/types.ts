import type { ItemInfo } from '../../ai/types';
import type { SiteId } from '../../shared/types';

/**
 * A site adapter turns a site's DOM into normalized items. Adapters contain
 * logic only; selectors live in ../selectors.ts.
 */
export interface SiteAdapter {
  id: SiteId;
  matches(hostname: string, url: URL): boolean;
  /** CSS selector for candidate items (posts, video cards, comments…). */
  itemSelector: string;
  /** Extracts a normalized item, or null if the element isn't analyzable (yet). */
  extract(el: Element): ItemInfo | null;
  /** Cheap identity of the content currently rendered in `el` (detects recycled nodes). */
  fingerprint(el: Element): string;
  /** Element that actions apply to (default: the item element). */
  target?(el: Element): Element;
  /** Element to hide for a promoted item (default: `target`, then the item). */
  adTarget?(el: Element): Element;
  /** True for promoted / sponsored items (feed-ad hiding). */
  isPromoted?(el: Element): boolean;
  /** Selector for ad containers to hide wholesale (feed-ad hiding). */
  feedAdSelector?: string;
  /** Additional item elements discovered by custom logic (e.g. AI Overviews, watch-page player). */
  findExtra?(root: ParentNode): Element[];
  /** The platform recompresses images and strips metadata; skip metadata fetches. */
  stripsMetadata: boolean;
  /** URL variant better suited for analysis (smaller, cache-friendly); null to skip. */
  analysisUrl?(img: HTMLImageElement): string | null;
  /** Which item kinds get text heuristics (others rely on labels/blocklists/images). */
  textKinds: ReadonlySet<ItemInfo['kind']>;
}

/** Text of the first element matching `sel` within `root`. */
export function textOf(root: ParentNode, sel: string): string {
  const el = root.querySelector(sel);
  return el?.textContent?.trim() ?? '';
}

export function attr(el: Element | null | undefined, name: string): string {
  return el?.getAttribute(name)?.trim() ?? '';
}

/** Images that are loaded and large enough to be worth analyzing. */
export function largeImages(root: ParentNode, sel: string, minPx: number): HTMLImageElement[] {
  const out: HTMLImageElement[] = [];
  for (const img of root.querySelectorAll<HTMLImageElement>(sel)) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!img.currentSrc && !img.src) continue;
    if (img.complete && (w < minPx || h < minPx)) continue;
    out.push(img);
  }
  return out;
}

export const ALL_TEXT_KINDS: ReadonlySet<ItemInfo['kind']> = new Set(['post', 'comment', 'article']);
