import { abpPatternToRegExp } from '../adblock/network';
import type { PopupFilter } from '../adblock/types';
import { api } from '../shared/api';
import { hostMatchesAny, hostMatchesDomain, hostnameAncestors, hostnameFromUrl, isSameSite, isWebUrl } from '../shared/domain';
import { createLogger } from '../shared/log';
import { popupData } from './cosmetic-index';
import { addCounts } from './stats';
import { ready, siteState } from './state';

/**
 * Popup / popunder blocking. DNR cannot tell a popup navigation from a
 * normal one, so we watch tabs created by another tab
 * (webNavigation.onCreatedNavigationTarget) and close them when their URL
 * matches `$popup` filters — or, in strict mode, any blocked ad host opened
 * cross-site. New tabs are re-checked for a few seconds because popunders
 * usually start at about:blank and redirect.
 */
const log = createLogger('popup');
const regexCache = new Map<string, RegExp | null>();
const watching = new Map<number, { openerHost: string; until: number }>();
let hostSet: Set<string> | null = null;

function filterRegex(f: PopupFilter): RegExp | null {
  const key = (f.regex ? 'r:' : 'p:') + f.pattern;
  if (!regexCache.has(key)) {
    let re: RegExp | null = null;
    try {
      re = f.regex ? new RegExp(f.pattern, 'i') : abpPatternToRegExp(f.pattern);
    } catch {
      re = null;
    }
    regexCache.set(key, re);
  }
  return regexCache.get(key) ?? null;
}

function matches(f: PopupFilter, url: string, targetHost: string, openerHost: string): boolean {
  if (f.domains && !hostMatchesAny(openerHost, f.domains)) return false;
  if (f.notDomains && hostMatchesAny(openerHost, f.notDomains)) return false;
  if (f.thirdParty !== undefined && f.thirdParty === isSameSite(targetHost, openerHost)) return false;
  if (f.host) return hostMatchesDomain(targetHost, f.host);
  if (!f.pattern) return true;
  return filterRegex(f)?.test(url) ?? false;
}

export async function shouldBlockPopup(url: string, openerHost: string): Promise<string | null> {
  const s = await ready();
  const mode = s.settings.ads.level === 'aggressive' && s.settings.ads.popupBlocking !== 'off' ? 'strict' : s.settings.ads.popupBlocking;
  if (mode === 'off' || !isWebUrl(url)) return null;
  const targetHost = hostnameFromUrl(url);
  if (!targetHost || !openerHost) return null;
  const st = siteState(s, openerHost);
  if (!st.ads) return null;
  const data = await popupData();
  if (data.allow.some((f) => matches(f, url, targetHost, openerHost))) return null;
  const hit = data.block.find((f) => matches(f, url, targetHost, openerHost));
  if (hit) return hit.host ?? hit.pattern;
  if (mode === 'strict' && !isSameSite(targetHost, openerHost)) {
    if (!hostSet) hostSet = new Set(data.hosts);
    for (const h of hostnameAncestors(targetHost)) if (hostSet.has(h)) return h;
  }
  return null;
}

export function invalidatePopupCache(): void {
  hostSet = null;
  regexCache.clear();
}

async function openerHostFor(tabId: number, frameId: number): Promise<string> {
  try {
    const frame = await api.webNavigation.getFrame({ tabId, frameId });
    if (frame?.url && isWebUrl(frame.url)) return hostnameFromUrl(frame.url);
  } catch {
    /* fall through */
  }
  try {
    return hostnameFromUrl((await api.tabs.get(tabId)).url);
  } catch {
    return '';
  }
}

async function closePopup(tabId: number, sourceTabId: number, reason: string): Promise<void> {
  watching.delete(tabId);
  try {
    await api.tabs.remove(tabId);
    log.info('blocked popup', reason);
    await addCounts(sourceTabId, { popups: 1 });
  } catch {
    /* already closed */
  }
}

export function registerPopupBlocker(): void {
  api.webNavigation.onCreatedNavigationTarget.addListener((d) => {
    void (async () => {
      const openerHost = await openerHostFor(d.sourceTabId, d.sourceFrameId);
      if (!openerHost) return;
      const reason = await shouldBlockPopup(d.url, openerHost);
      if (reason) {
        await closePopup(d.tabId, d.sourceTabId, reason);
        return;
      }
      watching.set(d.tabId, { openerHost, until: Date.now() + 5000 });
      // Remember the opener so redirect chains can be attributed.
      sourceOf.set(d.tabId, d.sourceTabId);
    })();
  });

  api.tabs.onUpdated.addListener((tabId, info) => {
    const w = watching.get(tabId);
    if (!w || !info.url) return;
    if (Date.now() > w.until) {
      watching.delete(tabId);
      return;
    }
    void shouldBlockPopup(info.url, w.openerHost).then((reason) => {
      if (reason) void closePopup(tabId, sourceOf.get(tabId) ?? tabId, reason);
    });
  });

  api.tabs.onRemoved.addListener((tabId) => {
    watching.delete(tabId);
    sourceOf.delete(tabId);
  });
}

const sourceOf = new Map<number, number>();
