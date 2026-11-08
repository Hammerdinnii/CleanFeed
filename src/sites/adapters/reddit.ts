import { extractText } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { SELECTORS } from '../selectors';
import { ALL_TEXT_KINDS, attr, largeImages, type SiteAdapter } from './types';

const S = SELECTORS.reddit;

function flairs(el: Element): string[] {
  const out: string[] = [];
  for (const f of el.querySelectorAll(S.flair)) {
    // Skip flairs that belong to nested comments of a post.
    if (f.closest('shreddit-comment') !== el.closest('shreddit-comment')) continue;
    const t = f.textContent?.trim();
    if (t) out.push(t);
  }
  const attrFlair = attr(el, 'post-flair-text') || attr(el, 'data-flair');
  if (attrFlair) out.push(attrFlair);
  return out;
}

export const redditAdapter: SiteAdapter = {
  id: 'reddit',
  matches: (host) => host === 'reddit.com' || host.endsWith('.reddit.com'),
  itemSelector: S.item,
  // i.redd.it serves originals for some uploads; metadata is occasionally intact.
  stripsMetadata: false,
  feedAdSelector: S.ads,
  textKinds: ALL_TEXT_KINDS,

  fingerprint(el) {
    return attr(el, 'id') || attr(el, 'thingid') || attr(el, 'data-fullname') || attr(el, 'permalink');
  },

  extract(el): ItemInfo | null {
    const tag = el.tagName.toLowerCase();
    if (tag === 'shreddit-post' || el.matches('article[data-post-id]')) {
      const post = tag === 'shreddit-post' ? el : el.querySelector('shreddit-post') ?? el;
      const id = attr(post, 'id') || attr(el, 'data-post-id');
      const title = attr(post, 'post-title') || el.querySelector('[slot="title"]')?.textContent?.trim() || '';
      const body = extractText(post.querySelector('[slot="text-body"]'));
      const author = attr(post, 'author');
      const sub = attr(post, 'subreddit-prefixed-name');
      return {
        key: `reddit:${id || title}`,
        site: 'reddit',
        kind: 'post',
        text: [title, body].filter(Boolean).join('\n\n'),
        title,
        author: author && author !== '[deleted]' ? { platform: 'reddit', handle: `u/${author.toLowerCase()}` } : undefined,
        community: sub ? sub.toLowerCase() : undefined,
        labels: flairs(post),
        images: largeImages(post, S.media, 160),
        url: attr(post, 'permalink') ? new URL(attr(post, 'permalink'), location.origin).href : undefined,
      };
    }
    if (tag === 'shreddit-comment') {
      const body = el.querySelector(':scope > [slot="comment"]') ?? el.querySelector('[slot="comment"]');
      const text = extractText(body);
      if (!text) return null;
      const author = attr(el, 'author');
      return {
        key: `reddit:${attr(el, 'thingid') || text.slice(0, 80)}`,
        site: 'reddit',
        kind: 'comment',
        text,
        author: author && author !== '[deleted]' ? { platform: 'reddit', handle: `u/${author.toLowerCase()}` } : undefined,
        labels: [],
        images: [],
      };
    }
    // old.reddit.com
    if (el.classList.contains('thing')) {
      const isComment = el.classList.contains('comment');
      const textEl = isComment ? el.querySelector(':scope > .entry .usertext-body .md') : el.querySelector('.usertext-body .md');
      const title = isComment ? '' : el.querySelector('a.title')?.textContent?.trim() ?? '';
      const text = [title, extractText(textEl)].filter(Boolean).join('\n\n');
      const author = attr(el, 'data-author');
      const sub = attr(el, 'data-subreddit');
      return {
        key: `reddit:${attr(el, 'data-fullname') || text.slice(0, 80)}`,
        site: 'reddit',
        kind: isComment ? 'comment' : 'post',
        text,
        title: title || undefined,
        author: author ? { platform: 'reddit', handle: `u/${author.toLowerCase()}` } : undefined,
        community: sub ? `r/${sub.toLowerCase()}` : undefined,
        labels: flairs(el),
        images: isComment ? [] : largeImages(el, S.media, 160),
      };
    }
    return null;
  },

  isPromoted(el) {
    return el.matches(S.ads) || el.hasAttribute('promoted') || attr(el, 'post-type') === 'promoted';
  },

  analysisUrl(img) {
    const src = img.currentSrc || img.src;
    if (!src || /styles\.redditmedia\.com|\/avatars?\//.test(src)) return null;
    return src;
  },
};
