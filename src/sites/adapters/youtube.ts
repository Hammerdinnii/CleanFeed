import { extractText } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { AI_LABEL_PATTERNS } from '../../ai/detectors/platform-labels';
import { SELECTORS } from '../selectors';
import { attr, largeImages, textOf, type SiteAdapter } from './types';

const S = SELECTORS.youtube;
const WATCH_MARK = 'data-cleanfeed-watch';
const DISCLOSURE = /altered or synthetic content|made with ai|ai[- ]generated content/i;

function videoId(href: string): { id: string; short: boolean } | null {
  const m = /[?&]v=([\w-]{6,})/.exec(href) ?? /\/shorts\/([\w-]{6,})/.exec(href);
  return m ? { id: m[1]!, short: href.includes('/shorts/') } : null;
}

function channelHandle(el: Element): string | undefined {
  const a = el.querySelector<HTMLAnchorElement>(S.channel);
  const href = a?.getAttribute('href') ?? '';
  const m = /^\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/.exec(href);
  if (!m) return undefined;
  return decodeURIComponent(m[1]!).replace(/^@/, '').toLowerCase();
}

/** Short label-like strings inside an element (e.g. the Shorts overlay disclosure). */
function shortLabels(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t && n < 400; t = walker.nextNode(), n++) {
    const s = t.nodeValue?.trim();
    if (s && s.length <= 60 && AI_LABEL_PATTERNS.some((re) => re.test(s))) out.push(s);
  }
  return out;
}

function currentWatchId(): string | null {
  if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
  const m = /^\/shorts\/([\w-]+)/.exec(location.pathname);
  return m ? m[1]! : null;
}

export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  matches: (host) => S.hosts.some((h) => host === h) || host.endsWith('.youtube.com'),
  itemSelector: S.item,
  stripsMetadata: true,
  feedAdSelector: S.feedAds,
  textKinds: new Set(['comment']),

  fingerprint(el) {
    if (el.hasAttribute(WATCH_MARK)) return `watch:${currentWatchId()}`;
    const link = el.querySelector<HTMLAnchorElement>(S.videoLink);
    return (link?.getAttribute('href') ?? '') + '|' + textOf(el, S.title).slice(0, 60);
  },

  extract(el): ItemInfo | null {
    // Watch page / Shorts player flagged by its disclosure.
    if (el.hasAttribute(WATCH_MARK)) {
      const id = currentWatchId();
      if (!id) return null;
      return {
        key: `youtube:video/${id}`,
        site: 'youtube',
        kind: 'video',
        text: '',
        labels: [attr(el, WATCH_MARK)],
        images: [],
        url: location.href,
      };
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'ytd-comment-thread-renderer') {
      const body = el.querySelector('#comment #content-text, #content-text');
      const text = extractText(body);
      if (!text) return null;
      const authorHref = attr(el.querySelector('#author-text'), 'href');
      const handle = /^\/@([^/?#]+)/.exec(authorHref)?.[1];
      return {
        key: `youtube:comment/${hashish(text)}`,
        site: 'youtube',
        kind: 'comment',
        text,
        author: handle ? { platform: 'youtube', handle: decodeURIComponent(handle).toLowerCase() } : undefined,
        labels: [],
        images: [],
      };
    }

    const link = el.querySelector<HTMLAnchorElement>(S.videoLink);
    const vid = link ? videoId(link.getAttribute('href') ?? '') : null;
    const title = textOf(el, S.title) || attr(link, 'title');
    if (!vid && !title) return null;
    const handle = channelHandle(el);
    const labels = tag === 'ytd-reel-video-renderer' ? shortLabels(el) : [];
    return {
      key: vid ? `youtube:video/${vid.id}` : `youtube:title/${title}`,
      site: 'youtube',
      kind: vid?.short || tag.includes('shorts') || tag.includes('reel') ? 'short' : 'video',
      text: title,
      title,
      author: handle ? { platform: 'youtube', handle } : undefined,
      labels,
      images: largeImages(el, S.thumbnail, 120),
      url: link?.href,
    };
  },

  findExtra(root) {
    const id = currentWatchId();
    if (!id || root !== document) return [];
    const player = document.querySelector(S.watchPlayer);
    if (!player) return [];
    for (const box of document.querySelectorAll(S.watchDisclosure)) {
      const text = box.textContent ?? '';
      const m = DISCLOSURE.exec(text);
      if (m) {
        player.setAttribute(WATCH_MARK, m[0]);
        return [player];
      }
    }
    player.removeAttribute(WATCH_MARK);
    return [];
  },

  isPromoted(el) {
    return !!el.querySelector(S.feedAds);
  },

  analysisUrl(img) {
    const src = img.currentSrc || img.src;
    const m = /^https:\/\/i\d?\.ytimg\.com\/(vi|vi_webp)\/([\w-]+)\//.exec(src);
    // hqdefault is cached by YouTube's CDN and large enough for 224–384px models.
    if (m) return `https://i.ytimg.com/vi/${m[2]}/hqdefault.jpg`;
    if (/yt3\.ggpht\.com|\/avatar/.test(src)) return null;
    return src || null;
  },
};

function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(s.length, 400); i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
