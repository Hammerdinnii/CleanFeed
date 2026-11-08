import { scriptletRunner } from '../adblock/scriptlets/runner';
import { api } from '../shared/api';
import { hostnameFromUrl } from '../shared/domain';
import { createLogger, errorMessage } from '../shared/log';
import { pageCosmetics } from './cosmetic-index';
import { ready, siteState } from './state';

/**
 * Scriptlet injection into the page's MAIN world.
 *
 * Primary path: webNavigation.onCommitted → executeScript({ injectImmediately }),
 * which usually runs before the page's own scripts. Fallback path: the
 * content script's init message (covers the case where the service worker
 * was asleep and the commit event was delivered late). Injection is deduped
 * per document.
 */
const log = createLogger('scriptlets');
const injected = new Map<string, string>();

export async function injectScriptlets(
  tabId: number,
  frameId: number,
  url: string,
  documentId?: string,
): Promise<void> {
  const host = hostnameFromUrl(url);
  if (!host) return;
  const docKey = documentId ?? url;
  const frameKey = `${tabId}:${frameId}`;
  if (injected.get(frameKey) === docKey) return;

  const s = await ready();
  if (!s.settings.ads.scriptlets) return;
  const st = siteState(s, host);
  if (!st.ads) return;
  const page = await pageCosmetics(host);
  if (!page.scriptlets.length) return;
  injected.set(frameKey, docKey);

  const target = (documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] }) as chrome.scripting.InjectionTarget;
  try {
    await api.scripting.executeScript({
      target,
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      injectImmediately: true,
      func: scriptletRunner,
      args: [page.scriptlets],
    } as chrome.scripting.ScriptInjection<[[string, string[]][]], void>);
  } catch (err) {
    injected.delete(frameKey);
    log.debug(`inject failed on ${host}:`, errorMessage(err));
  }
}

export function forgetTabScriptlets(tabId: number): void {
  for (const k of injected.keys()) if (k.startsWith(`${tabId}:`)) injected.delete(k);
}
