import type { AiMode, Sensitivity, Settings, SiteOverride } from './types';

export const SETTINGS_SCHEMA = 1;

export const DEFAULT_SETTINGS: Settings = {
  schema: SETTINGS_SCHEMA,
  enabled: true,
  ads: {
    enabled: true,
    cosmetic: true,
    feedAds: true,
    scriptlets: true,
    popupBlocking: 'filters',
    youtubeVideoAds: true,
    badge: true,
    autoUpdate: true,
    updateIntervalHours: 24,
    level: 'standard',
  },
  ai: {
    enabled: true,
    // Default is non-destructive: content is collapsed behind a bar, never removed.
    mode: 'collapse',
    sensitivity: 'balanced',
    detectors: {
      platformLabels: true,
      metadata: true,
      textPatterns: true,
      textStats: true,
      imageModel: true,
      blocklist: true,
      keywords: true,
    },
    sites: { twitter: true, youtube: true, google: true, reddit: true, linkedin: true, generic: true },
    // On arbitrary websites we only label; heuristics are less reliable without site context.
    genericMode: 'label',
    googleAiOverview: 'collapse',
    hideGoogleAiMode: false,
    minWords: 40,
    imageMinPx: 160,
    fetchImageMetadata: true,
    genericImages: true,
    showReasons: true,
    imageModelThreshold: 0.8,
    imageBackend: 'auto',
  },
  privacy: { stats: true },
  ui: { theme: 'system' },
};

/** Verdict thresholds per sensitivity. Higher threshold = fewer false positives. */
export const SENSITIVITY_THRESHOLDS: Record<Sensitivity, number> = {
  low: 0.85,
  balanced: 0.72,
  high: 0.58,
};

/** Deep-merges stored settings onto defaults so new keys appear after upgrades. */
export function mergeSettings(stored: unknown): Settings {
  const out = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  deepAssign(out, (stored ?? {}) as Record<string, unknown>);
  const s = out as unknown as Settings;
  s.schema = SETTINGS_SCHEMA;
  return s;
}

function deepAssign(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (!(k in target)) continue; // drop unknown keys from older/foreign data
    const t = target[k];
    if (t && typeof t === 'object' && !Array.isArray(t) && v && typeof v === 'object' && !Array.isArray(v)) {
      deepAssign(t as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined && typeof v === typeof t) {
      target[k] = v;
    }
  }
}

/** Effective per-site state after applying overrides and the allowlist. */
export interface EffectiveSiteState {
  ads: boolean;
  cosmetic: boolean;
  ai: boolean;
  aiMode: AiMode;
}

export function effectiveSiteState(
  settings: Settings,
  hostname: string,
  overrides: Record<string, SiteOverride>,
  allowlisted: boolean,
): EffectiveSiteState {
  const o = findOverride(hostname, overrides);
  const ads = settings.enabled && settings.ads.enabled && !allowlisted && o?.ads !== false;
  return {
    ads,
    cosmetic: ads && settings.ads.cosmetic && o?.cosmetic !== false,
    ai: settings.enabled && settings.ai.enabled && (o?.ai ?? true),
    aiMode: o?.aiMode ?? settings.ai.mode,
  };
}

/** Finds the most specific override for a hostname (exact host, then parent domains). */
export function findOverride(
  hostname: string,
  overrides: Record<string, SiteOverride>,
): SiteOverride | undefined {
  let h = hostname;
  for (;;) {
    const o = overrides[h];
    if (o) return o;
    const dot = h.indexOf('.');
    if (dot < 0) return undefined;
    h = h.slice(dot + 1);
  }
}
