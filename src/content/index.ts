/**
 * Content script entry (runs at document_start in every frame).
 *
 * Ad blocking (cosmetic filtering, feed ads, YouTube fallback) runs in every
 * frame; AI filtering only in the top frame. Everything is driven by the
 * background's init response, so a disabled or allowlisted site costs one
 * message round-trip and nothing else.
 */
import { isWebUrl } from '../shared/domain';
import { listen, trySend } from '../shared/messages';
import { getLocal } from '../shared/storage';
import { mergeSettings } from '../shared/settings';
import { adapterFor } from '../sites/adapters';
import { SELECTORS } from '../sites/selectors';
import { AiScanner } from './ai/scanner';
import { AI_PAGE_CSS } from './ai/actions';
import { CosmeticEngine } from './cosmetic/engine';
import { domReady } from './dom-watcher';
import { FeedAdHider } from './feed-ads';
import { startYouTubeAdSkipper } from './youtube-ads';

declare global {
  // Isolated-world global; invisible to page scripts.
  var __cleanfeedContent: boolean | undefined;
}

/** URL whose rules apply to this frame (about:blank/srcdoc frames inherit their parent's). */
function effectiveUrl(): string {
  if (isWebUrl(location.href)) return location.href;
  try {
    const anc = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (anc && anc.length) return anc[0]! + '/';
  } catch {
    /* ignore */
  }
  try {
    if (window.parent !== window && isWebUrl(window.parent.location.href)) return window.parent.location.href;
  } catch {
    /* cross-origin parent */
  }
  return document.referrer && isWebUrl(document.referrer) ? document.referrer : '';
}

async function main(): Promise<void> {
  if (globalThis.__cleanfeedContent) return;
  globalThis.__cleanfeedContent = true;

  const url = effectiveUrl();
  if (!url) return;
  const isTop = window === window.top;
  const init = await trySend('cs:init', { url, isTop }, null);
  if (!init) return;
  const parsed = new URL(url);
  const adapter = adapterFor(init.hostname, parsed);

  let cosmetic: CosmeticEngine | null = null;
  let feedAds: FeedAdHider | null = null;
  let scanner: AiScanner | null = null;

  if (init.state.cosmetic) {
    cosmetic = new CosmeticEngine(init);
    cosmetic.start();
  }
  if (isTop && init.feedAds) {
    feedAds = new FeedAdHider(adapter, init.cosmetic.hideAttr);
    feedAds.start();
  }
  if (isTop && init.youtubeVideoAds && adapter.id === 'youtube') startYouTubeAdSkipper();

  listen('content', {
    'tab:reveal': async () => {
      await cosmetic?.reveal();
      feedAds?.reveal();
      scanner?.revealAll();
    },
    'tab:counts': () => ({ elements: cosmetic?.hiddenCount ?? 0, ai: scanner?.flaggedCount ?? 0 }),
  });

  if (!isTop) return;
  const { settings: raw, keywordRules } = await getLocal(['settings', 'keywordRules']);
  const settings = mergeSettings(raw);
  const aiOn = init.state.ai && settings.ai.sites[adapter.id] !== false;
  const keywordAds = init.state.ads && (keywordRules ?? []).some((r) => r.enabled && r.target !== 'ai');
  if (!aiOn && !keywordAds) return;

  let css = AI_PAGE_CSS;
  if (adapter.id === 'google' && settings.ai.hideGoogleAiMode) css += `${SELECTORS.google.aiModeTab}{display:none!important}\n`;
  void trySend('cs:css', { css }, false);

  await domReady();
  const overrideMode = init.state.aiMode !== settings.ai.mode ? init.state.aiMode : undefined;
  scanner = new AiScanner(adapter, init.hostname, overrideMode, !aiOn);
  await scanner.start();
}

void main().catch((err) => console.warn('[CleanFeed] content init failed', err));
