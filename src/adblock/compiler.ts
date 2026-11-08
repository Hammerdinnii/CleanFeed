import { fnv1a, hashString } from '../shared/hash';
import { ALLOW_ID_OFFSET, MAX_DOMAINS_PER_RULE } from './constants';
import { isCosmeticLine, parseCosmeticFilter } from './cosmetic';
import { badfilterKey, convertNetworkFilter, parseNetworkFilter, type NetworkFilter } from './network';
import { parseHeader, preprocess, type PreprocessEnv } from './preprocess';
import type {
  CompileIssue,
  CompiledCosmetic,
  CompiledList,
  DnrRule,
  DnrRuleBody,
  PopupData,
  SpecificRule,
} from './types';

/**
 * Compiles filter-list text into DNR rules + cosmetic data + popup data.
 * Pure and deterministic: the same input always yields the same output, which
 * the delta-update logic relies on (see background/dnr.ts).
 */
export interface CompileOptions {
  id: string;
  env: PreprocessEnv;
  priorityOffset?: number;
  /** Record per-line issues (used to give feedback on the user's own filters). */
  collectIssues?: boolean;
}

/** JSON.stringify with sorted object keys, so equal rules serialize identically. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function ruleHash(rule: DnrRuleBody): string {
  return hashString(stableStringify({ priority: rule.priority, action: rule.action, condition: rule.condition }));
}

export function isAllowType(rule: DnrRuleBody): boolean {
  return rule.action.type === 'allow' || rule.action.type === 'allowAllRequests';
}

export function isUnsafeRule(rule: DnrRuleBody): boolean {
  return rule.action.type === 'redirect' || rule.action.type === 'modifyHeaders';
}

/** Lines that are comments in either ABP or hosts-file syntax. */
function isComment(t: string): boolean {
  if (t.startsWith('!') || t.startsWith('[')) return true;
  if (t.startsWith('#') && !/^#@?(?:\$\?|\$|\?|%)?#/.test(t)) return true;
  return false;
}

export function compileFilterText(text: string, opts: CompileOptions): CompiledList {
  const { lines } = preprocess(text, opts.env);
  return compileLines(lines, opts);
}

export function compileLines(lines: readonly string[], opts: CompileOptions): CompiledList {
  const issues: CompileIssue[] = [];
  const issue = (line: number, text: string, message: string) => {
    if (opts.collectIssues) issues.push({ line: line + 1, text, message });
  };

  const cosmetic: CompiledCosmetic = { generic: [], genericExceptions: [], genericNot: [], specific: [] };
  const popup: PopupData = { block: [], allow: [], hosts: [] };
  const stats = {
    lines: lines.length,
    networkFilters: 0,
    cosmeticFilters: 0,
    scriptletFilters: 0,
    dnrRules: 0,
    unsupported: 0,
    regexRules: 0,
    unsafeRules: 0,
  };

  const network: { f: NetworkFilter; line: number }[] = [];
  const badfilters = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || isComment(t)) continue;
    if (t.includes('$$') || t.includes('$@$')) {
      stats.unsupported++;
      issue(i, t, 'HTML filtering is not supported in Manifest V3');
      continue;
    }
    if (isCosmeticLine(t)) {
      const r = parseCosmeticFilter(t);
      if (!r.ok) {
        stats.unsupported++;
        issue(i, t, r.reason);
        continue;
      }
      const { domains, notDomains, entries, kind } = r.value;
      if (kind === 'scriptlet') stats.scriptletFilters++;
      else stats.cosmeticFilters++;
      for (const e of entries) {
        if (domains.length === 0) {
          if (e.t === 'hide' && notDomains.length === 0) cosmetic.generic.push(e.s);
          else if (e.t === 'hide') cosmetic.genericNot.push({ s: e.s, not: notDomains });
          else if (e.t === 'unhide' && notDomains.length === 0) cosmetic.genericExceptions.push(e.s);
          else if (e.t === 'unjs') cosmetic.specific.push({ d: ['*'], e, ...(notDomains.length ? { n: notDomains } : {}) });
          else {
            stats.unsupported++;
            issue(i, t, 'unsupported generic filter');
          }
        } else {
          const rule: SpecificRule = { d: domains, e };
          if (notDomains.length) rule.n = notDomains;
          cosmetic.specific.push(rule);
        }
      }
      continue;
    }
    const r = parseNetworkFilter(t);
    if (!r.ok) {
      if (r.reason !== 'empty' && r.reason !== 'local host entry') {
        stats.unsupported++;
        issue(i, t, r.reason);
      }
      continue;
    }
    if (r.filter.options.badfilter) {
      badfilters.add(badfilterKey(r.filter));
      continue;
    }
    network.push({ f: r.filter, line: i });
  }

  const rules: DnrRuleBody[] = [];
  const blockHosts = new Set<string>();
  for (const { f, line } of network) {
    if (badfilters.size && badfilters.has(badfilterKey(f))) continue;
    stats.networkFilters++;
    const res = convertNetworkFilter(f, { priorityOffset: opts.priorityOffset ?? 0 });
    if (res.popup) (res.popup.exception ? popup.allow : popup.block).push(res.popup.filter);
    if (res.cosmeticFlags) {
      for (const flag of res.cosmeticFlags.flags) {
        cosmetic.specific.push({ d: [res.cosmeticFlags.hostname], e: { t: 'flag', s: flag } });
      }
    }
    if (res.blockHost) blockHosts.add(res.blockHost);
    if (res.reason && !res.rules.length && !res.popup && !res.cosmeticFlags) {
      stats.unsupported++;
      issue(line, f.raw, res.reason);
    }
    rules.push(...res.rules);
  }

  const merged = mergeAndDedupe(rules);
  for (const r of merged) {
    if (r.condition.regexFilter) stats.regexRules++;
    if (isUnsafeRule(r)) stats.unsafeRules++;
  }
  stats.dnrRules = merged.length;
  popup.hosts = [...blockHosts].sort();

  dedupeCosmetic(cosmetic);

  const out: CompiledList = {
    id: opts.id,
    header: parseHeader(lines),
    rules: merged,
    cosmetic,
    popup,
    stats,
  };
  if (opts.collectIssues) out.issues = issues;
  return out;
}

