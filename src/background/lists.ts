import { compileLines, ruleHash } from '../adblock/compiler';
import { ALLOW_ID_OFFSET, PRIORITY } from '../adblock/constants';
import { defaultEnv, parseHeader, preprocess, type ListHeader } from '../adblock/preprocess';
import { BASE_LIST_ID, USER_LIST_ID } from '../adblock/registry';
import type { CompileIssue, CompileStats, CompiledCosmetic, DnrRuleBody, PopupData } from '../adblock/types';
import { api } from '../shared/api';
import { TARGET, VERSION } from '../shared/env';
import { idbDelete, idbGet, idbGetMany, idbKeys, idbPut } from '../shared/idb';
import { createLogger, errorMessage } from '../shared/log';
import { getOne, setLocal } from '../shared/storage';
import type { Subscription } from '../shared/types';
import { createMutex } from '../shared/util';
import { ready } from './state';

/**
 * Filter-list subscriptions: importing bundled snapshots, downloading
 * updates, compiling, and persisting compiled data in IndexedDB.
 *
 * Network rules of bundled lists live in static rulesets; when such a list
 * is updated we store a *delta* (rules added upstream + static rule IDs that
 * disappeared upstream) instead of re-installing everything as dynamic rules.
 * The DNR manager decides how to apply it within the browser's budgets.
 */
const log = createLogger('lists');
const mutex = createMutex();

export interface StoredList {
  id: string;
  origin: 'bundled' | 'downloaded' | 'user';
  sourceHash: string;
  header: ListHeader;
  cosmetic: CompiledCosmetic;
  popup: PopupData;
  stats: CompileStats;
  compiledAt: number;
  /** Full rule bodies. Absent for 'bundled' records (the static ruleset holds them). */
  rules?: DnrRuleBody[];
  /** Diff against the shipped static ruleset (downloaded updates of bundled lists). */
  delta?: { added: DnrRuleBody[]; disabledStaticIds: number[] } | null;
  dnrMode: 'static' | 'delta' | 'dynamic';
  issues?: CompileIssue[];
}

interface BundledIndexEntry {
  id: string;
  rulesetId: string;
  enabled: boolean;
  rules: number;
  sourceHash: string;
}

const MAX_LIST_BYTES = 25 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 3;
const env = defaultEnv(TARGET);

async function fetchPackaged<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(api.runtime.getURL(path));
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export function bundledIndex(): Promise<BundledIndexEntry[]> {
  return fetchPackaged<BundledIndexEntry[]>('lists/index.json').then((x) => x ?? []);
}

let staticHashCache: Map<string, { b: string[]; a: string[] } | null> = new Map();

export async function staticHashes(id: string): Promise<{ b: string[]; a: string[] } | null> {
  if (!staticHashCache.has(id)) staticHashCache.set(id, await fetchPackaged(`rules/${id}.hashes.json`));
  return staticHashCache.get(id) ?? null;
}

export async function getStoredList(id: string): Promise<StoredList | undefined> {
  return idbGet<StoredList>('lists', id);
}

export async function getStoredLists(ids?: string[]): Promise<Map<string, StoredList>> {
  const keys = ids ?? ((await idbKeys('lists')) as string[]);
  const values = await idbGetMany<StoredList>('lists', keys);
  const out = new Map<string, StoredList>();
  keys.forEach((k, i) => {
    if (values[i]) out.set(k, values[i]!);
  });
  return out;
}

/**
 * Imports the compiled bundled lists shipped in the package. Called on
 * install/update; cheap when nothing changed.
 */
export async function importBundledLists(): Promise<boolean> {
  return mutex(async () => {
    const version = `${VERSION}:${TARGET}`;
    const prev = await getOne('bundledDataVersion');
    const index = await bundledIndex();
    let changed = false;
    staticHashCache = new Map();
    for (const entry of index) {
      const cur = await getStoredList(entry.id);
      const packageChanged = prev !== version;
      if (cur && cur.origin === 'downloaded' && cur.rules) {
        // Static ruleset may have changed with the extension update: recompute the delta.
        if (packageChanged) {
          const delta = await computeDelta(entry.id, cur.rules);
          await idbPut('lists', entry.id, { ...cur, delta, dnrMode: delta ? 'delta' : 'dynamic' });
          changed = true;
        }
        continue;
      }
      if (cur && cur.origin === 'bundled' && cur.sourceHash === entry.sourceHash && !packageChanged) continue;
      const data = await fetchPackaged<Omit<StoredList, 'origin' | 'dnrMode'>>(`lists/${entry.id}.json`);
      if (!data) continue;
      await idbPut('lists', entry.id, { ...data, origin: 'bundled', dnrMode: 'static', delta: null } satisfies StoredList);
      changed = true;
    }
    await setLocal({ bundledDataVersion: version });
    if (changed) log.info('bundled list data imported');
    return changed;
  });
}

