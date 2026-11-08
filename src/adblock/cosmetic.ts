import { isValidHostname, toAsciiHostname } from '../shared/domain';
import { parseCosmeticSelector } from './procedural';
import {
  parseAbpSnippets,
  parseAdguardScriptlet,
  parseScriptletCall,
  scriptletKey,
} from './scriptlet-names';
import type { CosmeticEntry } from './types';

/**
 * Cosmetic filter parsing: `##`, `#@#`, `#?#`, `#$#`, `#%#` families and
 * `##+js(...)` scriptlets.
 */

export interface CosmeticParsed {
  domains: string[];
  notDomains: string[];
  /** One filter can yield several entries (ABP `#$#` with multiple snippets). */
  entries: CosmeticEntry[];
  kind: 'cosmetic' | 'scriptlet';
}

export type CosmeticResult = { ok: true; value: CosmeticParsed } | { ok: false; reason: string };

/** Matches the separator of a cosmetic filter; group 1 = domains, group 2 = separator. */
const SEPARATOR = /^([^#]*?)(#@?(?:\$\?|\$|\?|%)?#)/;

/** Quick check used by the line classifier. */
export function isCosmeticLine(line: string): boolean {
  const m = SEPARATOR.exec(line);
  if (!m) return false;
  // Network filters may legitimately contain "#" in URLs (e.g. "||x.com/#ad"), but
  // then the "domains" part would contain "/" or "|".
  return /^[a-z0-9.,~*_\-\u0080-\uffff]*$/i.test(m[1]!.trim());
}

function parseDomains(spec: string): { domains: string[]; notDomains: string[] } | null {
  const domains: string[] = [];
  const notDomains: string[] = [];
  if (!spec.trim()) return { domains, notDomains };
  for (let d of spec.split(',')) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    if (d.startsWith('/') || d.includes('[')) return null; // regex / attribute-domain syntax unsupported
    if (d === '*') continue;
    if (d.endsWith('.*')) {
      const base = toAsciiHostname(d.slice(0, -2));
      if (!base || !isValidHostname(base)) return null;
      (neg ? notDomains : domains).push(`${base}.*`);
      continue;
    }
    const host = toAsciiHostname(d);
    if (!host || !isValidHostname(host)) return null;
    (neg ? notDomains : domains).push(host);
  }
  return { domains, notDomains };
}

export function parseCosmeticFilter(line: string): CosmeticResult {
  const m = SEPARATOR.exec(line);
  if (!m) return { ok: false, reason: 'not a cosmetic filter' };
  const sep = m[2]!;
  const body = line.slice(m[0].length).trim();
  const dom = parseDomains(m[1]!);
  if (!dom) return { ok: false, reason: 'unsupported domain syntax' };
  const exception = sep.includes('@');
  const generic = dom.domains.length === 0;
  if (!body) return { ok: false, reason: 'empty body' };

  // --- scriptlets ---
  if ((sep === '##' || sep === '#@#') && body.startsWith('+js(')) {
    if (!body.endsWith(')')) return { ok: false, reason: 'malformed +js()' };
    const inner = body.slice(4, -1);
    if (exception) {
      // `#@#+js()` disables all scriptlets on the site.
      if (!inner.trim()) return okEntries(dom, [{ t: 'unjs', s: '' }], 'scriptlet');
      const call = parseScriptletCall(inner);
      if (!call) return { ok: false, reason: 'unknown scriptlet' };
      return okEntries(dom, [{ t: 'unjs', s: scriptletKey(call.name, call.args) }], 'scriptlet');
    }
    if (generic) return { ok: false, reason: 'generic scriptlets unsupported' };
    const call = parseScriptletCall(inner);
    if (!call) return { ok: false, reason: 'unknown or trusted scriptlet' };
    return okEntries(dom, [{ t: 'js', s: scriptletKey(call.name, call.args), name: call.name, args: call.args }], 'scriptlet');
  }

  if (sep === '#%#' || sep === '#@%#') {
    const call = parseAdguardScriptlet(body);
    if (!call) return { ok: false, reason: 'AdGuard JS rules unsupported' };
    if (sep === '#@%#') return okEntries(dom, [{ t: 'unjs', s: scriptletKey(call.name, call.args) }], 'scriptlet');
    if (generic) return { ok: false, reason: 'generic scriptlets unsupported' };
    return okEntries(dom, [{ t: 'js', s: scriptletKey(call.name, call.args), name: call.name, args: call.args }], 'scriptlet');
  }

  if (body.startsWith('^')) return { ok: false, reason: 'HTML filtering unsupported in MV3' };

  // --- `#$#`: AdGuard CSS injection ("sel { decl }") or ABP snippets ---
  if (sep === '#$#' || sep === '#@$#' || sep === '#$?#' || sep === '#@$?#') {
    const css = /^(.+?)\s*\{([^{}]*)\}\s*$/.exec(body);
    if (css) {
      const parsed = parseCosmeticSelector(`${css[1]!}:style(${css[2]!.trim()})`);
      if (parsed.kind === 'invalid') return { ok: false, reason: parsed.reason };
      if (generic && !exception) return { ok: false, reason: 'generic :style unsupported' };
      return styleOrProc(dom, parsed, body, exception);
    }
    if (sep !== '#$#' || generic) return { ok: false, reason: 'unsupported #$# rule' };
    const snippets = parseAbpSnippets(body);
    if (!snippets.length) return { ok: false, reason: 'unsupported ABP snippet' };
    return okEntries(
      dom,
      snippets.map((s) => ({ t: 'js', s: scriptletKey(s.name, s.args), name: s.name, args: s.args }) as CosmeticEntry),
      'scriptlet',
    );
  }

  // --- `##`, `#@#`, `#?#`, `#@?#` ---
  const parsed = parseCosmeticSelector(body);
  if (parsed.kind === 'invalid') return { ok: false, reason: parsed.reason };

  if (parsed.kind === 'css') {
    if (exception) return okEntries(dom, [{ t: 'unhide', s: body }], 'cosmetic');
    return okEntries(dom, [{ t: 'hide', s: parsed.selector }], 'cosmetic');
  }
  if (generic && !exception) {
    // Generic procedural / style filters would have to run on every page; uBO refuses them too.
    return { ok: false, reason: 'generic procedural filters unsupported' };
  }
  return styleOrProc(dom, parsed, body, exception);
}

function styleOrProc(
  dom: { domains: string[]; notDomains: string[] },
  parsed: ReturnType<typeof parseCosmeticSelector>,
  body: string,
  exception: boolean,
): CosmeticResult {
  if (exception) return okEntries(dom, [{ t: 'unhide', s: body }], 'cosmetic');
  if (parsed.kind === 'style')
    return okEntries(dom, [{ t: 'style', s: body, sel: parsed.selector, css: parsed.css }], 'cosmetic');
  if (parsed.kind === 'procedural') return okEntries(dom, [{ t: 'proc', s: body, p: parsed.filter }], 'cosmetic');
  return { ok: false, reason: 'unsupported cosmetic filter' };
}

function okEntries(
  dom: { domains: string[]; notDomains: string[] },
  entries: CosmeticEntry[],
  kind: 'cosmetic' | 'scriptlet',
): CosmeticResult {
  return { ok: true, value: { domains: dom.domains, notDomains: dom.notDomains, entries, kind } };
}

/**
 * Extracts the leading `#id` / `.class` token of a generic selector. Generic
 * selectors with a token are injected lazily, only when an element carrying
 * that id/class appears ("low-generic", uBO's approach); others are injected
 * on every page ("high-generic").
 */
export function genericToken(selector: string): string | null {
  const m = /^([#.])((?:[\w-]|\\.)+)(?=$|[\s>+~.#:[,])/.exec(selector);
  if (!m) return null;
  // Selector lists ("a, b") must not be keyed by the first item's token.
  if (hasTopLevelComma(selector)) return null;
  return m[1]! + m[2]!.replace(/\\(.)/g, '$1');
}

function hasTopLevelComma(sel: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) return true;
  }
  return false;
}
