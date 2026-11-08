/**
 * Scriptlet name resolution. Lists reference scriptlets by uBO names, short
 * aliases, ABP snippet names (`#$#`) or AdGuard names (`#%#//scriptlet()`).
 * Everything maps onto the canonical names implemented in scriptlets/runner.ts.
 */
export const SCRIPTLET_ALIASES: Record<string, string> = {
  'abort-on-property-read': 'abort-on-property-read',
  aopr: 'abort-on-property-read',
  'abort-on-property-write': 'abort-on-property-write',
  aopw: 'abort-on-property-write',
  'abort-current-script': 'abort-current-script',
  acs: 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script',
  acis: 'abort-current-script',
  'abort-on-stack-trace': 'abort-on-stack-trace',
  aost: 'abort-on-stack-trace',
  'set-constant': 'set-constant',
  set: 'set-constant',
  'json-prune': 'json-prune',
  'json-prune-fetch-response': 'json-prune-fetch-response',
  'json-prune-xhr-response': 'json-prune-xhr-response',
  'no-settimeout-if': 'no-setTimeout-if',
  nostif: 'no-setTimeout-if',
  'prevent-settimeout': 'no-setTimeout-if',
  'settimeout-defuser': 'no-setTimeout-if',
  'no-setinterval-if': 'no-setInterval-if',
  nosiif: 'no-setInterval-if',
  'prevent-setinterval': 'no-setInterval-if',
  'setinterval-defuser': 'no-setInterval-if',
  'prevent-addeventlistener': 'prevent-addEventListener',
  'addeventlistener-defuser': 'prevent-addEventListener',
  aeld: 'prevent-addEventListener',
  'no-fetch-if': 'no-fetch-if',
  'prevent-fetch': 'no-fetch-if',
  'no-xhr-if': 'no-xhr-if',
  'prevent-xhr': 'no-xhr-if',
  'no-window-open-if': 'no-window-open-if',
  nowoif: 'no-window-open-if',
  'prevent-window-open': 'no-window-open-if',
  'window.open-defuser': 'no-window-open-if',
  'remove-attr': 'remove-attr',
  ra: 'remove-attr',
  'remove-class': 'remove-class',
  rc: 'remove-class',
  'adjust-settimeout': 'adjust-setTimeout',
  'nano-settimeout-booster': 'adjust-setTimeout',
  'nano-stb': 'adjust-setTimeout',
  'adjust-setinterval': 'adjust-setInterval',
  'nano-setinterval-booster': 'adjust-setInterval',
  'nano-sib': 'adjust-setInterval',
  'noeval-if': 'noeval-if',
  'prevent-eval-if': 'noeval-if',
  noeval: 'noeval-if',
  'noeval-silent': 'noeval-if',
  'set-cookie': 'set-cookie',
  'set-local-storage-item': 'set-local-storage-item',
  'set-session-storage-item': 'set-session-storage-item',
  'remove-cookie': 'remove-cookie',
  'cookie-remover': 'remove-cookie',
  'remove-node-text': 'remove-node-text',
  rmnt: 'remove-node-text',
  'set-attr': 'set-attr',
  'disable-newtab-links': 'disable-newtab-links',
  'no-requestanimationframe-if': 'no-requestAnimationFrame-if',
  norafif: 'no-requestAnimationFrame-if',
  'prevent-requestanimationframe': 'no-requestAnimationFrame-if',
  // ABP snippets
  'abp-abort-on-property-read': 'abort-on-property-read',
  'abp-abort-on-property-write': 'abort-on-property-write',
  'abp-abort-current-inline-script': 'abort-current-script',
  'abp-json-prune': 'json-prune',
  'override-property-read': 'set-constant',
  'abp-override-property-read': 'set-constant',
};

export const KNOWN_SCRIPTLETS = new Set(Object.values(SCRIPTLET_ALIASES));

export function canonicalScriptletName(name: string): string | null {
  let n = name.trim().toLowerCase();
  if (n.endsWith('.js')) n = n.slice(0, -3);
  if (n.startsWith('ubo-')) n = n.slice(4);
  return SCRIPTLET_ALIASES[n] ?? null;
}

/**
 * Splits uBO scriptlet arguments: comma-separated, `\,` escapes a comma,
 * surrounding quotes are stripped.
 */
export function splitScriptletArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === ',') {
      cur += ',';
      i++;
      continue;
    }
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if ((c === '"' || c === "'" || c === '`') && cur.trim() === '') {
      quote = c;
      cur = '';
      continue;
    }
    if (c === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Parses the inside of `+js(...)`. */
export function parseScriptletCall(body: string): { name: string; args: string[] } | null {
  const parts = splitScriptletArgs(body);
  const rawName = parts.shift();
  if (!rawName) return null;
  if (/^trusted-/i.test(rawName.replace(/^ubo-/i, ''))) return null; // trusted scriptlets need list trust we don't grant
  const name = canonicalScriptletName(rawName);
  if (!name) return null;
  // Trailing empty args are insignificant.
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return { name, args: parts };
}

/** Parses an ABP snippet line (`name arg1 arg2; name2 ...`). Only the first snippet is kept per call. */
export function parseAbpSnippets(body: string): { name: string; args: string[] }[] {
  const out: { name: string; args: string[] }[] = [];
  for (const part of body.split(';')) {
    const tokens = part.trim().match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\S+/g);
    if (!tokens || !tokens.length) continue;
    const name = canonicalScriptletName(tokens[0]!);
    if (!name) continue;
    out.push({ name, args: tokens.slice(1).map((t) => t.replace(/^['"]|['"]$/g, '')) });
  }
  return out;
}

/** Parses AdGuard `//scriptlet('name', 'arg', ...)`. */
export function parseAdguardScriptlet(body: string): { name: string; args: string[] } | null {
  const m = /^\/\/scriptlet\((.*)\)\s*$/.exec(body.trim());
  if (!m) return null;
  const args = (m[1]!.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) ?? []).map((a) =>
    a.slice(1, -1).replace(/\\(['"])/g, '$1'),
  );
  const rawName = args.shift();
  if (!rawName) return null;
  const name = canonicalScriptletName(rawName);
  return name ? { name, args } : null;
}

/** Stable key identifying a scriptlet call (used for exceptions and dedupe). */
export function scriptletKey(name: string, args: string[]): string {
  return [name, ...args].join(', ');
}
