import { materializeRules, isUnsafeRule, stableStringify } from '../adblock/compiler';
import { DNR_RESOURCE_TYPES, DYNAMIC_BASE, ID_BLOCK, PRIORITY, RULESET_PREFIX } from '../adblock/constants';
import { USER_LIST_ID } from '../adblock/registry';
import type { DnrRule, DnrRuleBody } from '../adblock/types';
import { api, dnrLimits } from '../shared/api';
import { createLogger, errorMessage } from '../shared/log';
import type { ListStats } from '../shared/types';
import { chunk, createMutex } from '../shared/util';
import { getStoredLists, patchSubscription, type StoredList } from './lists';
import { allowlistedHosts, ready, type BgState } from './state';

/**
 * declarativeNetRequest manager.
 *
 * Owns three rule sources:
 *  - static rulesets  (bundled lists; enabled/disabled per subscription, with
 *                      individual rules disabled to apply upstream removals)
 *  - dynamic rules    (system allowlist & kill switch, user filters, list deltas
 *                      and lists without a bundled ruleset)
 *  - session rules    (temporary "pause on this site" exceptions)
 *
 * Every sync computes the full desired state and applies a minimal diff, so
 * it is idempotent and safe to call after any change. Calls are serialized.
 */
const log = createLogger('dnr');
const mutex = createMutex();
const dnr = api.declarativeNetRequest as unknown as {
  getEnabledRulesets(): Promise<string[]>;
  updateEnabledRulesets(o: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }): Promise<void>;
  getDynamicRules(): Promise<DnrRule[]>;
  updateDynamicRules(o: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  getSessionRules(): Promise<DnrRule[]>;
  updateSessionRules(o: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  updateStaticRules?(o: { rulesetId: string; disableRuleIds?: number[]; enableRuleIds?: number[] }): Promise<void>;
  getDisabledRuleIds?(o: { rulesetId: string }): Promise<number[]>;
  getAvailableStaticRuleCount?(): Promise<number>;
  isRegexSupported?(o: { regex: string; isCaseSensitive?: boolean; requireCapturing?: boolean }): Promise<{ isSupported: boolean; reason?: string }>;
  setExtensionActionOptions?(o: { displayActionCountAsBadgeText?: boolean; tabUpdate?: { tabId: number; increment: number } }): Promise<void>;
};

export interface SyncReport {
  staticEnabled: string[];
  dynamicRules: number;
  truncated: string[];
  invalidRules: number;
  durationMs: number;
}

/** Ruleset IDs declared in the manifest. */
export function manifestRulesets(): Set<string> {
  const m = api.runtime.getManifest() as chrome.runtime.ManifestV3;
  const res = m.declarative_net_request?.rule_resources ?? [];
  return new Set(res.map((r) => r.id));
}

const regexSupport = new Map<string, boolean>();
async function regexOk(rule: DnrRuleBody): Promise<boolean> {
  const re = rule.condition.regexFilter;
  if (!re || !dnr.isRegexSupported) return true;
  const key = `${rule.condition.isUrlFilterCaseSensitive ? 1 : 0}${re}`;
  let ok = regexSupport.get(key);
  if (ok === undefined) {
    try {
      ok = (await dnr.isRegexSupported({ regex: re, isCaseSensitive: !!rule.condition.isUrlFilterCaseSensitive })).isSupported;
    } catch {
      ok = false;
    }
    regexSupport.set(key, ok);
  }
  return ok;
}

/** System rules: global kill switch and the per-site allowlist. IDs 1..999,999. */
function systemRules(s: BgState): DnrRuleBody[] {
  const rules: DnrRuleBody[] = [];
  const off = !s.settings.enabled || !s.settings.ads.enabled;
  if (off) {
    rules.push({
      priority: PRIORITY.siteAllow,
      action: { type: 'allowAllRequests' },
      condition: { resourceTypes: ['main_frame', 'sub_frame'] },
    });
    rules.push({
      priority: PRIORITY.siteAllow,
      action: { type: 'allow' },
      condition: { resourceTypes: DNR_RESOURCE_TYPES.filter((t) => t !== 'main_frame') },
    });
    return rules;
  }
  const hosts = allowlistedHosts(s);
  for (const part of chunk(hosts, 1000)) {
    rules.push({
      priority: PRIORITY.siteAllow,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: part, resourceTypes: ['main_frame', 'sub_frame'] },
    });
    // Requests without a frame (e.g. from the site's service worker).
    rules.push({ priority: PRIORITY.siteAllow, action: { type: 'allow' }, condition: { initiatorDomains: part } });
  }
  return rules;
}

