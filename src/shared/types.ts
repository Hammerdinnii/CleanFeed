/**
 * Data model shared by every extension context. Anything persisted lives here
 * so that storage migrations have one place to look.
 */

export type AiMode = 'collapse' | 'blur' | 'dim' | 'label';
export type Sensitivity = 'low' | 'balanced' | 'high';
export type SiteId = 'twitter' | 'youtube' | 'google' | 'reddit' | 'linkedin' | 'generic';
export type DetectorId =
  | 'platformLabels'
  | 'metadata'
  | 'textPatterns'
  | 'textStats'
  | 'imageModel'
  | 'blocklist'
  | 'keywords';

export type PopupBlocking = 'off' | 'filters' | 'strict';

export interface Settings {
  schema: number;
  /** Master switch for the whole extension. */
  enabled: boolean;
  ads: {
    enabled: boolean;
    /** Element hiding (## rules, :style rules, procedural filters). */
    cosmetic: boolean;
    /** Hide promoted posts in social feeds (X, Reddit, LinkedIn, YouTube, Google). */
    feedAds: boolean;
    /** Run scriptlets (##+js) — anti-adblock defusing and ad-script neutralization. */
    scriptlets: boolean;
    popupBlocking: PopupBlocking;
    /** Content-side fallback that skips/mutes YouTube video ads and removes the anti-adblock dialog. */
    youtubeVideoAds: boolean;
    /** Show per-tab block counts on the toolbar icon. */
    badge: boolean;
    autoUpdate: boolean;
    updateIntervalHours: number;
    /** 'standard' uses list defaults; 'aggressive' also enables annoyance lists & strict popups. */
    level: 'standard' | 'aggressive';
  };
  ai: {
    enabled: boolean;
    mode: AiMode;
    sensitivity: Sensitivity;
    detectors: Record<DetectorId, boolean>;
    sites: Record<SiteId, boolean>;
    /** Mode used on sites without a dedicated adapter. Defaults to the least destructive option. */
    genericMode: AiMode;
    /** Google AI Overviews / AI Mode handling. */
    googleAiOverview: 'collapse' | 'show';
    hideGoogleAiMode: boolean;
    /** Minimum words before text heuristics are trusted on their own. */
    minWords: number;
    /** Minimum rendered size (px) of an image before it is analyzed. */
    imageMinPx: number;
    /** Fetch image bytes (from the image's own server) to read provenance metadata. */
    fetchImageMetadata: boolean;
    /** Analyze images on sites without an adapter. */
    genericImages: boolean;
    showReasons: boolean;
    imageModelThreshold: number;
    /** Preferred ONNX execution provider. */
    imageBackend: 'auto' | 'webgpu' | 'wasm';
  };
  privacy: {
    stats: boolean;
  };
  ui: {
    theme: 'system' | 'light' | 'dark';
  };
}

export interface SiteOverride {
  /** undefined = follow global setting. */
  ads?: boolean;
  ai?: boolean;
  aiMode?: AiMode;
  cosmetic?: boolean;
}

export type BlockPlatform = 'twitter' | 'youtube' | 'reddit' | 'linkedin' | 'web' | 'any';

export interface BlockEntry {
  platform: BlockPlatform;
  /** Normalized handle: lowercase, without leading "@", "u/" kept for reddit users vs "r/" for subreddits. */
  handle: string;
  note?: string;
  added: number;
  /** 'user' or `community:<listId>`. */
  source: string;
}

export interface CommunityList {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastUpdated?: number;
  error?: string;
  entries: BlockEntry[];
}

export interface KeywordRule {
  id: string;
  pattern: string;
  /** 'ai' adds an AI signal; 'ads' hides the item as unwanted/promotional; 'both' does both. */
  target: 'ai' | 'ads' | 'both';
  enabled: boolean;
  /** Optional hostname restriction (empty = everywhere). */
  sites?: string[];
}

