import type { DnrResourceType } from './constants';
import type { ProceduralFilter } from './procedural';
import type { ListHeader } from './preprocess';

/**
 * Structural DNR types. We avoid @types/chrome's declared enums so the same
 * code can run at build time under Node.
 */
export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  domainType?: 'firstParty' | 'thirdParty';
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  requestMethods?: string[];
  excludedRequestMethods?: string[];
  tabIds?: number[];
}

export interface DnrAction {
  type: 'block' | 'allow' | 'allowAllRequests' | 'redirect' | 'modifyHeaders' | 'upgradeScheme';
  redirect?: {
    extensionPath?: string;
    url?: string;
    regexSubstitution?: string;
    transform?: { query?: string; queryTransform?: { removeParams?: string[] } };
  };
  responseHeaders?: { header: string; operation: 'append' | 'set' | 'remove'; value?: string }[];
}

export interface DnrRuleBody {
  priority: number;
  action: DnrAction;
  condition: DnrCondition;
}

export interface DnrRule extends DnrRuleBody {
  id: number;
}

/** Cosmetic entries, keyed in the index by hostname or entity (`example.*`). */
export type CosmeticEntry =
  | { t: 'hide'; s: string }
  | { t: 'unhide'; s: string }
  | { t: 'style'; s: string; sel: string; css: string }
  | { t: 'proc'; s: string; p: ProceduralFilter }
  | { t: 'js'; s: string; name: string; args: string[] }
  | { t: 'unjs'; s: string }
  | { t: 'flag'; s: CosmeticFlag };

export type CosmeticFlag = 'generichide' | 'elemhide' | 'specifichide';

export interface SpecificRule {
  /** Domains/entities the entry applies to. */
  d: string[];
  /** Negated domains (subdomains excluded from `d`). */
  n?: string[];
  e: CosmeticEntry;
}

export interface CompiledCosmetic {
  /** Plain generic hide selectors (`##.ad`). */
  generic: string[];
  /** Generic exceptions (`#@#.ad`) — disable a generic selector everywhere. */
  genericExceptions: string[];
  /** Generic selectors with only negated domains (`~a.com##.ad`). */
  genericNot: { s: string; not: string[] }[];
  specific: SpecificRule[];
}

export interface PopupFilter {
  /** ABP-style URL pattern ('' with `host` set means hostname-only). */
  pattern: string;
  regex?: boolean;
  host?: string;
  domains?: string[];
  notDomains?: string[];
  thirdParty?: boolean;
}

export interface PopupData {
  block: PopupFilter[];
  allow: PopupFilter[];
  /** Hostnames blocked outright (`||host^` with no restricting options) — used by strict popup mode. */
  hosts: string[];
}

export interface CompileStats {
  lines: number;
  networkFilters: number;
  cosmeticFilters: number;
  scriptletFilters: number;
  dnrRules: number;
  unsupported: number;
  regexRules: number;
  unsafeRules: number;
}

export interface CompileIssue {
  line: number;
  text: string;
  message: string;
}

export interface CompiledList {
  id: string;
  header: ListHeader;
  /** Rules without IDs; IDs are assigned when materialized (static ruleset or dynamic block). */
  rules: DnrRuleBody[];
  cosmetic: CompiledCosmetic;
  popup: PopupData;
  stats: CompileStats;
  /** Only collected when `collectIssues` is set (user filters). */
  issues?: CompileIssue[];
}
