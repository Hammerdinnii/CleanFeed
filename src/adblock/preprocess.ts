/**
 * Filter-list preprocessor: evaluates uBO/AdGuard `!#if` blocks and records
 * `!#include` directives.
 *
 * Conditions are boolean expressions over environment tokens (`env_chromium`,
 * `env_firefox`, `cap_html_filtering`, `adguard`, …) with !, &&, || and
 * parentheses. Unknown tokens evaluate to false, which is what uBO does and
 * keeps blocks aimed at other blockers out.
 */
export type PreprocessEnv = Record<string, boolean>;

export function defaultEnv(target: 'chrome' | 'firefox'): PreprocessEnv {
  return {
    env_chromium: target === 'chrome',
    env_edge: false,
    env_firefox: target === 'firefox',
    env_mobile: false,
    env_safari: false,
    env_mv3: true,
    ext_ublock: true,
    ext_ubol: true,
    ext_devbuild: false,
    cap_html_filtering: false,
    cap_user_stylesheet: true,
    cap_ipaddress: false,
    false: false,
    true: true,
    adguard: false,
    adguard_app_windows: false,
    adguard_ext_chromium: false,
    adguard_ext_firefox: false,
  };
}

export interface PreprocessResult {
  lines: string[];
  /** Included paths in order, with the index in `lines` where they should be spliced. */
  includes: { path: string; at: number }[];
}

export function evaluateCondition(expr: string, env: PreprocessEnv): boolean {
  const tokens = expr.match(/!|&&|\|\||\(|\)|[A-Za-z0-9_]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function parseOr(): boolean {
    let v = parseAnd();
    while (peek() === '||') {
      next();
      const r = parseAnd();
      v = v || r;
    }
    return v;
  }
  function parseAnd(): boolean {
    let v = parseUnary();
    while (peek() === '&&') {
      next();
      const r = parseUnary();
      v = v && r;
    }
    return v;
  }
  function parseUnary(): boolean {
    const t = peek();
    if (t === '!') {
      next();
      return !parseUnary();
    }
    if (t === '(') {
      next();
      const v = parseOr();
      if (peek() === ')') next();
      return v;
    }
    next();
    return t !== undefined && env[t] === true;
  }
  try {
    return parseOr();
  } catch {
    return false;
  }
}

export function preprocess(text: string, env: PreprocessEnv): PreprocessResult {
  const raw = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  const includes: { path: string; at: number }[] = [];
  // Stack of { active: is this branch currently emitting, parentActive }
  const stack: { active: boolean; parent: boolean; taken: boolean }[] = [];
  const isActive = () => (stack.length === 0 ? true : stack[stack.length - 1]!.active);

  for (const line of raw) {
    if (line.startsWith('!#')) {
      const m = /^!#(if|else|endif|include)\b\s*(.*)$/.exec(line.trim());
      if (m) {
        const [, kw, arg] = m;
        if (kw === 'if') {
          const parent = isActive();
          const cond = evaluateCondition(arg ?? '', env);
          stack.push({ active: parent && cond, parent, taken: cond });
        } else if (kw === 'else') {
          const top = stack[stack.length - 1];
          if (top) top.active = top.parent && !top.taken;
        } else if (kw === 'endif') {
          stack.pop();
        } else if (kw === 'include' && isActive() && arg) {
          includes.push({ path: arg.trim(), at: lines.length });
        }
        continue;
      }
    }
    if (isActive()) lines.push(line);
  }
  return { lines, includes };
}

/** Parsed list header metadata (first comment block). */
export interface ListHeader {
  title?: string;
  version?: string;
  expiresHours?: number;
  homepage?: string;
  lastModified?: string;
}

export function parseHeader(lines: readonly string[]): ListHeader {
  const h: ListHeader = {};
  const max = Math.min(lines.length, 60);
  for (let i = 0; i < max; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('!') && !line.startsWith('#') && !line.startsWith('[')) {
      if (line) break;
      continue;
    }
    const m = /^[!#]\s*([A-Za-z -]+?)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'title') h.title = val;
    else if (key === 'version') h.version = val;
    else if (key === 'homepage') h.homepage = val;
    else if (key === 'last modified' || key === 'updated') h.lastModified = val;
    else if (key === 'expires') {
      const e = /(\d+)\s*(day|hour|d|h)/i.exec(val);
      if (e) {
        const n = Number(e[1]);
        h.expiresHours = /^d/i.test(e[2]!) ? n * 24 : n;
      }
    }
  }
  return h;
}
