import { isValidHostname, normalizeHostname } from '../shared/domain';
import type { DataMutation } from '../shared/messages';
import { NOT_AI_CAP, getLocal, setLocal } from '../shared/storage';
import type { BlockEntry } from '../shared/types';
import { createMutex } from '../shared/util';

/**
 * Serialized read-modify-write of user collections. Content scripts in many
 * tabs (and the UI pages) may mutate the same keys concurrently, so every
 * mutation goes through this single queue in the background.
 */
const mutex = createMutex();

export function normalizeHandle(platform: string, handle: string): string {
  let h = handle.trim().toLowerCase();
  if (platform === 'reddit') {
    h = h.replace(/^\/+/, '');
    if (!/^(u|r)\//.test(h)) h = `u/${h.replace(/^@/, '')}`;
    return h;
  }
  if (platform === 'web') return normalizeHostname(h.replace(/^https?:\/\//, '').split('/')[0]!);
  h = h.replace(/^@/, '');
  if (platform === 'youtube' && /^(channel|c|user)\//.test(h)) return h;
  return h;
}

export function applyMutation(m: DataMutation): Promise<{ ok: boolean; error?: string }> {
  return mutex(async () => {
    switch (m.op) {
      case 'notAi': {
        const { notAi = {} } = await getLocal(['notAi']);
        if (m.value) notAi[m.key] = Date.now();
        else delete notAi[m.key];
        const keys = Object.keys(notAi);
        if (keys.length > NOT_AI_CAP) {
          keys.sort((a, b) => notAi[a]! - notAi[b]!);
          for (const k of keys.slice(0, keys.length - NOT_AI_CAP)) delete notAi[k];
        }
        await setLocal({ notAi });
        return { ok: true };
      }
      case 'blockAuthor': {
        const { blocklist = [] } = await getLocal(['blocklist']);
        const entry: BlockEntry = { ...m.entry, handle: normalizeHandle(m.entry.platform, m.entry.handle) };
        if (!entry.handle) return { ok: false, error: 'empty handle' };
        if (!blocklist.some((b) => b.platform === entry.platform && b.handle === entry.handle)) {
          blocklist.push({ ...entry, added: entry.added || Date.now(), source: entry.source || 'user' });
          await setLocal({ blocklist });
        }
        return { ok: true };
      }
      case 'unblockAuthor': {
        const { blocklist = [] } = await getLocal(['blocklist']);
        const h = normalizeHandle(m.platform, m.handle);
        await setLocal({ blocklist: blocklist.filter((b) => !(b.platform === m.platform && b.handle === h)) });
        return { ok: true };
      }
      case 'trustAuthor': {
        const { trustedAuthors = [] } = await getLocal(['trustedAuthors']);
        const set = new Set(trustedAuthors);
        if (m.value) set.add(m.key);
        else set.delete(m.key);
        await setLocal({ trustedAuthors: [...set] });
        return { ok: true };
      }
      case 'siteOverride': {
        const host = normalizeHostname(m.hostname);
        if (!isValidHostname(host)) return { ok: false, error: 'invalid hostname' };
        const { siteOverrides = {} } = await getLocal(['siteOverrides']);
        if (!m.override || Object.values(m.override).every((v) => v === undefined)) delete siteOverrides[host];
        else siteOverrides[host] = m.override;
        await setLocal({ siteOverrides });
        return { ok: true };
      }
      case 'allowlist': {
        const host = normalizeHostname(m.hostname);
        if (!isValidHostname(host)) return { ok: false, error: 'invalid hostname' };
        const { allowlist = [] } = await getLocal(['allowlist']);
        const set = new Set(allowlist);
        if (m.value) set.add(host);
        else set.delete(host);
        await setLocal({ allowlist: [...set].sort() });
        return { ok: true };
      }
      case 'keywordRule': {
        const { keywordRules = [] } = await getLocal(['keywordRules']);
        const rest = keywordRules.filter((r) => r.id !== m.id);
        if (m.rule) rest.push(m.rule);
        await setLocal({ keywordRules: rest });
        return { ok: true };
      }
    }
  });
}
