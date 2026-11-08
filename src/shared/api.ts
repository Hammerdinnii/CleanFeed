/**
 * Cross-browser WebExtension API access.
 *
 * Chrome exposes promise-returning APIs on `chrome.*` in MV3; Firefox exposes
 * them on `browser.*` (and, for most APIs, on `chrome.*` too). We type
 * everything against `@types/chrome` and feature-detect the handful of APIs
 * that differ (offscreen, DNR extras, scripting worlds) at the call site.
 */
type ChromeNs = typeof chrome;

const g = globalThis as unknown as { browser?: ChromeNs; chrome?: ChromeNs };

export const api: ChromeNs = (g.browser ?? g.chrome) as ChromeNs;

/** True when running inside an extension context where the API is available. */
export function hasExtensionApi(): boolean {
  return !!(api && api.runtime && api.runtime.id);
}

/** DNR limits with conservative fallbacks for older browsers / Firefox. */
export function dnrLimits() {
  const d = (api?.declarativeNetRequest ?? {}) as unknown as Record<string, number | undefined>;
  return {
    dynamic: d.MAX_NUMBER_OF_DYNAMIC_RULES ?? d.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES ?? 5000,
    unsafeDynamic: d.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ?? 5000,
    session: d.MAX_NUMBER_OF_SESSION_RULES ?? d.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES ?? 5000,
    regex: d.MAX_NUMBER_OF_REGEX_RULES ?? 1000,
    staticRulesets: d.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS ?? 10,
    guaranteedStatic: d.GUARANTEED_MINIMUM_STATIC_RULES ?? 30000,
    disabledStatic: d.MAX_NUMBER_OF_DISABLED_STATIC_RULES ?? 5000,
  };
}

/** Last runtime error message, if any (callback-style APIs). */
export function lastErrorMessage(): string | undefined {
  try {
    return api.runtime.lastError?.message;
  } catch {
    return undefined;
  }
}
