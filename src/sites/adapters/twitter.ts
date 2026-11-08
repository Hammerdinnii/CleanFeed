import { extractText } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { SELECTORS } from '../selectors';
import { ALL_TEXT_KINDS, largeImages, type SiteAdapter } from './types';

const S = SELECTORS.twitter;
const PROMOTED = new Set<string>(S.promotedTexts);

function statusLink(article: Element): HTMLAnchorElement | null {
  // The tweet's own permalink wraps its <time> and comes first in DOM order
  // (a quoted tweet's permalink, if any, follows inside the body).
  for (const a of article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
    if (a.querySelector('time')) return a;
  }
  return null;
}

function parseStatus(href: string): { handle: string; id: string } | null {
  const m = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(href);
  return m ? { handle: m[1]!, id: m[2]! } : null;
}

export const twitterAdapter: SiteAdapter = {
  id: 'twitter',
  matches: (host) => S.hosts.some((h) => host === h || host.endsWith('.' + h)),
  itemSelector: S.item,
  stripsMetadata: true,
  textKinds: ALL_TEXT_KINDS,

  fingerprint(el) {
    return statusLink(el)?.getAttribute('href') ?? (el.querySelector(S.text)?.textContent ?? '').slice(0, 80);
  },

  extract(el): ItemInfo | null {
    const link = statusLink(el);
    const st = link ? parseStatus(link.getAttribute('href') ?? '') : null;
    // The first tweetText belongs to the tweet itself; a quoted tweet's text comes later.
    const text = extractText(el.querySelector(S.text));
    let handle = st?.handle;
    if (!handle) {
      const a = el.querySelector<HTMLAnchorElement>(`${S.userName} a[href^="/"]`);
      handle = a?.getAttribute('href')?.slice(1).split('/')[0];
    }
    if (!st && !text) return null;
    const labels: string[] = [];
    const note = el.querySelector(S.communityNote);
    if (note) labels.push(note.textContent?.trim() ?? '');
    return {
      key: st ? `twitter:status/${st.id}` : `twitter:text/${text.slice(0, 120)}`,
      site: 'twitter',
      kind: 'post',
      text,
      author: handle ? { platform: 'twitter', handle: handle.toLowerCase() } : undefined,
      labels,
      images: largeImages(el, S.media, 100),
      url: link?.href,
    };
  },

  // Hide the whole virtualized cell so no empty separator remains.
  adTarget: (el) => el.closest(S.cell) ?? el,

  isPromoted(el) {
    if (el.querySelector('[data-testid="ad-badge"]')) return true;
    let checked = 0;
    for (const span of el.querySelectorAll('span')) {
      if (++checked > 120) break;
      if (span.childElementCount) continue;
      const t = span.textContent?.trim();
      if (!t || t.length > 20 || !PROMOTED.has(t)) continue;
      if (span.closest(S.text)) continue; // the word "Ad" inside tweet text doesn't count
      return true;
    }
    return false;
  },

  analysisUrl(img) {
    const src = img.currentSrc || img.src;
    try {
      const u = new URL(src);
      if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) {
        u.searchParams.set('name', 'small');
        if (!u.searchParams.has('format')) u.searchParams.set('format', 'jpg');
        return u.href;
      }
      if (u.hostname === 'pbs.twimg.com' && /profile_images|emoji/.test(u.pathname)) return null;
      return src;
    } catch {
      return null;
    }
  },
};