/** Rules present upstream but not in the static ruleset, and static rules no longer upstream. */
export async function computeDelta(
  id: string,
  rules: DnrRuleBody[],
): Promise<{ added: DnrRuleBody[]; disabledStaticIds: number[] } | null> {
  const hashes = await staticHashes(id);
  if (!hashes) return null;
  const staticByHash = new Map<string, number>();
  hashes.b.forEach((h, i) => staticByHash.set(h, i + 1));
  hashes.a.forEach((h, i) => staticByHash.set(h, ALLOW_ID_OFFSET + i + 1));
  const upstream = new Set<string>();
  const added: DnrRuleBody[] = [];
  for (const r of rules) {
    const h = ruleHash(r);
    upstream.add(h);
    if (!staticByHash.has(h)) added.push(r);
  }
  const disabledStaticIds: number[] = [];
  for (const [h, ruleId] of staticByHash) if (!upstream.has(h)) disabledStaticIds.push(ruleId);
  return { added, disabledStaticIds };
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const len = Number(resp.headers.get('content-length') ?? 0);
  if (len > MAX_LIST_BYTES) throw new Error('list too large');
  const text = await resp.text();
  if (text.length > MAX_LIST_BYTES) throw new Error('list too large');
  if (/^\s*<(?:!doctype|html)/i.test(text)) throw new Error('received HTML instead of a filter list');
  return text;
}

