import { ENTITY_EXPANSION_TLDS, isValidHostname, toAsciiHostname } from '../shared/domain';
import { DNR_RESOURCE_TYPES, PRIORITY, type DnrResourceType } from './constants';
import { redirectPath, resolveRedirect } from './resources';
import type { CosmeticFlag, DnrCondition, DnrRuleBody, PopupFilter } from './types';

/**
 * Network filter parsing (ABP / uBO / AdGuard syntax) and conversion to
 * declarativeNetRequest rules.
 *
 * Design notes:
 *  - Unknown or unsupported options cause the filter to be DROPPED rather than
 *    having the option ignored: ignoring e.g. `$header=` would turn a narrow
 *    filter into a broad one and over-block.
 *  - Hostname-only filters (`||ads.example^`) are emitted with
 *    `requestDomains` so the compiler can merge thousands of them into a few
 *    rules (see compiler.ts). This is what keeps big lists inside DNR budgets.
 */

export interface NetworkOptions {
  types: Set<DnrResourceType>;
  excludedTypes: Set<DnrResourceType>;
  popup: boolean;
  thirdParty?: boolean;
  domains: string[];
  notDomains: string[];
  to: string[];
  notTo: string[];
  methods: string[];
  notMethods: string[];
  matchCase: boolean;
  important: boolean;
  badfilter: boolean;
  redirect?: string;
  removeparam?: string | true;
  csp?: string;
  /** Exception-only flags that toggle cosmetic filtering for a site. */
  cosmeticFlags: CosmeticFlag[];
  /** `$document` / `$doc` on an exception → allowAllRequests. */
  document: boolean;
}

export interface NetworkFilter {
  raw: string;
  exception: boolean;
  /** ABP pattern with wildcards/anchors, or regex source when `regex`. */
  pattern: string;
  regex: boolean;
  /** Set when the pattern is exactly `||hostname^` (or a bare hostname). */
  hostname?: string;
  options: NetworkOptions;
}

export type ParseResult =
  | { ok: true; filter: NetworkFilter }
  | { ok: false; reason: string };

const TYPE_MAP: Record<string, DnrResourceType[] | 'popup' | 'document' | 'all' | 'unsupported'> = {
  script: ['script'],
  image: ['image'],
  img: ['image'],
  stylesheet: ['stylesheet'],
  css: ['stylesheet'],
  object: ['object'],
  'object-subrequest': ['object'],
  xmlhttprequest: ['xmlhttprequest'],
  xhr: ['xmlhttprequest'],
  subdocument: ['sub_frame'],
  frame: ['sub_frame'],
  ping: ['ping'],
  beacon: ['ping'],
  websocket: ['websocket'],
  media: ['media'],
  font: ['font'],
  other: ['other'],
  csp_report: ['csp_report'],
  document: 'document',
  doc: 'document',
  popup: 'popup',
  popunder: 'popup',
  all: 'all',
  webrtc: 'unsupported',
  webbundle: 'unsupported',
};

/** Splits the option string on commas, respecting `\,` escapes and /regex/ values. */
export function splitOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inRegexValue = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (!inRegexValue && c === '/' && cur.endsWith('=')) {
      inRegexValue = true;
      cur += c;
      continue;
    }
    if (inRegexValue && c === '/') {
      inRegexValue = false;
      cur += c;
      continue;
    }
    if (c === ',' && !inRegexValue) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out.map((o) => o.trim()).filter(Boolean);
}

const OPTION_START = /^~?[a-z0-9_-]+(?:=|,|$)/i;

/** Finds the `$` that starts the options part, scanning from the right. */
export function findOptionsAnchor(s: string): number {
  let idx = s.lastIndexOf('$');
  while (idx >= 0) {
    const after = s.slice(idx + 1);
    // A regex pattern's closing slash must precede the anchor.
    if (OPTION_START.test(after)) {
      // A "$" inside a /regex/ (no options) must not be taken as the options anchor.
      const before = s.slice(0, idx);
      if (s.startsWith('/') && s.endsWith('/') && s.length > 2 && !before.endsWith('/')) {
        idx = s.lastIndexOf('$', idx - 1);
        continue;
      }
      return idx;
    }
    idx = s.lastIndexOf('$', idx - 1);
  }
  return -1;
}