export interface TextPatternDef {
  id: string;
  /** RegExp source (case-insensitive unless flags say otherwise). */
  pattern: string;
  flags?: string;
  weight: number;
  category: 'phrase' | 'vocabulary' | 'structure' | 'formatting' | 'artifact';
  description: string;
  /** Hits beyond this count are ignored (prevents one repeated word dominating). */
  maxHits?: number;
  /** A single hit is near-conclusive (e.g. "As an AI language model"). */
  strong?: boolean;
  enabled?: boolean;
}

export interface Subscription {
  id: string;
  name: string;
  url: string | null;
  /** Fallback mirrors tried in order when `url` fails. */
  mirrors?: string[];
  enabled: boolean;
  builtin: boolean;
  category: 'ads' | 'privacy' | 'annoyances' | 'security' | 'regional' | 'custom';
  homepage?: string;
  /** Enabled automatically when ads.level === 'aggressive'. */
  aggressive?: boolean;
  lastUpdated?: number;
  lastChecked?: number;
  lastError?: string;
  /** "! Expires:" from the list header, in hours. */
  expiresHours?: number;
  version?: string;
  stats?: ListStats;
  /** Static ruleset shipped with the build, if any. */
  bundled?: boolean;
}

export interface ListStats {
  networkFilters: number;
  cosmeticFilters: number;
  scriptletFilters: number;
  dnrRules: number;
  unsupported: number;
  /** Where the active network rules live: shipped static ruleset, dynamic delta or full dynamic. */
  mode?: 'static' | 'static+delta' | 'dynamic' | 'truncated' | 'none';
}

export interface Counts {
  requests: number;
  elements: number;
  ai: number;
  popups: number;
}

export interface StatsRecord {
  day: string;
  today: Counts;
  total: Counts;
}

export interface ModelManifest {
  id: string;
  name: string;
  /** Square input size, or [height, width]. */
  inputSize: number | [number, number];
  layout: 'NCHW' | 'NHWC';
  mean: [number, number, number];
  std: [number, number, number];
  /** 'softmax' = raw logits needing softmax; 'sigmoid' = single logit; 'probabilities' = already normalized. */
  output: 'softmax' | 'sigmoid' | 'probabilities';
  /** Index of the "AI-generated / synthetic" class. */
  aiIndex: number;
  labels?: string[];
  inputName?: string;
  outputName?: string;
  resize: 'center-crop' | 'stretch';
  source?: string;
  license?: string;
  sizeBytes?: number;
  sha256?: string;
}

/** A single detector's contribution to a verdict. */
export interface Signal {
  detector: DetectorId | 'siteLabel';
  /** 0..1, detector's estimate that the item is AI-generated. */
  score: number;
  /** Detector reliability 0..1: how much this signal is trusted relative to others. */
  weight: number;
  /** Short human-readable reason, e.g. "AI writing patterns". */
  reason: string;
  detail?: string;
  /** Conclusive on its own (platform label, blocklisted creator, C2PA AI source type). */
  definitive?: boolean;
  /** Keyword "ads" rules produce non-AI hide signals. */
  category?: 'ai' | 'unwanted';
}

export interface Verdict {
  score: number;
  flagged: boolean;
  signals: Signal[];
  /** Top reason shown in the UI. */
  reason: string;
  category: 'ai' | 'unwanted';
}

export interface ImageAnalysis {
  url: string;
  sha256?: string;
  metadata?: MetadataFindings;
  model?: { score: number; modelId: string; backend: string; ms: number };
  error?: string;
}

export interface MetadataFindings {
  /** Strongest conclusion reached from metadata. */
  verdict: 'ai' | 'edited-with-ai' | 'camera' | 'unknown';
  /** e.g. "C2PA: trainedAlgorithmicMedia", "PNG parameters (Stable Diffusion)". */
  evidence: string[];
  generator?: string;
  hasC2pa: boolean;
}