/** Session rules for temporary pauses. */
function pauseRules(s: BgState): DnrRuleBody[] {
  const now = Date.now();
  const hosts = Object.entries(s.tempAllow)
    .filter(([, until]) => until > now)
    .map(([h]) => h)
    .sort();
  if (!hosts.length) return [];
  return [
    {
      priority: PRIORITY.pauseAllow,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: hosts, resourceTypes: ['main_frame', 'sub_frame'] },
    },
    { priority: PRIORITY.pauseAllow, action: { type: 'allow' }, condition: { initiatorDomains: hosts } },
  ];
}

interface Budget {
  total: number;
  unsafe: number;
  regex: number;
}

function take(rules: DnrRuleBody[], budget: Budget): { kept: DnrRuleBody[]; dropped: number } {
  const kept: DnrRuleBody[] = [];
  let dropped = 0;
  for (const r of rules) {
    const unsafe = isUnsafeRule(r);
    const regex = !!r.condition.regexFilter;
    if (budget.total <= 0 || (unsafe && budget.unsafe <= 0) || (regex && budget.regex <= 0)) {
      dropped++;
      continue;
    }
    budget.total--;
    if (unsafe) budget.unsafe--;
    if (regex) budget.regex--;
    kept.push(r);
  }
  return { kept, dropped };
}

async function filterSupported(rules: DnrRuleBody[]): Promise<DnrRuleBody[]> {
  const out: DnrRuleBody[] = [];
  for (const r of rules) if (await regexOk(r)) out.push(r);
  return out;
}

/**
 * Adds rules in chunks; when a chunk is rejected (one invalid rule fails the
 * whole call) it is bisected to isolate and drop the offending rules.
 */
async function addDynamicSafely(rules: DnrRule[]): Promise<number> {
  let invalid = 0;
  const attempt = async (batch: DnrRule[]): Promise<void> => {
    if (!batch.length) return;
    try {
      await dnr.updateDynamicRules({ addRules: batch });
    } catch (err) {
      if (batch.length === 1) {
        invalid++;
        log.warn('dropping invalid rule', JSON.stringify(batch[0]).slice(0, 300), errorMessage(err));
        return;
      }
      if (/maximum|exceed|quota/i.test(errorMessage(err))) {
        log.warn('dynamic rule limit reached:', errorMessage(err));
        invalid += batch.length;
        return;
      }
      const mid = Math.floor(batch.length / 2);
      await attempt(batch.slice(0, mid));
      await attempt(batch.slice(mid));
    }
  };
  for (const part of chunk(rules, 5000)) await attempt(part);
  return invalid;
}

/** Applies the minimal diff between current and desired dynamic rules. */
async function applyDynamic(desired: DnrRule[]): Promise<number> {
  const current = await dnr.getDynamicRules();
  const want = new Map(desired.map((r) => [r.id, stableStringify(r)]));
  const have = new Map(current.map((r) => [r.id, stableStringify(r)]));
  const remove: number[] = [];
  for (const [id, json] of have) if (want.get(id) !== json) remove.push(id);
  const add = desired.filter((r) => have.get(r.id) !== want.get(r.id));
  if (remove.length) {
    for (const part of chunk(remove, 5000)) await dnr.updateDynamicRules({ removeRuleIds: part });
  }
  return add.length ? addDynamicSafely(add) : 0;
}

async function applyStaticRulesets(want: Set<string>, declared: Set<string>): Promise<Set<string>> {
  const enabled = new Set(await dnr.getEnabledRulesets());
  const enable = [...want].filter((id) => !enabled.has(id) && declared.has(id));
  const disable = [...enabled].filter((id) => !want.has(id));
  if (disable.length) await dnr.updateEnabledRulesets({ disableRulesetIds: disable });
  if (enable.length) {
    try {
      await dnr.updateEnabledRulesets({ enableRulesetIds: enable });
    } catch (err) {
      // Likely the global static rule pool is exhausted; enable one at a time.
      log.warn('bulk ruleset enable failed, retrying individually:', errorMessage(err));
      for (const id of enable) {
        try {
          await dnr.updateEnabledRulesets({ enableRulesetIds: [id] });
        } catch (e) {
          log.warn(`could not enable ruleset ${id}:`, errorMessage(e));
        }
      }
    }
  }
  return new Set(await dnr.getEnabledRulesets());
}

