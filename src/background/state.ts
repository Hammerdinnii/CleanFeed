import { api } from '../shared/api';
import { hostMatchesDomain, normalizeHostname } from '../shared/domain';
import { effectiveSiteState, findOverride, mergeSettings } from '../shared/settings';
import { getLocal, getSession, setSession } from '../shared/storage';
import type { Settings, SiteOverride, Subscription } from '../shared/types';
import { DEFAULT_SUBSCRIPTIONS } from '../adblock/registry';

/**
 * In-memory cache of the small, hot pieces of state the background needs on
 * nearly every event. The service worker can be torn down at any time, so the
 * cache is rebuilt lazily (`ready()`) and kept fresh via storage.onChanged.
 */
export interface BgState {
  settings: Settings;
  allowlist: string[];
  siteOverrides: Record<string, SiteOverride>;
  subscriptions: Subscription[];
  tempAllow: Record<string, number>;
}

let state: BgState | null = null;
let loading: Promise<BgState> | null = null;
type Listener = (keys: Set<string>) => void;
const listeners: Listener[] = [];

export function onStateChange(cb: Listener): void {
  listeners.push(cb);
}

export function ready(): Promise<BgState> {
  if (state) return Promise.resolve(state);
  if (!loading) {
    loading = (async () => {
      const [local, session] = await Promise.all([
        getLocal(['settings', 'allowlist', 'siteOverrides', 'subscriptions']),
        getSession(['tempAllow']),
      ]);
      state = {
        settings: mergeSettings(local.settings),
        allowlist: local.allowlist ?? [],
        siteOverrides: local.siteOverrides ?? {},
        subscriptions: mergeSubscriptions(local.subscriptions),
        tempAllow: session.tempAllow ?? {},
      };
      return state;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/** Adds newly introduced default lists to the stored subscription set (after upgrades). */
export function mergeSubscriptions(stored: Subscription[] | undefined): Subscription[] {
  if (!stored || !stored.length) return structuredClone(DEFAULT_SUBSCRIPTIONS);
  const byId = new Map(stored.map((s) => [s.id, s]));
  const out: Subscription[] = [];
  for (const def of DEFAULT_SUBSCRIPTIONS) {
    const cur = byId.get(def.id);
    // Keep user state (enabled, timestamps) but refresh metadata such as URLs/mirrors.
    out.push(cur ? { ...def, ...pickUserState(cur) } : structuredClone(def));
    byId.delete(def.id);
  }
  for (const s of byId.values()) if (!s.builtin) out.push(s);
  return out;
}

function pickUserState(s: Subscription): Partial<Subscription> {
  const { enabled, lastUpdated, lastChecked, lastError, expiresHours, version, stats } = s;
  return { enabled, lastUpdated, lastChecked, lastError, expiresHours, version, stats };
}

api.storage.onChanged.addListener((changes, area) => {
  if (!state) return;
  const keys = new Set(Object.keys(changes));
  if (area === 'local') {
    if (changes.settings) state.settings = mergeSettings(changes.settings.newValue);
    if (changes.allowlist) state.allowlist = (changes.allowlist.newValue as string[]) ?? [];
    if (changes.siteOverrides) state.siteOverrides = (changes.siteOverrides.newValue as Record<string, SiteOverride>) ?? {};
    if (changes.subscriptions) state.subscriptions = mergeSubscriptions(changes.subscriptions.newValue as Subscription[]);
  } else if (area === 'session') {
    if (changes.tempAllow) state.tempAllow = (changes.tempAllow.newValue as Record<string, number>) ?? {};
  } else return;
  for (const l of listeners) {
    try {
      l(keys);
    } catch {
      /* listener errors must not break others */
    }
  }
});

/** True when `host` (or a parent domain) is on the user's allowlist. */
export function isAllowlisted(s: BgState, host: string): boolean {
  host = normalizeHostname(host);
  if (s.allowlist.some((d) => hostMatchesDomain(host, d))) return true;
  return findOverride(host, s.siteOverrides)?.ads === false;
}

/** Returns the pause expiry for `host` if a temporary exception is active. */
export function pausedUntil(s: BgState, host: string): number | null {
  const now = Date.now();
  let best: number | null = null;
  for (const [d, until] of Object.entries(s.tempAllow)) {
    if (until > now && hostMatchesDomain(host, d)) best = Math.max(best ?? 0, until);
  }
  return best;
}

export function siteState(s: BgState, host: string) {
  const allowlisted = isAllowlisted(s, host);
  const paused = pausedUntil(s, host) !== null;
  const eff = effectiveSiteState(s.settings, host, s.siteOverrides, allowlisted || paused);
  return { ...eff, allowlisted, paused };
}

/** Hostnames whose network blocking must be disabled (allowlist + overrides with ads:false). */
export function allowlistedHosts(s: BgState): string[] {
  const set = new Set(s.allowlist);
  for (const [h, o] of Object.entries(s.siteOverrides)) if (o.ads === false) set.add(h);
  return [...set].sort();
}

export async function setTempAllow(map: Record<string, number>): Promise<void> {
  await setSession({ tempAllow: map });
  if (state) state.tempAllow = map;
}