function parseDomainList(value: string, sep: string): { pos: string[]; neg: string[] } | null {
  const pos: string[] = [];
  const neg: string[] = [];
  for (let d of value.split(sep)) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const negated = d.startsWith('~');
    if (negated) d = d.slice(1);
    if (d.startsWith('/')) return null; // regex domains are not representable in DNR
    let host: string | null = d;
    if (d.endsWith('.*')) {
      const base = d.slice(0, -2);
      const ascii = toAsciiHostname(base);
      if (!ascii || !isValidHostname(ascii)) return null;
      // Entities are kept symbolic here and expanded when building DNR conditions.
      (negated ? neg : pos).push(`${ascii}.*`);
      continue;
    }
    host = toAsciiHostname(d);
    if (!host || !isValidHostname(host)) return null;
    (negated ? neg : pos).push(host);
  }
  return { pos, neg };
}

function expandEntities(domains: string[]): string[] {
  const out = new Set<string>();
  for (const d of domains) {
    if (d.endsWith('.*')) {
      const base = d.slice(0, -2);
      for (const tld of ENTITY_EXPANSION_TLDS) out.add(`${base}.${tld}`);
    } else out.add(d);
  }
  return [...out];
}

function emptyOptions(): NetworkOptions {
  return {
    types: new Set(),
    excludedTypes: new Set(),
    popup: false,
    domains: [],
    notDomains: [],
    to: [],
    notTo: [],
    methods: [],
    notMethods: [],
    matchCase: false,
    important: false,
    badfilter: false,
    cosmeticFlags: [],
    document: false,
  };
}

const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

/** Options we accept but that have no DNR effect. */
const NOOP_OPTIONS = new Set(['cname', 'genericblock', 'stealth', 'content', 'extension', 'jsinject', 'urlblock', 'network']);

function parseOptions(list: string[], exception: boolean): NetworkOptions | string {
  const o = emptyOptions();
  for (const raw of list) {
    const eq = raw.indexOf('=');
    let name = (eq >= 0 ? raw.slice(0, eq) : raw).trim().toLowerCase();
    const value = eq >= 0 ? raw.slice(eq + 1).trim() : '';
    const negated = name.startsWith('~');
    if (negated) name = name.slice(1);

    const mapped = TYPE_MAP[name];
    if (mapped !== undefined) {
      if (mapped === 'unsupported') {
        if (!negated) return `unsupported type: ${name}`;
        continue;
      }
      if (mapped === 'popup') {
        if (negated) continue;
        o.popup = true;
        continue;
      }
      if (mapped === 'document') {
        if (negated) {
          o.excludedTypes.add('main_frame');
          continue;
        }
        o.types.add('main_frame');
        if (exception) o.document = true;
        continue;
      }
      if (mapped === 'all') {
        for (const t of DNR_RESOURCE_TYPES) o.types.add(t);
        o.popup = true;
        continue;
      }
      for (const t of mapped) (negated ? o.excludedTypes : o.types).add(t);
      continue;
    }

    switch (name) {
      case 'third-party':
      case '3p':
      case 'strict3p':
        o.thirdParty = !negated;
        break;
      case 'first-party':
      case '1p':
      case 'strict1p':
        o.thirdParty = negated;
        break;
      case 'domain':
      case 'from': {
        const d = parseDomainList(value, '|');
        if (!d) return `unsupported domain list: ${value}`;
        o.domains.push(...d.pos);
        o.notDomains.push(...d.neg);
        break;
      }
      case 'to': {
        const d = parseDomainList(value, '|');
        if (!d) return `unsupported to= list: ${value}`;
        o.to.push(...d.pos);
        o.notTo.push(...d.neg);
        break;
      }
      case 'denyallow': {
        const d = parseDomainList(value, '|');
        if (!d || d.neg.length) return 'unsupported denyallow';
        o.notTo.push(...d.pos);
        break;
      }
      case 'method':
        for (let m of value.split('|')) {
          m = m.trim().toLowerCase();
          const neg = m.startsWith('~');
          if (neg) m = m.slice(1);
          if (!METHODS.has(m)) return `unsupported method: ${m}`;
          (neg ? o.notMethods : o.methods).push(m);
        }
        break;
      case 'match-case':
        o.matchCase = !negated;
        break;
      case 'important':
        o.important = true;
        break;
      case 'badfilter':
        o.badfilter = true;
        break;
      case 'redirect':
      case 'redirect-rule':
      case 'rewrite':
        o.redirect = name === 'rewrite' ? value : value || 'noop.txt';
        break;
      case 'empty':
        o.redirect = 'noop.txt';
        break;
      case 'mp4':
        o.redirect = 'noop-1s.mp4';
        break;
      case 'removeparam':
      case 'queryprune':
        o.removeparam = value || true;
        break;
      case 'csp':
        if (!value) return 'csp exceptions without value unsupported';
        o.csp = value;
        break;
      case 'inline-script':
        o.csp = "script-src 'self' * 'unsafe-eval' blob: data:";
        break;
      case 'inline-font':
        o.csp = "font-src 'self' * blob: data:";
        break;
      case 'elemhide':
      case 'ehide':
        if (!exception) return 'elemhide on non-exception';
        o.cosmeticFlags.push('elemhide');
        break;
      case 'generichide':
      case 'ghide':
        if (!exception) return 'generichide on non-exception';
        o.cosmeticFlags.push('generichide');
        break;
      case 'specifichide':
      case 'shide':
        if (!exception) return 'specifichide on non-exception';
        o.cosmeticFlags.push('specifichide');
        break;
      default:
        if (NOOP_OPTIONS.has(name)) break;
        return `unsupported option: ${name}`;
    }
  }
  return o;
}