async function fetchWithMirrors(sub: Subscription): Promise<{ text: string; url: string }> {
  const urls = [sub.url, ...(sub.mirrors ?? [])].filter((u): u is string => !!u);
  let lastErr: unknown = new Error('no URL');
  for (const url of urls) {
    try {
      return { text: await fetchText(url), url };
    } catch (err) {
      lastErr = err;
      log.warn(`fetch ${sub.id} from ${url} failed:`, errorMessage(err));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(errorMessage(lastErr));
}

/** Preprocesses and splices `!#include` sub-lists (same origin only, bounded depth). */
async function expandText(text: string, baseUrl: string | null, depth = 0): Promise<string[]> {
  const { lines, includes } = preprocess(text, env);
  if (!includes.length || !baseUrl || depth >= MAX_INCLUDE_DEPTH) return lines;
  const out = [...lines];
  // Splice from the end so earlier insertion indexes stay valid.
  for (const inc of [...includes].reverse()) {
    try {
      const url = new URL(inc.path, baseUrl);
      if (url.origin !== new URL(baseUrl).origin) continue;
      const sub = await expandText(await fetchText(url.href), url.href, depth + 1);
      out.splice(inc.at, 0, ...sub);
    } catch (err) {
      log.warn(`include ${inc.path} failed:`, errorMessage(err));
    }
  }
  return out;
}

async function sourceHashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface UpdateOutcome {
  id: string;
  changed: boolean;
  error?: string;
}

/** Downloads and compiles one subscription. Does not touch DNR; the caller syncs afterwards. */
export async function updateList(sub: Subscription, force = false): Promise<UpdateOutcome> {
  if (!sub.url) return { id: sub.id, changed: false };
  return mutex(async () => {
    const now = Date.now();
    try {
      const { text, url } = await fetchWithMirrors(sub);
      const sourceHash = await sourceHashOf(text);
      const cur = await getStoredList(sub.id);
      if (!force && cur && cur.sourceHash === sourceHash) {
        await patchSubscription(sub.id, { lastChecked: now, lastUpdated: now, lastError: undefined });
        return { id: sub.id, changed: false };
      }
      const lines = await expandText(text, url);
      const compiled = compileLines(lines, { id: sub.id, env });
      const hasStatic = !!(await staticHashes(sub.id));
      const delta = hasStatic ? await computeDelta(sub.id, compiled.rules) : null;
      const record: StoredList = {
        id: sub.id,
        origin: 'downloaded',
        sourceHash,
        header: compiled.header,
        cosmetic: compiled.cosmetic,
        popup: compiled.popup,
        stats: compiled.stats,
        compiledAt: now,
        rules: compiled.rules,
        delta,
        dnrMode: delta ? 'delta' : 'dynamic',
      };
      await idbPut('lists', sub.id, record);
      const header = compiled.header.title ? compiled.header : parseHeader(lines);
      await patchSubscription(sub.id, {
        lastChecked: now,
        lastUpdated: now,
        lastError: undefined,
        version: header.version ?? header.lastModified,
        expiresHours: header.expiresHours,
        stats: {
          networkFilters: compiled.stats.networkFilters,
          cosmeticFilters: compiled.stats.cosmeticFilters,
          scriptletFilters: compiled.stats.scriptletFilters,
          dnrRules: compiled.stats.dnrRules,
          unsupported: compiled.stats.unsupported,
        },
      });
      log.info(`updated ${sub.id}: ${compiled.stats.dnrRules} rules, delta +${delta?.added.length ?? '-'} / -${delta?.disabledStaticIds.length ?? '-'}`);
      return { id: sub.id, changed: true };
    } catch (err) {
      const msg = errorMessage(err);
      await patchSubscription(sub.id, { lastChecked: now, lastError: msg });
      return { id: sub.id, changed: false, error: msg };
    }
  });
}

/** Whether a subscription is due for an update. */
export function isDue(sub: Subscription, intervalHours: number, now = Date.now()): boolean {
  if (!sub.url || !sub.enabled) return false;
  if (!sub.lastUpdated) {
    // Retry failed first downloads at most every 30 minutes.
    return !sub.lastChecked || now - sub.lastChecked > 30 * 60_000;
  }
  const hours = Math.max(1, Math.min(sub.expiresHours ?? intervalHours, intervalHours));
  if (sub.lastError && sub.lastChecked && now - sub.lastChecked < 60 * 60_000) return false;
  return now - sub.lastUpdated > hours * 3600_000;
}

export async function patchSubscription(id: string, patch: Partial<Subscription>): Promise<void> {
  const s = await ready();
  const subs = s.subscriptions.map((x) => (x.id === id ? { ...x, ...patch } : x));
  s.subscriptions = subs;
  await setLocal({ subscriptions: subs });
}

/** Compiles the user's own filters into a stored list with elevated priority. */
export async function compileUserFilters(text: string): Promise<StoredList> {
  return mutex(async () => {
    const lines = preprocess(text, env).lines;
    const compiled = compileLines(lines, {
      id: USER_LIST_ID,
      env,
      priorityOffset: PRIORITY.userOffset,
      collectIssues: true,
    });
    const record: StoredList = {
      id: USER_LIST_ID,
      origin: 'user',
      sourceHash: await sourceHashOf(text),
      header: {},
      cosmetic: compiled.cosmetic,
      popup: compiled.popup,
      stats: compiled.stats,
      compiledAt: Date.now(),
      rules: compiled.rules,
      delta: null,
      dnrMode: 'dynamic',
      issues: compiled.issues,
    };
    await idbPut('lists', USER_LIST_ID, record);
    return record;
  });
}

export async function addCustomList(url: string, name?: string): Promise<Subscription> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs are supported');
  const s = await ready();
  if (s.subscriptions.some((x) => x.url === u.href)) throw new Error('Already subscribed');
  const sub: Subscription = {
    id: `custom-${Date.now().toString(36)}`,
    name: name?.trim() || u.hostname + u.pathname,
    url: u.href,
    enabled: true,
    builtin: false,
    category: 'custom',
  };
  const subs = [...s.subscriptions, sub];
  s.subscriptions = subs;
  await setLocal({ subscriptions: subs });
  return sub;
}

export async function removeList(id: string): Promise<void> {
  const s = await ready();
  const sub = s.subscriptions.find((x) => x.id === id);
  if (!sub || sub.builtin) throw new Error('Built-in lists can be disabled but not removed');
  const subs = s.subscriptions.filter((x) => x.id !== id);
  s.subscriptions = subs;
  await setLocal({ subscriptions: subs });
  await idbDelete('lists', id);
}

/** Enabled list IDs in priority order (user filters are handled separately). */
export function enabledListIds(subs: Subscription[]): string[] {
  return subs.filter((s) => s.enabled).map((s) => s.id);
}

/** For a bundled list that was never downloaded, the record shipped with the package. */
export function hasBundledRuleset(id: string, manifestRulesets: Set<string>): boolean {
  return manifestRulesets.has(`list_${id}`) || id === BASE_LIST_ID;
}