/**
 * Deduplicates rules and merges hostname-only rules that share every other
 * property into multi-domain rules.
 *
 * Bucketing is by domain hash rather than by position so that adding or
 * removing one domain upstream only changes the one merged rule containing
 * it — this keeps list-update deltas small.
 */
export function mergeAndDedupe(rules: DnrRuleBody[]): DnrRuleBody[] {
  const seen = new Set<string>();
  const groups = new Map<string, { template: DnrRuleBody; domains: Set<string> }>();
  const out: DnrRuleBody[] = [];

  for (const r of rules) {
    const c = r.condition;
    const mergeable = c.requestDomains && !c.urlFilter && !c.regexFilter;
    if (mergeable) {
      const { requestDomains, ...rest } = c;
      const sig = stableStringify({ priority: r.priority, action: r.action, condition: rest });
      let g = groups.get(sig);
      if (!g) {
        g = { template: { priority: r.priority, action: r.action, condition: rest }, domains: new Set() };
        groups.set(sig, g);
      }
      for (const d of requestDomains!) g.domains.add(d);
      continue;
    }
    const key = stableStringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  const sigs = [...groups.keys()].sort();
  for (const sig of sigs) {
    const g = groups.get(sig)!;
    const domains = pruneSubdomains([...g.domains]);
    const buckets = bucketCount(domains.length);
    const parts: string[][] = Array.from({ length: buckets }, () => []);
    for (const d of domains) parts[buckets === 1 ? 0 : fnv1a(d) % buckets]!.push(d);
    for (const p of parts) {
      if (!p.length) continue;
      p.sort();
      for (let i = 0; i < p.length; i += MAX_DOMAINS_PER_RULE) {
        out.push({
          priority: g.template.priority,
          action: g.template.action,
          condition: { ...g.template.condition, requestDomains: p.slice(i, i + MAX_DOMAINS_PER_RULE) },
        });
      }
    }
  }
  return out;
}

function bucketCount(n: number): number {
  if (n <= MAX_DOMAINS_PER_RULE) return 1;
  // Power-of-two bucket counts keep the assignment stable across small changes in n.
  let b = 1;
  while (n / b > MAX_DOMAINS_PER_RULE * 0.6) b *= 2;
  return b;
}

/** Drops domains whose parent is also listed (requestDomains already matches subdomains). */
function pruneSubdomains(domains: string[]): string[] {
  const set = new Set(domains);
  return domains.filter((d) => {
    let dot = d.indexOf('.');
    while (dot >= 0) {
      const parent = d.slice(dot + 1);
      if (set.has(parent)) return false;
      dot = d.indexOf('.', dot + 1);
    }
    return true;
  });
}

function dedupeCosmetic(c: CompiledCosmetic): void {
  c.generic = [...new Set(c.generic)];
  c.genericExceptions = [...new Set(c.genericExceptions)];
  const seenNot = new Set<string>();
  c.genericNot = c.genericNot.filter((g) => {
    const k = g.s + '\u0001' + g.not.join(',');
    if (seenNot.has(k)) return false;
    seenNot.add(k);
    return true;
  });
  const seen = new Set<string>();
  c.specific = c.specific.filter((r) => {
    const k = stableStringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Assigns rule IDs inside an ID block: block-like rules from base+1, allow
 * rules from base+ALLOW_ID_OFFSET+1 (see constants.ts).
 */
export function materializeRules(rules: readonly DnrRuleBody[], base: number): DnrRule[] {
  let nBlock = 0;
  let nAllow = 0;
  return rules.map((r) => {
    const id = isAllowType(r) ? base + ALLOW_ID_OFFSET + ++nAllow : base + ++nBlock;
    return { id, priority: r.priority, action: r.action, condition: r.condition };
  });
}
