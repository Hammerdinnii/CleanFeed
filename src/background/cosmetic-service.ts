import { api } from '../shared/api';
import { hostnameFromUrl } from '../shared/domain';
import { createLogger, errorMessage } from '../shared/log';
import type { ContentInit, Req } from '../shared/messages';
import { genericSelectorsFor, hideCss, pageCosmetics } from './cosmetic-index';
import { injectScriptlets } from './scriptlets';
import { ready, siteState } from './state';

/**
 * Answers content-script cosmetic requests and injects CSS as *user*
 * stylesheets (`origin: 'USER'`): user-origin `!important` declarations beat
 * any author stylesheet, and the sheets are invisible to the page's
 * `document.styleSheets`, which makes element hiding harder to detect and undo.
 */
const log = createLogger('cosmetic-svc');

function targetFor(sender: chrome.runtime.MessageSender): chrome.scripting.InjectionTarget | null {
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return null;
  const documentId = (sender as { documentId?: string }).documentId;
  if (documentId) return { tabId, documentIds: [documentId] } as chrome.scripting.InjectionTarget;
  return { tabId, frameIds: [sender.frameId ?? 0] };
}

export async function insertCss(sender: chrome.runtime.MessageSender, css: string, remove = false): Promise<boolean> {
  const target = targetFor(sender);
  if (!target || !css) return false;
  try {
    const injection = { target, css, origin: 'USER' } as chrome.scripting.CSSInjection;
    if (remove) await api.scripting.removeCSS(injection);
    else await api.scripting.insertCSS(injection);
    return true;
  } catch (err) {
    log.debug('insertCSS failed:', errorMessage(err));
    return false;
  }
}

function randomAttr(): string {
  return 'cf' + Math.random().toString(36).slice(2, 8);
}

export async function handleInit(req: Req<'cs:init'>, sender: chrome.runtime.MessageSender): Promise<ContentInit | null> {
  const host = hostnameFromUrl(req.url);
  if (!host || !sender.tab) return null;
  const s = await ready();
  const st = siteState(s, host);
  const hideAttr = randomAttr();
  const init: ContentInit = {
    hostname: host,
    state: st,
    cosmetic: { generic: false, procedural: [], hideAttr, css: [] },
    feedAds: st.cosmetic && s.settings.ads.feedAds,
    youtubeVideoAds: st.ads && s.settings.ads.youtubeVideoAds,
  };

  if (st.cosmetic) {
    const page = await pageCosmetics(host);
    let css = hideCss(page.hide);
    if (page.styles.length) css += page.styles.join('\n') + '\n';
    if (page.procedural.length || init.feedAds) css += `[${hideAttr}]{display:none!important}\n`;
    if (css && (await insertCss(sender, css))) init.cosmetic.css.push(css);
    init.cosmetic.generic = page.generic;
    init.cosmetic.procedural = page.procedural;
  }

  if (st.ads && sender.tab.id !== undefined) {
    const documentId = (sender as { documentId?: string }).documentId;
    void injectScriptlets(sender.tab.id, sender.frameId ?? 0, sender.url ?? req.url, documentId);
  }
  return init;
}

export async function handleGeneric(req: Req<'cs:generic'>, sender: chrome.runtime.MessageSender): Promise<{ css: string | null }> {
  const host = hostnameFromUrl(sender.url ?? '') || hostnameFromUrl(sender.tab?.url ?? '');
  if (!host) return { css: null };
  const s = await ready();
  if (!siteState(s, host).cosmetic) return { css: null };
  const page = await pageCosmetics(host);
  const tokens = req.tokens.slice(0, 2000);
  const selectors = await genericSelectorsFor(tokens, page);
  if (!selectors.length) return { css: null };
  const css = hideCss(selectors);
  return { css: (await insertCss(sender, css)) ? css : null };
}

export async function handleCss(req: Req<'cs:css'>, sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (req.css.length > 2_000_000) return false;
  return insertCss(sender, req.css, req.remove);
}