async function applyDisabledStaticRules(rulesetId: string, ids: number[]): Promise<boolean> {
  if (!dnr.updateStaticRules || !dnr.getDisabledRuleIds) return false;
  try {
    const cur = new Set(await dnr.getDisabledRuleIds({ rulesetId }));
    const want = new Set(ids);
    const disableRuleIds = ids.filter((id) => !cur.has(id));
    const enableRuleIds = [...cur].filter((id) => !want.has(id));
    if (disableRuleIds.length || enableRuleIds.length) {
      await dnr.updateStaticRules({ rulesetId, disableRuleIds, enableRuleIds });
    }
    return true;
  } catch (err) {
    log.warn(`updateStaticRules(${rulesetId}) failed:`, errorMessage(err));
    return false;
  }
}

/** Full synchronization of static + dynamic rules with the current settings. */
export function syncDnr(reason: string): Promise<SyncReport> {
  return mutex(async () => {
    const t0 = Date.now();
    const s = await ready();
    const limits = dnrLimits();
    const declared = manifestRulesets();
    const subs = s.subscriptions;
    const stored = await getStoredLists();
    const truncated: string[] = [];
    const supportsStaticEdits = !!dnr.updateStaticRules;

    // 1) Decide per list where its network rules live.
    type Plan = { id: string; ruleset: string | null; useStatic: boolean; disabledIds: number[]; dynamic: DnrRuleBody[]; mode: ListStats['mode'] };
    const plans: Plan[] = [];
    for (const sub of subs) {
      if (!sub.enabled) continue;
      const rec = stored.get(sub.id);
      const rulesetId = declared.has(RULESET_PREFIX + sub.id) ? RULESET_PREFIX + sub.id : null;
      const plan: Plan = { id: sub.id, ruleset: rulesetId, useStatic: false, disabledIds: [], dynamic: [], mode: 'none' };
      if (rulesetId && (!rec || rec.dnrMode === 'static')) {
        plan.useStatic = true;
        plan.mode = 'static';
      } else if (rulesetId && rec?.dnrMode === 'delta' && rec.delta) {
        const removals = rec.delta.disabledStaticIds;
        if (removals.length > limits.disabledStatic || (!supportsStaticEdits && removals.length > 500)) {
          // Too far from the shipped snapshot: install the full list dynamically.
          plan.dynamic = rec.rules ?? [];
          plan.mode = 'dynamic';
        } else {
          plan.useStatic = true;
          plan.disabledIds = supportsStaticEdits ? removals : [];
          plan.dynamic = rec.delta.added;
          plan.mode = 'static+delta';
        }
      } else if (rec?.rules) {
        plan.dynamic = rec.rules;
        plan.mode = 'dynamic';
      }
      plans.push(plan);
    }

    // 2) Static rulesets.
    const wantStatic = new Set(plans.filter((p) => p.useStatic && p.ruleset).map((p) => p.ruleset!));
    const enabledStatic = await applyStaticRulesets(wantStatic, declared);
    for (const p of plans) {
      if (!p.ruleset) continue;
      if (p.useStatic && !enabledStatic.has(p.ruleset)) {
        // Ruleset could not be enabled (static pool exhausted): fall back to dynamic.
        const rec = stored.get(p.id);
        p.useStatic = false;
        p.dynamic = rec?.rules ?? [];
        p.mode = p.dynamic.length ? 'dynamic' : 'none';
      }
      if (p.useStatic) await applyDisabledStaticRules(p.ruleset, p.disabledIds);
    }

    // 3) Dynamic rules, allocated in priority order within the browser budget.
    const budget: Budget = { total: limits.dynamic, unsafe: limits.unsafeDynamic, regex: limits.regex };
    const desired: DnrRule[] = [];
    const sys = take(systemRules(s), budget).kept;
    desired.push(...materializeRules(sys, DYNAMIC_BASE.system));

    // Note: when blocking is globally off, the system kill-switch rule (highest
    // priority) neutralizes everything below, so list/user rules stay installed
    // and toggling back on is instant.
    {
      const user = stored.get(USER_LIST_ID);
      if (user?.rules?.length) {
        const { kept, dropped } = take(await filterSupported(user.rules), budget);
        if (dropped) truncated.push(USER_LIST_ID);
        desired.push(...materializeRules(kept, DYNAMIC_BASE.user));
      }
      let slot = 0;
      for (const p of plans) {
        if (!p.dynamic.length) continue;
        const { kept, dropped } = take(await filterSupported(p.dynamic), budget);
        if (dropped) {
          truncated.push(p.id);
          if (p.mode === 'dynamic') p.mode = 'truncated';
        }
        desired.push(...materializeRules(kept, DYNAMIC_BASE.lists + slot * ID_BLOCK));
        slot++;
      }
    }
    const invalid = await applyDynamic(desired);
    await syncSessionRulesInner(s);

    // 4) Record where each list's rules ended up (shown in the options page).
    for (const p of plans) {
      const sub = subs.find((x) => x.id === p.id);
      if (sub && sub.stats?.mode !== p.mode) {
        await patchSubscription(p.id, { stats: { ...(sub.stats ?? emptyStats(stored.get(p.id))), mode: p.mode } });
      }
    }

    const report: SyncReport = {
      staticEnabled: [...enabledStatic],
      dynamicRules: desired.length,
      truncated,
      invalidRules: invalid,
      durationMs: Date.now() - t0,
    };
    log.info(`sync (${reason}):`, report);
    return report;
  });
}

