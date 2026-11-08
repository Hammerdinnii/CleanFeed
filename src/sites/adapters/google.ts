import { extractText } from '../../ai/text';
import type { ItemInfo } from '../../ai/types';
import { entityKeys, hostnameFromUrl } from '../../shared/domain';
import { SELECTORS } from '../selectors';
import { type SiteAdapter } from './types';

const S = SELECTORS.google;
const AIO_MARK = 'data-cleanfeed-aio';
const HEADINGS = new Set(S.aiOverviewHeadings.map((h) => h.toLowerCase()));

/** Climbs from an element to the top-level block of the results column. */
function topLevelBlock(el: Element): Element | null {
  let cur: Element = el;
  while (cur.parentElement && !cur.parentElement.matches(S.blockStops)) {
    cur = cur.parentElement;
    if (cur === document.body) return null;
  }
  return cur.parentElement ? cur : null;
}

function findAiOverviews(): Element[] {
  const out = new Set<Element>();
  for (const el of document.querySelectorAll(S.aiOverviewContainers)) {
    const b = topLevelBlock(el) ?? el;
    if (/AI|KI|IA|ИИ/.test(b.textContent?.slice(0, 400) ?? '')) out.add(b);
  }
  // Heading-text search covers markup changes and localized UIs.
  const scope = document.querySelector('#rcnt, #center_col, #main') ?? document.body;
  if (!scope) return [...out];
  for (const h of scope.querySelectorAll('h1, h2, h3, [role="heading"], strong, span')) {
    if (h.childElementCount > 2) continue;
    const t = h.textContent?.trim().toLowerCase();
    if (!t || t.length > 40 || !HEADINGS.has(t)) continue;
    const b = topLevelBlock(h);
    if (b) out.add(b);
  }
  return [...out];
}

export const googleAdapter: SiteAdapter = {
  id: 'google',
  matches: (host, url) =>
    entityKeys(host).includes('google.*') && (url.pathname === '/search' || url.pathname === '/webhp' || url.pathname === '/'),
  itemSelector: S.item,
  stripsMetadata: true,
  feedAdSelector: S.ads,
  // Search snippets are too short and too templated for text heuristics.
  textKinds: new Set(),

  fingerprint(el) {
    if (el.hasAttribute(AIO_MARK)) return `aio:${new URLSearchParams(location.search).get('q') ?? ''}`;
    return el.querySelector<HTMLAnchorElement>('a[href^="http"]')?.href ?? '';
  },

  extract(el): ItemInfo | null {
    if (el.hasAttribute(AIO_MARK)) {
      const q = new URLSearchParams(location.search).get('q') ?? '';
      return {
        key: `google:aio/${q}`,
        site: 'google',
        kind: 'overview',
        text: '',
        labels: [],
        images: [],
        definitive: { reason: 'Google AI Overview', detail: 'AI-generated summary' },
      };
    }
    const link = el.querySelector<HTMLAnchorElement>('a[href^="http"]:has(h3)') ?? el.querySelector<HTMLAnchorElement>('a[href^="http"]');
    if (!link) return null;
    const domain = hostnameFromUrl(link.href);
    if (!domain || /(^|\.)google\./.test(domain)) return null;
    const title = el.querySelector('h3')?.textContent?.trim() ?? '';
    return {
      key: `google:result/${link.href}`,
      site: 'google',
      kind: 'result',
      text: extractText(el.querySelector(S.snippet)),
      title,
      labels: [],
      images: [],
      url: link.href,
      linkDomains: [domain],
    };
  },

  findExtra(root) {
    if (root !== document) return [];
    const blocks = findAiOverviews();
    for (const b of blocks) if (!b.hasAttribute(AIO_MARK)) b.setAttribute(AIO_MARK, '');
    return blocks;
  },

  isPromoted(el) {
    if (el.closest('[data-text-ad], #tads, #tadsb, #bottomads')) return true;
    const label = el.querySelector('span');
    return !!label && /^(Sponsored|Ad|Anzeige|Annonce|Patrocinado|Sponsorizzato)$/i.test(label.textContent?.trim() ?? '');
  },
};
