/**
 * Background entry point (Chrome: service worker, Firefox: event page).
 *
 * MV3 rule: all event listeners must be registered synchronously during the
 * first turn of script evaluation, otherwise events that woke the worker are
 * lost. Heavy initialization is therefore lazy (`ready()`, index loads) and
 * every handler awaits what it needs.
 */
import { USER_LIST_ID } from '../adblock/registry';
import { api } from '../shared/api';
import { hostnameFromUrl, isWebUrl } from '../shared/domain';
import { createLogger, errorMessage } from '../shared/log';
import { listen, sendToTab } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { getOne, setLocal } from '../shared/storage';
import { idbClear } from '../shared/idb';
import { handleCss, handleGeneric, handleInit } from './cosmetic-service';
import { rebuildCosmeticIndex } from './cosmetic-index';
import { applyMutation } from './data';
import { dnrStatus, setBadgeCounting, syncDnr, syncSessionRules, syncSystemRules } from './dnr';
import { addCustomList, compileUserFilters, getStoredList, importBundledLists, isDue, removeList, updateList } from './lists';
import { invalidatePopupCache, registerPopupBlocker } from './popups';
import { forgetTabScriptlets, injectScriptlets } from './scriptlets';
import { addCounts, forgetTab, getCounts, pollMatchedRules, resetStats, resetTab } from './stats';
import { mergeSubscriptions, onStateChange, ready, siteState } from './state';
import { registerAiServices } from './ai-services';
import { registerContextMenus } from './context-menu';
import { ALARM_PAUSES, expirePauses, pauseSite } from './pause';

const log = createLogger('bg');

const ALARM_UPDATE = 'cf:lists-update';
const ALARM_STATS = 'cf:stats-poll';

let updating = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function initialize(reason: string): Promise<void> {
  const s = await ready();
  if (!(await getOne('settings'))) await setLocal({ settings: s.settings });
  const stored = await getOne('subscriptions');
  if (!stored) await setLocal({ subscriptions: mergeSubscriptions(undefined) });
  await importBundledLists();
  const userText = (await getOne('userFilters')) ?? '';
  if (!(await getStoredList(USER_LIST_ID))) await compileUserFilters(userText);
  await rebuildCosmeticIndex();
  await syncDnr(reason);
  await setBadgeCounting(s.settings.ads.badge);
  await ensureAlarms();
  // Fetch fresh lists shortly after install; bundled snapshots may be days old or absent.
  setTimeout(() => void updateDueLists(false), reason === 'install' ? 2000 : 30_000);
}

async function ensureAlarms(): Promise<void> {
  const s = await ready();
  const existing = new Set((await api.alarms.getAll()).map((a) => a.name));
  if (!existing.has(ALARM_UPDATE)) api.alarms.create(ALARM_UPDATE, { periodInMinutes: 60, delayInMinutes: 5 });
  if (s.settings.privacy.stats && !existing.has(ALARM_STATS)) api.alarms.create(ALARM_STATS, { periodInMinutes: 4 });
  if (!s.settings.privacy.stats && existing.has(ALARM_STATS)) await api.alarms.clear(ALARM_STATS);
}

/** Updates every subscription that is due (or all of them when forced), then re-syncs once. */
async function updateDueLists(force: boolean, ids?: string[]): Promise<{ updated: string[]; errors: Record<string, string> }> {
  const s = await ready();
  const updated: string[] = [];
  const errors: Record<string, string> = {};
  if (!force && !s.settings.ads.autoUpdate) return { updated, errors };
  if (updating) return { updated, errors: { _: 'An update is already running' } };
  updating = true;
  try {
    const subs = s.subscriptions.filter((x) => x.url && x.enabled && (!ids || ids.includes(x.id)));
    for (const sub of subs) {
      if (!force && !isDue(sub, s.settings.ads.updateIntervalHours)) continue;
      const r = await updateList(sub, force);
      if (r.error) errors[sub.id] = r.error;
      if (r.changed) updated.push(sub.id);
    }
    if (updated.length) {
      await rebuildCosmeticIndex();
      invalidatePopupCache();
      await syncDnr('lists updated');
    }
  } finally {
    updating = false;
  }
  return { updated, errors };
}

api.runtime.onInstalled.addListener((details) => {
  void initialize(details.reason).catch((e) => log.error('init failed', e));
  registerContextMenus(true);
});

api.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureAlarms();
    await syncSessionRules();
  })().catch((e) => log.error('startup failed', e));
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_UPDATE) void updateDueLists(false);
  else if (alarm.name === ALARM_STATS) void pollMatchedRules();
  else if (alarm.name === ALARM_PAUSES) void expirePauses();
});

// React to settings changes made by the UI pages.
onStateChange((keys) => {
  if (keys.has('allowlist') || keys.has('siteOverrides') || keys.has('settings')) {
    void syncSystemRules().catch((e) => log.warn('system rules', e));
  }
  if (keys.has('settings')) {
    void ready().then((s) => setBadgeCounting(s.settings.ads.badge));
    void ensureAlarms();
  }
  if (keys.has('tempAllow')) void syncSessionRules();
});

// ---------------------------------------------------------------------------
// Navigation hooks: scriptlets, stats reset
// ---------------------------------------------------------------------------

api.webNavigation.onCommitted.addListener((d) => {
  if (!isWebUrl(d.url)) return;
  if (d.frameId === 0) {
    void resetTab(d.tabId);
    forgetTabScriptlets(d.tabId);
  }
  void injectScriptlets(d.tabId, d.frameId, d.url, (d as { documentId?: string }).documentId);
});