function emptyStats(rec: StoredList | undefined): ListStats {
  return {
    networkFilters: rec?.stats.networkFilters ?? 0,
    cosmeticFilters: rec?.stats.cosmeticFilters ?? 0,
    scriptletFilters: rec?.stats.scriptletFilters ?? 0,
    dnrRules: rec?.stats.dnrRules ?? 0,
    unsupported: rec?.stats.unsupported ?? 0,
  };
}

/** Rewrites only the system (allowlist) range of dynamic rules — fast path for site toggles. */
export function syncSystemRules(): Promise<void> {
  return mutex(async () => {
    const s = await ready();
    const desired = materializeRules(systemRules(s), DYNAMIC_BASE.system);
    const current = (await dnr.getDynamicRules()).filter((r) => r.id < DYNAMIC_BASE.user);
    const remove = current.map((r) => r.id);
    await dnr.updateDynamicRules({ removeRuleIds: remove, addRules: desired });
  });
}

async function syncSessionRulesInner(s: BgState): Promise<void> {
  const desired = materializeRules(pauseRules(s), 0);
  const current = await dnr.getSessionRules();
  await dnr.updateSessionRules({ removeRuleIds: current.map((r) => r.id), addRules: desired });
}

export function syncSessionRules(): Promise<void> {
  return mutex(async () => syncSessionRulesInner(await ready()));
}

export async function dnrStatus() {
  const limits = dnrLimits();
  const declared = [...manifestRulesets()];
  const enabled = new Set(await dnr.getEnabledRulesets());
  const dyn = await dnr.getDynamicRules();
  const session = await dnr.getSessionRules();
  let available: number | null = null;
  try {
    available = dnr.getAvailableStaticRuleCount ? await dnr.getAvailableStaticRuleCount() : null;
  } catch {
    available = null;
  }
  return {
    staticRulesets: declared.map((id) => ({ id, enabled: enabled.has(id) })),
    dynamicRules: dyn.length,
    dynamicLimit: limits.dynamic,
    sessionRules: session.length,
    availableStatic: available,
    regexRules: dyn.filter((r) => r.condition.regexFilter).length,
  };
}

export async function setBadgeCounting(on: boolean): Promise<void> {
  try {
    await dnr.setExtensionActionOptions?.({ displayActionCountAsBadgeText: on });
  } catch {
    /* unsupported (older Firefox) */
  }
}

export async function incrementBadge(tabId: number, increment: number): Promise<void> {
  try {
    await dnr.setExtensionActionOptions?.({ tabUpdate: { tabId, increment } });
  } catch {
    /* unsupported */
  }
}
