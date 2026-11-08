import type { SiteId } from '../../shared/types';
import { genericAdapter } from './generic';
import { googleAdapter } from './google';
import { linkedinAdapter } from './linkedin';
import { redditAdapter } from './reddit';
import type { SiteAdapter } from './types';
import { twitterAdapter } from './twitter';
import { youtubeAdapter } from './youtube';

/** Site adapters in match order; the generic adapter always matches last. */
export const ADAPTERS: SiteAdapter[] = [twitterAdapter, youtubeAdapter, googleAdapter, redditAdapter, linkedinAdapter];

export function adapterFor(hostname: string, url: URL): SiteAdapter {
  return ADAPTERS.find((a) => a.matches(hostname, url)) ?? genericAdapter;
}

export function adapterById(id: SiteId): SiteAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter;
}

export type { SiteAdapter };
