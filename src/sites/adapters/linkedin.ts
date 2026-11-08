import { extractText } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { SELECTORS } from '../selectors';
import { ALL_TEXT_KINDS, attr, largeImages, type SiteAdapter } from './types';

const S = SELECTORS.linkedin;
const PROMOTED = new RegExp(`^(?:${S.promotedTexts.map((t) => t.replace(/ /g, '\\s')).join('|')})\\b`, 'i');

function actorHandle(el: Element): string | undefined {
  const a = el.querySelector<HTMLAnchorElement>(S.actorLink);
  const href = a?.getAttribute('href') ?? '';
  const m = /linkedin\.com\/(in|company|school|showcase)\/([^/?#]+)/.exec(href) ?? /^\/(in|company|school|showcase)\/([^/?#]+)/.exec(href);
  return m ? `${m[1]}/${decodeURIComponent(m[2]!).toLowerCase()}` : undefined;
}

export const linkedinAdapter: SiteAdapter = {
  id: 'linkedin',
  matches: (host) => host === 'linkedin.com' || host.endsWith('.linkedin.com'),
  itemSelector: S.item,
  stripsMetadata: false,
  textKinds: ALL_TEXT_KINDS,

  fingerprint(el) {
    return attr(el, 'data-urn') || attr(el, 'data-id') || (el.querySelector(S.text)?.textContent ?? '').slice(0, 80);
  },

  extract(el): ItemInfo | null {
    // Feed updates nest: prefer the innermost activity container.
    if (el.matches('div.feed-shared-update-v2') && el.parentElement?.closest(S.item)) return null;
    const isComment = el.matches('article.comments-comment-entity, .comments-comment-item');
    const textEl = el.querySelector(S.text);
    const text = extractText(textEl);
    const urn = attr(el, 'data-urn') || attr(el, 'data-id') || attr(el.closest('[data-urn]'), 'data-urn');
    if (!text && !urn) return null;
    const labels: string[] = [];
    for (const cc of el.querySelectorAll(S.contentCredentials)) {
      labels.push(cc.getAttribute('aria-label') ?? cc.textContent ?? 'Content Credentials');
    }
    const handle = actorHandle(el);
    return {
      key: `linkedin:${urn || text.slice(0, 120)}`,
      site: 'linkedin',
      kind: isComment ? 'comment' : 'post',
      text,
      author: handle ? { platform: 'linkedin', handle, name: el.querySelector(S.actorName)?.textContent?.trim() } : undefined,
      labels,
      images: isComment ? [] : largeImages(el, S.media, 160),
    };
  },

  isPromoted(el) {
    for (const d of el.querySelectorAll(S.subDescription)) {
      const t = d.textContent?.trim() ?? '';
      if (PROMOTED.test(t)) return true;
    }
    return false;
  },

  analysisUrl(img) {
    const src = img.currentSrc || img.src;
    if (!src || /profile-displayphoto|company-logo|\/static\./.test(src)) return null;
    return src;
  },
};
