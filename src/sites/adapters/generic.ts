import { extractText, words } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { hashString } from '../../shared/hash';
import { SELECTORS } from '../selectors';
import { ALL_TEXT_KINDS, largeImages, type SiteAdapter } from './types';

const S = SELECTORS.generic;
const IMG_MARK = 'data-cleanfeed-img';

/** Minimum rendered size for standalone images on generic pages. */
export const GENERIC_IMAGE_MIN = 300;

function hasCandidateDescendant(el: Element): boolean {
  for (const c of el.querySelectorAll(S.item)) {
    if (words(c.textContent ?? '').length >= S.minWords) return true;
  }
  return false;
}

export const genericAdapter: SiteAdapter = {
  id: 'generic',
  matches: () => true,
  itemSelector: S.item,
  stripsMetadata: false,
  textKinds: ALL_TEXT_KINDS,

  fingerprint(el) {
    if (el.hasAttribute(IMG_MARK)) return (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    return hashString((el.textContent ?? '').slice(0, 400));
  },

  extract(el): ItemInfo | null {
    if (el.hasAttribute(IMG_MARK)) {
      const img = el as HTMLImageElement;
      const src = img.currentSrc || img.src;
      if (!src) return null;
      return { key: `img:${src}`, site: 'generic', kind: 'image', text: img.alt ?? '', labels: [], images: [img] };
    }
    if (el.closest(S.exclude)) return null;
    // Analyze the innermost article-like block that carries the text.
    if (hasCandidateDescendant(el)) return null;
    const text = extractText(el, 12000);
    if (words(text).length < S.minWords) return null;
    return {
      key: `web:${location.host}${location.pathname}#${hashString(text.slice(0, 500))}`,
      site: 'generic',
      kind: 'article',
      text,
      labels: [],
      images: largeImages(el, 'img', GENERIC_IMAGE_MIN),
      url: location.href,
    };
  },

  /** Large standalone images outside article blocks. */
  findExtra(root) {
    const out: Element[] = [];
    const imgs = (root as ParentNode).querySelectorAll?.('img') ?? [];
    let n = 0;
    for (const img of imgs as NodeListOf<HTMLImageElement>) {
      if (++n > 400) break;
      if (img.closest(S.item) || img.closest(S.exclude)) continue;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < GENERIC_IMAGE_MIN || h < GENERIC_IMAGE_MIN) continue;
      img.setAttribute(IMG_MARK, '');
      out.push(img);
    }
    return out;
  },

  target(el) {
    if (el.hasAttribute(IMG_MARK)) return el.closest('figure, picture') ?? el;
    return el;
  },
};
