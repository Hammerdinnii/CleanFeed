import { hostMatchesDomain } from '../../shared/domain';
import type { BlockEntry, Signal } from '../../shared/types';
import type { ItemInfo } from '../types';

/**
 * Detector: user-managed and community creator/channel blocklists.
 * Matching is exact on normalized handles (see background/data.ts).
 */
export class BlocklistIndex {
  private byPlatform = new Map<string, Map<string, BlockEntry>>();
  private web: BlockEntry[] = [];

  constructor(entries: readonly BlockEntry[]) {
    for (const e of entries) {
      if (e.platform === 'web') {
        this.web.push(e);
        continue;
      }
      let m = this.byPlatform.get(e.platform);
      if (!m) this.byPlatform.set(e.platform, (m = new Map()));
      m.set(e.handle.toLowerCase(), e);
    }
  }

  get size(): number {
    let n = this.web.length;
    for (const m of this.byPlatform.values()) n += m.size;
    return n;
  }

  find(platform: string, handle: string): BlockEntry | undefined {
    const h = handle.toLowerCase().replace(/^@/, '');
    return this.byPlatform.get(platform)?.get(h) ?? this.byPlatform.get('any')?.get(h);
  }

  findWeb(domain: string): BlockEntry | undefined {
    return this.web.find((e) => hostMatchesDomain(domain, e.handle));
  }
}

function sourceLabel(e: BlockEntry): string {
  if (e.source === 'user') return 'your blocklist';
  if (e.source === 'builtin') return 'AI community list';
  return 'community blocklist';
}

export function blocklistSignal(item: ItemInfo, index: BlocklistIndex): Signal | null {
  if (item.author) {
    const e = index.find(item.author.platform, item.author.handle);
    if (e) {
      return {
        detector: 'blocklist',
        score: 1,
        weight: 1,
        reason: 'Blocked creator',
        detail: `${displayHandle(e)} (${sourceLabel(e)})`,
        definitive: true,
      };
    }
  }
  if (item.community) {
    const e = index.find('reddit', item.community);
    if (e) {
      return {
        detector: 'blocklist',
        score: 1,
        weight: 1,
        reason: e.source === 'builtin' ? 'AI content community' : 'Blocked community',
        detail: `${item.community} (${sourceLabel(e)})`,
        definitive: true,
      };
    }
  }
  for (const d of item.linkDomains ?? []) {
    const e = index.findWeb(d);
    if (e) {
      return { detector: 'blocklist', score: 1, weight: 1, reason: 'Blocked site', detail: `${e.handle} (${sourceLabel(e)})`, definitive: true };
    }
  }
  return null;
}

export function displayHandle(e: { platform: string; handle: string }): string {
  if (e.platform === 'reddit' || e.platform === 'web') return e.handle;
  if (e.platform === 'linkedin') return e.handle;
  return e.handle.startsWith('@') ? e.handle : `@${e.handle}`;
}
