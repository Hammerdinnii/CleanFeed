import type { BlockPlatform, SiteId } from '../shared/types';

/** Normalized view of one piece of content (a post, video card, comment, article…). */
export interface ItemInfo {
  /** Stable identifier used for the "Not AI" whitelist and result caching. */
  key: string;
  site: SiteId;
  kind: 'post' | 'comment' | 'video' | 'short' | 'result' | 'article' | 'overview' | 'image';
  /** Main text, with line breaks preserved where the markup had them. */
  text: string;
  title?: string;
  author?: { platform: BlockPlatform; handle: string; name?: string };
  /** Sub-community, e.g. "r/midjourney". */
  community?: string;
  /** Text of platform-provided labels found on the item ("Made with AI", flair…). */
  labels: string[];
  images: HTMLImageElement[];
  url?: string;
  /** Domains the item links to (search results); checked against the web blocklist. */
  linkDomains?: string[];
  /** Set by adapters for content that is AI by definition (e.g. Google AI Overviews). */
  definitive?: { reason: string; detail?: string };
}

/** Pre-processed text statistics shared by the text detectors. */
export interface TextProfile {
  text: string;
  words: string[];
  wordCount: number;
  sentences: string[];
  paragraphs: string[];
}
