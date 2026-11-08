/**
 * DNR priority ladder. Higher wins; at equal priority DNR resolves
 * allow > allowAllRequests > block > upgradeScheme > redirect.
 *
 *   block (100) < removeparam (110) < redirect (150) < allow / $document (200)
 *   < $important (300) < user filters (+1000) < per-site allowlist (10000)
 *
 * This mirrors ABP/uBO semantics: `@@` exceptions beat ordinary blocks,
 * `$important` beats exceptions, the user's own filters beat list filters,
 * and the user's "disable on this site" beats everything.
 */
export const PRIORITY = {
  block: 100,
  csp: 100,
  removeparam: 110,
  redirect: 150,
  allow: 200,
  important: 300,
  importantRedirect: 350,
  userOffset: 1000,
  siteAllow: 10_000,
  pauseAllow: 10_001,
} as const;

/**
 * Rule-ID layout. Each source (a filter list, the user filters, the system
 * allowlist) owns a block of 1,000,000 IDs; within a block, IDs at or above
 * ALLOW_ID_OFFSET are allow-type rules. Encoding the action in the ID lets us
 * count "blocked" matches from getMatchedRules() without loading rule bodies.
 */
export const ID_BLOCK = 1_000_000;
export const ALLOW_ID_OFFSET = 500_000;

export function isAllowRuleId(id: number): boolean {
  return id % ID_BLOCK >= ALLOW_ID_OFFSET;
}

/** Dynamic-rule ID bases. */
export const DYNAMIC_BASE = {
  system: 0, // 1..999,999 — site allowlist
  user: 1 * ID_BLOCK,
  lists: 2 * ID_BLOCK, // list N occupies (2 + N) * ID_BLOCK
} as const;

/** Prefix for static ruleset IDs in the manifest. */
export const RULESET_PREFIX = 'list_';

/** Resource types that both Chrome and Firefox accept in DNR rules. */
export const DNR_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
] as const;
export type DnrResourceType = (typeof DNR_RESOURCE_TYPES)[number];

/** Upper bound on domains per merged rule; keeps individual rules reasonably sized. */
export const MAX_DOMAINS_PER_RULE = 1000;
