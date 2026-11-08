import type { DnrResourceType } from './constants';

/**
 * Neutered "redirect" resources shipped in /redirects (web-accessible). Filter
 * lists refer to them by uBO, ABP (`abp-resource:`) or AdGuard names; all map
 * onto the canonical files below. Surrogate scripts are original minimal
 * implementations that keep pages working when the real tracker is blocked.
 */
export interface RedirectResource {
  file: string;
  /** Resource type assumed when the filter does not specify one. */
  type: DnrResourceType[];
}

const R = (file: string, ...type: DnrResourceType[]): RedirectResource => ({ file, type });

const SCRIPT = ['script'] as DnrResourceType[];

export const REDIRECT_RESOURCES: Record<string, RedirectResource> = {
  'noop.js': R('noop.js', ...SCRIPT),
  'noop.txt': R('noop.txt', 'xmlhttprequest', 'other'),
  'noop.html': R('noop.html', 'sub_frame'),
  'noop.css': R('noop.css', 'stylesheet'),
  'noop.json': R('noop.json', 'xmlhttprequest'),
  '1x1.gif': R('1x1.gif', 'image'),
  '2x2.png': R('2x2.png', 'image'),
  'noop-vast2.xml': R('noop-vast2.xml', 'xmlhttprequest'),
  'noop-vast3.xml': R('noop-vast3.xml', 'xmlhttprequest'),
  'noop-vmap1.xml': R('noop-vmap1.xml', 'xmlhttprequest'),
  'google-analytics_analytics.js': R('google-analytics_analytics.js', ...SCRIPT),
  'google-analytics_ga.js': R('google-analytics_ga.js', ...SCRIPT),
  'googletagmanager_gtm.js': R('googletagmanager_gtm.js', ...SCRIPT),
  'googlesyndication_adsbygoogle.js': R('googlesyndication_adsbygoogle.js', ...SCRIPT),
  'doubleclick_instream_ad_status.js': R('doubleclick_instream_ad_status.js', ...SCRIPT),
  'scorecardresearch_beacon.js': R('scorecardresearch_beacon.js', ...SCRIPT),
  'amazon_apstag.js': R('amazon_apstag.js', ...SCRIPT),
  'ampproject_v0.js': R('ampproject_v0.js', ...SCRIPT),
};

/** Alias → canonical resource name. */
const ALIASES: Record<string, string> = {
  // uBO aliases
  'noopjs': 'noop.js',
  'noop.js': 'noop.js',
  'noopframe': 'noop.html',
  'noop.html': 'noop.html',
  'nooptext': 'noop.txt',
  'noop.txt': 'noop.txt',
  'noopcss': 'noop.css',
  'noop.css': 'noop.css',
  'noopjson': 'noop.json',
  'noop.json': 'noop.json',
  'empty': 'noop.txt',
  '1x1.gif': '1x1.gif',
  '1x1-transparent.gif': '1x1.gif',
  '2x2.png': '2x2.png',
  '2x2-transparent.png': '2x2.png',
  '3x2.png': '2x2.png',
  '3x2-transparent.png': '2x2.png',
  '32x32.png': '2x2.png',
  '32x32-transparent.png': '2x2.png',
  'noop-0.1s.mp3': 'noop.txt',
  'noopmp3-0.1s': 'noop.txt',
  'noop-0.5s.mp3': 'noop.txt',
  'noop-1s.mp4': 'noop.txt',
  'noopmp4-1s': 'noop.txt',
  'noop-vast2.xml': 'noop-vast2.xml',
  'noopvast-2.0': 'noop-vast2.xml',
  'noop-vast3.xml': 'noop-vast3.xml',
  'noopvast-3.0': 'noop-vast3.xml',
  'noop-vast4.xml': 'noop-vast3.xml',
  'noopvast-4.0': 'noop-vast3.xml',
  'noop-vmap1.xml': 'noop-vmap1.xml',
  'noopvmap-1.0': 'noop-vmap1.xml',
  'google-analytics_analytics.js': 'google-analytics_analytics.js',
  'google-analytics.com/analytics.js': 'google-analytics_analytics.js',
  'googletagmanager_gtag.js': 'google-analytics_analytics.js',
  'google-analytics': 'google-analytics_analytics.js',
  'google-analytics-ga': 'google-analytics_ga.js',
  'google-analytics_ga.js': 'google-analytics_ga.js',
  'google-analytics.com/ga.js': 'google-analytics_ga.js',
  'googletagmanager_gtm.js': 'googletagmanager_gtm.js',
  'googletagmanager-gtm': 'googletagmanager_gtm.js',
  'googletagmanager.com/gtm.js': 'googletagmanager_gtm.js',
  'googlesyndication_adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
  'googlesyndication-adsbygoogle': 'googlesyndication_adsbygoogle.js',
  'googlesyndication.com/adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
  'doubleclick_instream_ad_status.js': 'doubleclick_instream_ad_status.js',
  'doubleclick.net/instream/ad_status.js': 'doubleclick_instream_ad_status.js',
  'scorecardresearch_beacon.js': 'scorecardresearch_beacon.js',
  'scorecardresearch.com/beacon.js': 'scorecardresearch_beacon.js',
  'scorecardresearch-beacon': 'scorecardresearch_beacon.js',
  'amazon_apstag.js': 'amazon_apstag.js',
  'amazon-apstag': 'amazon_apstag.js',
  'ampproject_v0.js': 'ampproject_v0.js',
  'ampproject.org/v0.js': 'ampproject_v0.js',
  'google-ima.js': 'noop.js',
  'google-ima3': 'noop.js',
  'outbrain-widget.js': 'noop.js',
  'popads.js': 'noop.js',
  'popads-dummy.js': 'noop.js',
  'prebid-ads.js': 'noop.js',
  'nobab.js': 'noop.js',
  'nobab2.js': 'noop.js',
  'nofab.js': 'noop.js',
  'fingerprint2.js': 'noop.js',
  'fingerprint3.js': 'noop.js',
  'hd-main.js': 'noop.js',
  'adthrive_abd.js': 'noop.js',
  'click2load.html': 'noop.html',
  // ABP rewrite names
  'abp-resource:blank-js': 'noop.js',
  'abp-resource:blank-text': 'noop.txt',
  'abp-resource:blank-css': 'noop.css',
  'abp-resource:blank-html': 'noop.html',
  'abp-resource:blank-mp3': 'noop.txt',
  'abp-resource:blank-mp4': 'noop.txt',
  'abp-resource:1x1-transparent-gif': '1x1.gif',
  'abp-resource:2x2-transparent-png': '2x2.png',
  'abp-resource:3x2-transparent-png': '2x2.png',
  'abp-resource:32x32-transparent-png': '2x2.png',
};

/** Resolves a filter's redirect token (optionally with ":priority" suffix) to a resource. */
export function resolveRedirect(token: string): RedirectResource | null {
  const name = token.replace(/:\d+$/, '').trim().toLowerCase();
  const canonical = ALIASES[name];
  if (!canonical) return null;
  return REDIRECT_RESOURCES[canonical] ?? null;
}

/** Path inside the extension package (used by DNR `extensionPath`). */
export function redirectPath(res: RedirectResource): string {
  return `/redirects/${res.file}`;
}