const HOST_LINE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/;
const LOCAL_HOSTS = new Set(['localhost', 'localhost.localdomain', 'local', 'broadcasthost', '0.0.0.0', 'ip6-localhost', 'ip6-loopback']);

/** Parses one network filter line. The caller has already excluded comments and cosmetic filters. */
export function parseNetworkFilter(line: string): ParseResult {
  let raw = line.trim();
  if (!raw) return { ok: false, reason: 'empty' };

  // hosts-file syntax: "0.0.0.0 ads.example.com"
  const hm = HOST_LINE.exec(raw);
  if (hm) {
    const host = hm[1]!.toLowerCase();
    if (LOCAL_HOSTS.has(host)) return { ok: false, reason: 'local host entry' };
    raw = `||${host}^`;
  }

  const exception = raw.startsWith('@@');
  let s = exception ? raw.slice(2) : raw;
  let optionText = '';
  const anchor = findOptionsAnchor(s);
  if (anchor >= 0) {
    optionText = s.slice(anchor + 1);
    s = s.slice(0, anchor);
  }
  const opts = parseOptions(optionText ? splitOptions(optionText) : [], exception);
  if (typeof opts === 'string') return { ok: false, reason: opts };

  let pattern = s;
  let regex = false;
  let hostname: string | undefined;

  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    regex = true;
    pattern = pattern.slice(1, -1);
  } else {
    // Bare hostnames (as in domain lists) behave like ||host^ — uBO semantics.
    if (!/[/*^|]/.test(pattern) && pattern.includes('.') && isValidHostname(pattern)) {
      pattern = `||${pattern}^`;
    }
    const hostOnly = /^\|\|([^/^*|:?#]+)\^?\|?$/.exec(pattern);
    if (hostOnly) {
      const ascii = toAsciiHostname(hostOnly[1]!.toLowerCase());
      if (ascii && isValidHostname(ascii) && ascii.includes('.')) {
        hostname = ascii;
        pattern = `||${ascii}^`;
      }
    }
    if (!opts.matchCase && !hostname) pattern = pattern.toLowerCase();
  }
  // Regex sources are never case-folded: that would change escapes like \D → \d.

  return { ok: true, filter: { raw, exception, pattern, regex, hostname, options: opts } };
}

/** Canonical form used to match `$badfilter` targets. */
export function badfilterKey(f: NetworkFilter): string {
  const o = f.options;
  const parts = [
    f.exception ? '@@' : '',
    f.regex ? `/${f.pattern}/` : f.pattern,
    [...o.types].sort().join('|'),
    [...o.excludedTypes].sort().join('|'),
    o.popup ? 'popup' : '',
    o.thirdParty === undefined ? '' : String(o.thirdParty),
    [...o.domains].sort().join('|'),
    [...o.notDomains].sort().join('|'),
    o.important ? 'imp' : '',
    o.redirect ?? '',
    String(o.removeparam ?? ''),
    o.csp ?? '',
  ];
  return parts.join('\u0001');
}

/** Rejects RE2-incompatible constructs (lookaround, backreferences) and invalid JS regexes. */
export function isRe2Compatible(source: string): boolean {
  if (source.length > 1000) return false;
  if (/\(\?[=!]|\(\?<[=!]|\\[1-9]|\\k<|\(\?[a-z]*[>]/.test(source)) return false;
  try {
    new RegExp(source);
  } catch {
    return false;
  }
  return true;
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

/** Converts a non-ASCII hostname inside a `||host...` urlFilter to punycode. */
function asciiUrlFilter(p: string): string | null {
  if (isAscii(p)) return p;
  const m = /^(\|\|)([^/^*|]+)(.*)$/.exec(p);
  if (!m) return null;
  const host = toAsciiHostname(m[2]!);
  if (!host || !isAscii(m[3]!)) return null;
  return m[1] + host + m[3];
}

export interface ConvertContext {
  /** Priority offset (user filters get PRIORITY.userOffset). */
  priorityOffset: number;
}

export interface ConvertResult {
  rules: DnrRuleBody[];
  popup?: { exception: boolean; filter: PopupFilter };
  cosmeticFlags?: { hostname: string; flags: CosmeticFlag[] };
  /** Hostname eligible for the strict-popup host set. */
  blockHost?: string;
  reason?: string;
}

/** Default resource types for $removeparam (navigation is the important case). */
const REMOVEPARAM_TYPES: DnrResourceType[] = ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'script', 'image'];

/**
 * Converts a parsed network filter into zero or more DNR rules plus side data
 * (popup filters, cosmetic flags).
 */
export function convertNetworkFilter(f: NetworkFilter, ctx: ConvertContext): ConvertResult {
  const o = f.options;
  const out: ConvertResult = { rules: [] };

  // Cosmetic toggles ($elemhide/$generichide/$specifichide) are only meaningful per-hostname.
  if (o.cosmeticFlags.length) {
    if (!f.exception) return { rules: [], reason: 'cosmetic flag on block filter' };
    if (f.hostname) out.cosmeticFlags = { hostname: f.hostname, flags: o.cosmeticFlags };
    else if (o.domains.length === 1 && !o.domains[0]!.endsWith('.*'))
      out.cosmeticFlags = { hostname: o.domains[0]!, flags: o.cosmeticFlags };
    else return { rules: [], reason: 'cosmetic flag with complex pattern' };
    // `@@||site^$generichide` carries no network semantics unless other types are given.
    if (o.types.size === 0 && !o.document && !o.popup) return out;
  }

  if (o.popup) {
    out.popup = {
      exception: f.exception,
      filter: {
        pattern: f.hostname ? '' : f.pattern,
        regex: f.regex || undefined,
        host: f.hostname,
        domains: o.domains.length ? o.domains : undefined,
        notDomains: o.notDomains.length ? o.notDomains : undefined,
        thirdParty: o.thirdParty,
      },
    };
    // A pure $popup filter has no network component.
    if (o.types.size === 0 && o.excludedTypes.size === 0) return out;
  }

  const condition: DnrCondition = {};

  // --- pattern ---
  if (f.regex) {
    if (!isRe2Compatible(f.pattern)) return { ...out, reason: 'regex not RE2-compatible' };
    condition.regexFilter = f.pattern;
  } else if (f.hostname) {
    condition.requestDomains = [f.hostname];
  } else {
    let p = f.pattern;
    // Leading/trailing wildcards are implicit in DNR urlFilter.
    while (p.startsWith('*') && !p.startsWith('*|')) p = p.slice(1);
    while (p.endsWith('*') && p.length > 1) p = p.slice(0, -1);
    if (p === '*') p = '';
    if (p.startsWith('||*')) p = p.slice(2);
    if (p) {
      const ascii = asciiUrlFilter(p);
      if (!ascii) return { ...out, reason: 'non-ASCII pattern' };
      if (/\|/.test(ascii.replace(/^\|\|?/, '').replace(/\|$/, ''))) return { ...out, reason: 'pipe inside pattern' };
      condition.urlFilter = ascii;
    }
  }
  if (o.matchCase && (condition.urlFilter || condition.regexFilter)) condition.isUrlFilterCaseSensitive = true;

  // --- domains ---
  if (o.domains.length) condition.initiatorDomains = expandEntities(o.domains);
  if (o.notDomains.length) condition.excludedInitiatorDomains = expandEntities(o.notDomains);
  if (o.to.length) condition.requestDomains = [...new Set([...(condition.requestDomains ?? []), ...expandEntities(o.to)])];
  if (o.notTo.length) condition.excludedRequestDomains = expandEntities(o.notTo);
  if (o.thirdParty !== undefined) condition.domainType = o.thirdParty ? 'thirdParty' : 'firstParty';
  if (o.methods.length) condition.requestMethods = o.methods;
  if (o.notMethods.length) condition.excludedRequestMethods = o.notMethods;

  // --- resource types ---
  let types = [...o.types];
  const excluded = [...o.excludedTypes];

  // `$document` blocks with domain= are ambiguous (initiator vs. document); skip them.
  if (!f.exception && types.includes('main_frame') && o.domains.length) {
    types = types.filter((t) => t !== 'main_frame');
    if (!types.length) return { ...out, reason: 'document block with domain=' };
  }

  const hasPattern = !!(condition.urlFilter || condition.regexFilter || condition.requestDomains);
  const hasRestriction =
    hasPattern || !!condition.initiatorDomains || !!condition.excludedRequestDomains || types.length > 0;
  // `$removeparam=name` legitimately applies everywhere; everything else needs a restriction.
  if (!hasRestriction && !(o.removeparam !== undefined && o.removeparam !== true && !f.exception))
    return { ...out, reason: 'filter would match every request' };

  const prio = (p: number) => p + ctx.priorityOffset;

  // --- exceptions ---
  if (f.exception) {
    if (o.redirect !== undefined || o.removeparam !== undefined || o.csp !== undefined) {
      // Exceptions that cancel a modifier can't be expressed without also
      // unblocking the request, so they're dropped.
      return { ...out, reason: 'modifier exception unsupported' };
    }
    if (o.document) {
      out.rules.push({
        priority: prio(PRIORITY.allow),
        action: { type: 'allowAllRequests' },
        condition: { ...condition, resourceTypes: ['main_frame', 'sub_frame'] },
      });
      types = types.filter((t) => t !== 'main_frame' && t !== 'sub_frame');
      if (!types.length) return out;
    }
    const c: DnrCondition = { ...condition };
    if (types.length) c.resourceTypes = types;
    if (excluded.length) c.excludedResourceTypes = excluded;
    if (!hasPattern && !c.initiatorDomains && !c.resourceTypes) return { ...out, reason: 'exception matches everything' };
    out.rules.push({ priority: prio(PRIORITY.allow), action: { type: 'allow' }, condition: c });
    return out;
  }

  // --- modifiers ---
  if (o.removeparam !== undefined) {
    const c: DnrCondition = { ...condition, resourceTypes: types.length ? types : REMOVEPARAM_TYPES };
    if (excluded.length) c.excludedResourceTypes = excluded;
    if (o.removeparam === true) {
      out.rules.push({ priority: PRIORITY.removeparam, action: { type: 'redirect', redirect: { transform: { query: '' } } }, condition: c });
    } else {
      const name = o.removeparam;
      if (name.startsWith('/') || name.startsWith('~') || /[|*]/.test(name)) return { ...out, reason: 'regex removeparam unsupported' };
      out.rules.push({
        priority: PRIORITY.removeparam,
        action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [name] } } } },
        condition: c,
      });
    }
    return out;
  }

  if (o.csp !== undefined) {
    if (/report-(?:uri|to)/i.test(o.csp)) return { ...out, reason: 'csp reporting directives not allowed' };
    out.rules.push({
      priority: prio(PRIORITY.csp),
      action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: o.csp }] },
      condition: { ...condition, resourceTypes: ['main_frame', 'sub_frame'] },
    });
    return out;
  }

  if (o.redirect !== undefined) {
    const res = resolveRedirect(o.redirect);
    if (!res) return { ...out, reason: `unknown redirect resource: ${o.redirect}` };
    const c: DnrCondition = { ...condition, resourceTypes: types.length ? types : res.type };
    if (excluded.length) c.excludedResourceTypes = excluded;
    out.rules.push({
      priority: prio(o.important ? PRIORITY.importantRedirect : PRIORITY.redirect),
      action: { type: 'redirect', redirect: { extensionPath: redirectPath(res) } },
      condition: c,
    });
    return out;
  }

  // --- plain block ---
  const c: DnrCondition = { ...condition };
  if (types.length) c.resourceTypes = types;
  if (excluded.length) c.excludedResourceTypes = excluded;
  out.rules.push({ priority: prio(o.important ? PRIORITY.important : PRIORITY.block), action: { type: 'block' }, condition: c });

  if (
    f.hostname &&
    !o.domains.length &&
    !o.notDomains.length &&
    (types.length === 0 || types.includes('main_frame') || types.includes('script'))
  ) {
    out.blockHost = f.hostname;
  }
  return out;
}

/**
 * Converts an ABP URL pattern to a RegExp (used for popup matching and the
 * filter tester; DNR evaluates network rules natively).
 */
export function abpPatternToRegExp(pattern: string, matchCase = false): RegExp {
  let p = pattern;
  let prefix = '';
  let suffix = '';
  if (p.startsWith('||')) {
    prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?';
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    prefix = '^';
    p = p.slice(1);
  }
  if (p.endsWith('|')) {
    suffix = '$';
    p = p.slice(0, -1);
  }
  const body = p
    .replace(/[.+?${}()[\]\\|]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\^/g, '(?:[^\\w\\-.%]|$)');
  return new RegExp(prefix + body + suffix, matchCase ? '' : 'i');
}
