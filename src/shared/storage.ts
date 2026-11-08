import { api } from './api';
import { mergeSettings } from './settings';
import type {
  BlockEntry,
  CommunityList,
  KeywordRule,
  ModelManifest,
  Settings,
  SiteOverride,
  StatsRecord,
  Subscription,
  TextPatternDef,
} from './types';

/**
 * Typed wrapper over `storage.local`. Small, frequently-read state lives here
 * (settings, user lists); bulky compiled data (filter lists, cosmetic index,
 * image cache, model bytes) lives in IndexedDB — see idb.ts.
 */
export interface LocalSchema {
  settings: Settings;
  subscriptions: Subscription[];
  userFilters: string;
  /** Hostnames on which ad blocking is fully disabled. */
  allowlist: string[];
  siteOverrides: Record<string, SiteOverride>;
  blocklist: BlockEntry[];
  trustedAuthors: string[];
  keywordRules: KeywordRule[];
  /** User edits to the built-in text pattern list, plus custom patterns. null = defaults. */
  textPatterns: TextPatternDef[] | null;
  /** Items the user marked "Not AI": key → timestamp. Capped (see NOT_AI_CAP). */
  notAi: Record<string, number>;
  communityLists: CommunityList[];
  /** Built-in "known AI communities" list toggle (e.g. r/midjourney). */
  builtinCommunities: boolean;
  modelManifest: ModelManifest | null;
  stats: StatsRecord;
  /** Fingerprint of the bundled list data last imported into IndexedDB. */
  bundledDataVersion: string;
}

export interface SessionSchema {
  /** hostname → expiry timestamp for "pause on this site" exceptions. */
  tempAllow: Record<string, number>;
  sessionCounts: { requests: number; elements: number; ai: number; popups: number };
  /** Last DNR matched-rules poll timestamp. */
  lastMatchPoll: number;
}

export const NOT_AI_CAP = 5000;

export async function getLocal<K extends keyof LocalSchema>(
  keys: K[],
): Promise<Partial<Pick<LocalSchema, K>>> {
  return (await api.storage.local.get(keys as never)) as Partial<Pick<LocalSchema, K>>;
}

export async function getOne<K extends keyof LocalSchema>(key: K): Promise<LocalSchema[K] | undefined> {
  const r = await api.storage.local.get(key);
  return (r as Partial<LocalSchema>)[key];
}

export async function setLocal(values: Partial<LocalSchema>): Promise<void> {
  await api.storage.local.set(values);
}

export async function getSettings(): Promise<Settings> {
  return mergeSettings(await getOne('settings'));
}

/** Read-modify-write of settings with a mutator. Callers in UI pages are rare & user-driven. */
export async function updateSettings(mutate: (s: Settings) => void): Promise<Settings> {
  const s = await getSettings();
  mutate(s);
  await setLocal({ settings: s });
  return s;
}

export async function getSession<K extends keyof SessionSchema>(
  keys: K[],
): Promise<Partial<Pick<SessionSchema, K>>> {
  const area = api.storage.session;
  if (!area) return {};
  return (await area.get(keys as never)) as Partial<Pick<SessionSchema, K>>;
}

export async function setSession(values: Partial<SessionSchema>): Promise<void> {
  const area = api.storage.session;
  if (area) await area.set(values);
}

/** Subscribes to changes of specific local keys. Returns an unsubscribe function. */
export function onLocalChange<K extends keyof LocalSchema>(
  keys: K[],
  cb: (changes: Partial<Pick<LocalSchema, K>>) => void,
): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const out: Partial<LocalSchema> = {};
    let hit = false;
    for (const k of keys) {
      if (k in changes) {
        (out as Record<string, unknown>)[k] = changes[k]!.newValue;
        hit = true;
      }
    }
    if (hit) cb(out as Partial<Pick<LocalSchema, K>>);
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}
