import { isAllowRuleId } from '../adblock/constants';
import { api } from '../shared/api';
import { IS_FIREFOX } from '../shared/env';
import { getOne, getSession, setLocal, setSession } from '../shared/storage';
import type { Counts, StatsRecord } from '../shared/types';
import { dayKey } from '../shared/util';
import { ready } from './state';

/**
 * Quiet, local-only statistics: per tab (current page), this browser session
 * and today. Nothing here ever leaves the device.
 *
 * Network block counts come from declarativeNetRequest.getMatchedRules(),
 * polled on demand (popup open) and on a slow alarm; the API retains matches
 * for at least five minutes, so a ~4 minute poll loses nothing.
 */
const zero = (): Counts => ({ requests: 0, elements: 0, ai: 0, popups: 0 });

interface TabStats extends Counts {
  since: number;
}

const tabs = new Map<number, TabStats>();
let session: Counts | null = null;
let record: StatsRecord | null = null;
let lastPoll = 0;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let loaded: Promise<void> | null = null;

type MatchedInfo = { rule: { ruleId: number; rulesetId: string }; tabId: number; timeStamp: number };
const dnrFeedback = api.declarativeNetRequest as unknown as {
  getMatchedRules?(f?: { tabId?: number; minTimeStamp?: number }): Promise<{ rulesMatchedInfo: MatchedInfo[] }>;
};

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const [stored, sess] = await Promise.all([
        getOne('stats'),
        getSession(['sessionCounts', 'lastMatchPoll']),
      ]);
      record = stored ?? { day: dayKey(), today: zero(), total: zero() };
      session = sess.sessionCounts ?? zero();
      lastPoll = sess.lastMatchPoll ?? Date.now();
      const tabData = (await api.storage.session?.get('tabStats'))?.tabStats as Record<string, TabStats> | undefined;
      if (tabData) for (const [k, v] of Object.entries(tabData)) tabs.set(Number(k), v);
    })();
  }
  return loaded;
}

function rollDay(): void {
  const today = dayKey();
  if (record && record.day !== today) {
    record.day = today;
    record.today = zero();
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 2000);
}

async function flush(): Promise<void> {
  if (!dirty || !record || !session) return;
  dirty = false;
  const tabStats: Record<string, TabStats> = {};
  for (const [k, v] of tabs) tabStats[k] = v;
  await Promise.all([
    setLocal({ stats: record }),
    setSession({ sessionCounts: session, lastMatchPoll: lastPoll }),
    api.storage.session?.set({ tabStats }),
  ]);
}

async function enabled(): Promise<boolean> {
  return (await ready()).settings.privacy.stats;
}

/** Adds counts to a tab, the session and today's totals. */
export async function addCounts(tabId: number, delta: Partial<Counts>): Promise<void> {
  await load();
  rollDay();
  const t = tabs.get(tabId) ?? { ...zero(), since: Date.now() };
  for (const k of ['requests', 'elements', 'ai', 'popups'] as const) {
    const n = delta[k] ?? 0;
    if (!n) continue;
    t[k] += n;
    if (await enabled()) {
      session![k] += n;
      record!.today[k] += n;
      record!.total[k] += n;
    }
  }
  tabs.set(tabId, t);
  scheduleFlush();
  if (IS_FIREFOX) void refreshBadge(tabId);
}

/** Resets a tab's counters when its main frame navigates. */
export async function resetTab(tabId: number): Promise<void> {
  await load();
  tabs.set(tabId, { ...zero(), since: Date.now() });
  scheduleFlush();
  if (IS_FIREFOX) void refreshBadge(tabId);
}

export async function forgetTab(tabId: number): Promise<void> {
  await load();
  tabs.delete(tabId);
  scheduleFlush();
}

/** Pulls DNR matches since the last poll and attributes them to tabs. */
export async function pollMatchedRules(): Promise<void> {
  await load();
  if (!dnrFeedback.getMatchedRules) return;
  const since = lastPoll;
  let info: MatchedInfo[] = [];
  try {
    info = (await dnrFeedback.getMatchedRules({ minTimeStamp: since })).rulesMatchedInfo ?? [];
  } catch {
    return; // rate-limited or permission missing; try again later
  }
  let maxTs = since;
  const perTab = new Map<number, number>();
  for (const m of info) {
    if (m.timeStamp <= since) continue;
    maxTs = Math.max(maxTs, m.timeStamp);
    if (isAllowRuleId(m.rule.ruleId)) continue;
    const t = tabs.get(m.tabId);
    if (t && m.timeStamp < t.since) continue;
    perTab.set(m.tabId, (perTab.get(m.tabId) ?? 0) + 1);
  }
  lastPoll = Math.max(maxTs, since);
  for (const [tabId, n] of perTab) await addCounts(tabId, { requests: n });
  scheduleFlush();
}

export async function getCounts(tabId: number): Promise<{ page: Counts; today: Counts; session: Counts }> {
  await load();
  rollDay();
  const t = tabs.get(tabId);
  return {
    page: t ? { requests: t.requests, elements: t.elements, ai: t.ai, popups: t.popups } : zero(),
    today: { ...record!.today },
    session: { ...session! },
  };
}

export async function resetStats(): Promise<void> {
  await load();
  record = { day: dayKey(), today: zero(), total: zero() };
  session = zero();
  tabs.clear();
  dirty = true;
  await flush();
}

/** Firefox fallback when DNR can't drive the badge count itself. */
async function refreshBadge(tabId: number): Promise<void> {
  const s = await ready();
  const t = tabs.get(tabId);
  const n = t ? t.requests + t.elements + t.ai : 0;
  try {
    await api.action.setBadgeText({ tabId, text: s.settings.ads.badge && n > 0 ? (n > 999 ? '999+' : String(n)) : '' });
    await api.action.setBadgeBackgroundColor({ color: '#3b6df6' });
  } catch {
    /* tab gone */
  }
}