api.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId);
  forgetTabScriptlets(tabId);
});

registerPopupBlocker();
registerAiServices();
registerContextMenus(false);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

listen('background', {
  'cs:init': (req, sender) => handleInit(req, sender),
  'cs:generic': (req, sender) => handleGeneric(req, sender),
  'cs:css': (req, sender) => handleCss(req, sender),
  'cs:count': async (req, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    await addCounts(tabId, { elements: req.elements ?? 0, ai: req.ai ?? 0 });
  },
  'cs:openOptions': async (req) => {
    const url = api.runtime.getURL('options/options.html') + (req.section ? `#${req.section}` : '');
    await api.tabs.create({ url });
  },
  'cs:pickerCreate': async (req) => {
    const text = req.filter.trim();
    if (!text) return { ok: false, error: 'empty filter' };
    const cur = (await getOne('userFilters')) ?? '';
    const next = cur.trim() ? `${cur.trimEnd()}\n${text}` : text;
    await setLocal({ userFilters: next });
    const rec = await compileUserFilters(next);
    await rebuildCosmeticIndex();
    await syncDnr('picker');
    const issue = rec.issues?.find((i) => i.text === text);
    return issue ? { ok: false, error: issue.message } : { ok: true };
  },
  'data:mutate': (req) => applyMutation(req),

  'ui:popupState': async ({ tabId }) => {
    const s = await ready();
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      return null;
    }
    await pollMatchedRules();
    const url = tab.url ?? '';
    const host = hostnameFromUrl(url);
    const st = host ? siteState(s, host) : null;
    const counts = await getCounts(tabId);
    const enabledSubs = s.subscriptions.filter((x) => x.enabled);
    const pauseUntil = host ? Object.entries(s.tempAllow).find(([h, t]) => t > Date.now() && (host === h || host.endsWith('.' + h)))?.[1] ?? null : null;
    return {
      url,
      hostname: host,
      isWeb: isWebUrl(url),
      enabled: s.settings.enabled,
      adsEnabled: s.settings.ads.enabled,
      aiEnabled: s.settings.ai.enabled,
      site: {
        allowlisted: st?.allowlisted ?? false,
        pausedUntil: pauseUntil,
        override: host ? s.siteOverrides[host] ?? null : null,
        aiMode: st?.aiMode ?? s.settings.ai.mode,
        adsActive: st?.ads ?? false,
        aiActive: st?.ai ?? false,
      },
      counts,
      lists: {
        enabled: enabledSubs.length,
        rules: enabledSubs.reduce((n, x) => n + (x.stats?.dnrRules ?? 0), 0),
        lastUpdated: Math.max(0, ...enabledSubs.map((x) => x.lastUpdated ?? 0)) || null,
        updating,
      },
      statsEnabled: s.settings.privacy.stats,
    };
  },
  'ui:pauseSite': ({ hostname, minutes }) => pauseSite(hostname, minutes),
  'ui:revealPage': async ({ tabId }) => {
    await sendToTab(tabId, 'tab:reveal', {});
  },
  'ui:startPicker': async ({ tabId }) => {
    try {
      await api.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
  'ui:listsUpdate': ({ ids, force }) => updateDueLists(force ?? true, ids),
  'ui:listSet': async ({ id, enabled }) => {
    const s = await ready();
    const subs = s.subscriptions.map((x) => (x.id === id ? { ...x, enabled } : x));
    s.subscriptions = subs;
    await setLocal({ subscriptions: subs });
    const sub = subs.find((x) => x.id === id);
    // Lists without a bundled snapshot need a download before they do anything.
    if (enabled && sub?.url && !(await getStoredList(id))) await updateList(sub, true);
    await rebuildCosmeticIndex();
    invalidatePopupCache();
    await syncDnr('list toggled');
    return { ok: true };
  },
  'ui:listAdd': async ({ url, name }) => {
    try {
      const sub = await addCustomList(url, name);
      const r = await updateList(sub, true);
      await rebuildCosmeticIndex();
      invalidatePopupCache();
      await syncDnr('list added');
      return r.error ? { ok: false, error: r.error, id: sub.id } : { ok: true, id: sub.id };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
  'ui:listRemove': async ({ id }) => {
    await removeList(id);
    await rebuildCosmeticIndex();
    invalidatePopupCache();
    await syncDnr('list removed');
  },
  'ui:userFiltersSave': async ({ text }) => {
    await setLocal({ userFilters: text });
    const rec = await compileUserFilters(text);
    await rebuildCosmeticIndex();
    invalidatePopupCache();
    await syncDnr('user filters');
    return {
      ok: !(rec.issues?.length),
      errors: rec.issues ?? [],
      network: rec.stats.networkFilters,
      cosmetic: rec.stats.cosmeticFilters + rec.stats.scriptletFilters,
      dnrRules: rec.stats.dnrRules,
    };
  },
  'ui:dnrStatus': () => dnrStatus(),
  'ui:resetStats': () => resetStats(),
  'ui:resetAll': async () => {
    await api.storage.local.clear();
    await api.storage.session?.clear();
    for (const store of ['lists', 'cosSpec', 'cosGen', 'meta', 'images', 'imageHash'] as const) await idbClear(store);
    await setLocal({ settings: structuredClone(DEFAULT_SETTINGS) });
    await initialize('reset');
  },
});

