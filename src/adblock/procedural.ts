/**
 * Procedural cosmetic filter parser (uBO / ABP / AdGuard extended syntax).
 *
 * Plain CSS selectors are applied through stylesheets. Selectors that use
 * procedural operators (`:has-text()`, `:upward()`, `:xpath()`, …) or DOM
 * actions (`:remove()`, `:remove-attr()`) can't be expressed in CSS, so they
 * compile to a small JSON program that the content script executes
 * (see content/cosmetic/procedural-exec.ts).
 *
 * The parser runs at list-compile time (build or background), so content
 * scripts only receive validated, pre-parsed programs.
 */

export interface TextMatch {
  /** RegExp source. Literal text is escaped into a regex at parse time. */
  re: string;
  flags: string;
}

export type ProceduralTask =
  | ['spath', string]
  | ['matches', string]
  | ['has-text', TextMatch]
  | ['upward', number | string]
  | ['xpath', string]
  | ['matches-css', { pseudo: string | null; name: string; value: TextMatch }]
  | ['matches-attr', { name: TextMatch; value: TextMatch | null }]
  | ['matches-path', TextMatch]
  | ['matches-media', string]
  | ['min-text-length', number]
  | ['has', ProceduralFilter]
  | ['not', ProceduralFilter]
  | ['watch-attr', string[]];

export type ProceduralAction =
  | ['hide']
  | ['remove']
  | ['style', string]
  | ['remove-attr', TextMatch]
  | ['remove-class', TextMatch];

export interface ProceduralFilter {
  /** Original selector text (used as exception key). */
  raw: string;
  /** Initial CSS selector; empty means "relative to the context element" (nested filters). */
  selector: string;
  tasks: ProceduralTask[];
  action: ProceduralAction;
}

export type CosmeticSelector =
  | { kind: 'css'; selector: string }
  | { kind: 'style'; selector: string; css: string }
  | { kind: 'procedural'; filter: ProceduralFilter }
  | { kind: 'invalid'; reason: string };

const OPERATORS: Record<string, string> = {
  'has-text': 'has-text',
  contains: 'has-text',
  '-abp-contains': 'has-text',
  upward: 'upward',
  'nth-ancestor': 'upward',
  xpath: 'xpath',
  'matches-css': 'matches-css',
  'matches-css-before': 'matches-css-before',
  'matches-css-after': 'matches-css-after',
  'matches-attr': 'matches-attr',
  'matches-path': 'matches-path',
  'matches-media': 'matches-media',
  'min-text-length': 'min-text-length',
  'watch-attr': 'watch-attr',
  has: 'has',
  '-abp-has': 'has',
  if: 'has',
  not: 'not',
  'if-not': 'not',
};

const ACTIONS = new Set(['style', 'remove', 'remove-attr', 'remove-class']);

/** CSS declarations we refuse to inject: anything that can trigger network loads or script. */
const UNSAFE_CSS = /url\s*\(|image-set\s*\(|@import|expression\s*\(|javascript:|\\|behavior\s*:|-moz-binding/i;

export function isSafeDeclaration(css: string): boolean {
  if (!css.trim()) return false;
  if (/[{}]/.test(css) || css.includes('/*')) return false;
  return !UNSAFE_CSS.test(css);
}

/** Scans `s` from index `start` (just after "(") to the matching ")" honoring quotes & escapes. */
function findClosingParen(s: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Basic structural validation of a CSS selector without a DOM. */
export function looksLikeValidSelector(sel: string): boolean {
  if (!sel.trim()) return false;
  let paren = 0;
  let bracket = 0;
  let quote: string | null = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      // Anything goes inside quoted attribute values, e.g. [style^="width:1px;"].
      if (c === quote) quote = null;
      continue;
    }
    // Outside quotes these could break out of the rule and inject arbitrary CSS.
    if (c === '{' || c === '}' || c === ';' || (c === '/' && sel[i + 1] === '*')) return false;
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (paren < 0 || bracket < 0) return false;
  }
  return paren === 0 && bracket === 0 && quote === null;
}

/** Parses "text" or "/regex/flags" into a TextMatch. */
export function parseTextMatch(arg: string): TextMatch | null {
  let a = arg.trim();
  if ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))) a = a.slice(1, -1);
  const m = /^\/(.+)\/([imsu]*)$/.exec(a);
  if (m) {
    try {
      new RegExp(m[1]!, m[2]);
      return { re: m[1]!, flags: m[2]! };
    } catch {
      return null;
    }
  }
  if (!a) return null;
  return { re: a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: '' };
}

interface Segment {
  op: string | null; // null = CSS text
  arg: string;
}

/** Splits a selector into CSS text and top-level pseudo-operators we care about. */
function tokenize(sel: string): Segment[] | null {
  const segs: Segment[] = [];
  let css = '';
  let bracket = 0;
  let quote: string | null = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!;
    if (c === '\\') {
      css += c + (sel[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      css += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      css += c;
      continue;
    }
    if (c === '[') bracket++;
    if (c === ']') bracket--;
    if (c === ':' && bracket === 0 && sel[i + 1] !== ':') {
      const m = /^:(-?[a-z][a-z0-9-]*)\(/i.exec(sel.slice(i));
      if (m) {
        const name = m[1]!.toLowerCase();
        const open = i + m[0].length;
        const close = findClosingParen(sel, open);
        if (close < 0) return null;
        const arg = sel.slice(open, close);
        const isProc = name in OPERATORS || ACTIONS.has(name);
        // Native :has()/:not() stay CSS unless their argument is procedural.
        const nativeOk = (name === 'has' || name === 'not') && !containsProcedural(arg);
        if (isProc && !nativeOk) {
          if (css) segs.push({ op: null, arg: css });
          css = '';
          segs.push({ op: name, arg });
          i = close;
          continue;
        }
        css += sel.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    css += c;
  }
  if (css) segs.push({ op: null, arg: css });
  return segs;
}

function containsProcedural(arg: string): boolean {
  const segs = tokenize(arg);
  if (!segs) return true;
  return segs.some((s) => s.op !== null);
}

/**
 * Parses a cosmetic selector body. Returns plain CSS when possible so the
 * cheap stylesheet path is used.
 */
export function parseCosmeticSelector(raw: string, nested = false): CosmeticSelector {
  const sel = raw.trim();
  if (!sel) return { kind: 'invalid', reason: 'empty selector' };
  const segs = tokenize(sel);
  if (!segs) return { kind: 'invalid', reason: 'unbalanced parentheses' };

  // Fast path: pure CSS.
  if (segs.every((s) => s.op === null)) {
    if (!looksLikeValidSelector(sel)) return { kind: 'invalid', reason: 'invalid selector' };
    return { kind: 'css', selector: sel };
  }

  // Trailing action operator.
  let action: ProceduralAction = ['hide'];
  const last = segs[segs.length - 1]!;
  if (last.op && ACTIONS.has(last.op)) {
    segs.pop();
    switch (last.op) {
      case 'style':
        if (!isSafeDeclaration(last.arg)) return { kind: 'invalid', reason: 'unsafe :style()' };
        action = ['style', last.arg.trim()];
        break;
      case 'remove':
        if (last.arg.trim()) return { kind: 'invalid', reason: ':remove() takes no argument' };
        action = ['remove'];
        break;
      case 'remove-attr':
      case 'remove-class': {
        const tm = parseTextMatch(last.arg);
        if (!tm) return { kind: 'invalid', reason: `bad ${last.op}` };
        action = [last.op, tm];
        break;
      }
    }
    if (segs.some((s) => s.op && ACTIONS.has(s.op))) return { kind: 'invalid', reason: 'action must be last' };
  }

  // `selector:style(...)` with plain CSS selector → stylesheet rule.
  if (action[0] === 'style' && segs.every((s) => s.op === null) && !nested) {
    const s = segs.map((x) => x.arg).join('').trim();
    if (!looksLikeValidSelector(s)) return { kind: 'invalid', reason: 'invalid selector' };
    return { kind: 'style', selector: s, css: action[1] };
  }

  let selector = '';
  const tasks: ProceduralTask[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.op === null) {
      const text = seg.arg;
      if (i === 0) {
        selector = text.trim();
        if (selector && !looksLikeValidSelector(selector) && !/^[>+~]/.test(selector))
          return { kind: 'invalid', reason: 'invalid selector' };
      } else if (/^\s/.test(text) || /^[>+~]/.test(text.trim())) {
        tasks.push(['spath', text]);
      } else {
        tasks.push(['matches', text]);
      }
      continue;
    }
    const op = OPERATORS[seg.op];
    const arg = seg.arg;
    switch (op) {
      case 'has-text': {
        const tm = parseTextMatch(arg);
        if (!tm) return { kind: 'invalid', reason: 'bad :has-text()' };
        tasks.push(['has-text', tm]);
        break;
      }
      case 'upward': {
        const t = arg.trim();
        if (/^\d+$/.test(t)) {
          const n = Number(t);
          if (n < 1 || n > 256) return { kind: 'invalid', reason: 'bad :upward()' };
          tasks.push(['upward', n]);
        } else {
          if (!looksLikeValidSelector(t)) return { kind: 'invalid', reason: 'bad :upward()' };
          tasks.push(['upward', t]);
        }
        break;
      }
      case 'xpath':
        if (!arg.trim()) return { kind: 'invalid', reason: 'empty :xpath()' };
        tasks.push(['xpath', arg.trim()]);
        break;
      case 'matches-css':
      case 'matches-css-before':
      case 'matches-css-after': {
        const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i.exec(arg);
        if (!m) return { kind: 'invalid', reason: 'bad :matches-css()' };
        const tm = parseTextMatch(m[2]!);
        if (!tm) return { kind: 'invalid', reason: 'bad :matches-css() value' };
        const pseudo = op === 'matches-css' ? null : op === 'matches-css-before' ? '::before' : '::after';
        tasks.push(['matches-css', { pseudo, name: m[1]!.toLowerCase(), value: tm }]);
        break;
      }
      case 'matches-attr': {
        const m = /^\s*("[^"]*"|'[^']*'|\/.+?\/[imsu]*|[^=\s]+)\s*(?:=\s*(.+?))?\s*$/.exec(arg);
        if (!m) return { kind: 'invalid', reason: 'bad :matches-attr()' };
        const name = parseTextMatch(m[1]!);
        const value = m[2] !== undefined ? parseTextMatch(m[2]) : null;
        if (!name || (m[2] !== undefined && !value)) return { kind: 'invalid', reason: 'bad :matches-attr()' };
        tasks.push(['matches-attr', { name, value }]);
        break;
      }
      case 'matches-path': {
        const tm = parseTextMatch(arg);
        if (!tm) return { kind: 'invalid', reason: 'bad :matches-path()' };
        tasks.push(['matches-path', tm]);
        break;
      }
      case 'matches-media':
        tasks.push(['matches-media', arg.trim()]);
        break;
      case 'min-text-length': {
        const n = Number(arg.trim());
        if (!Number.isFinite(n) || n < 0) return { kind: 'invalid', reason: 'bad :min-text-length()' };
        tasks.push(['min-text-length', n]);
        break;
      }
      case 'watch-attr':
        tasks.push(['watch-attr', arg.split(',').map((a) => a.trim()).filter(Boolean)]);
        break;
      case 'has':
      case 'not': {
        const inner = parseCosmeticSelector(arg, true);
        let nested: ProceduralFilter;
        if (inner.kind === 'invalid') return inner;
        if (inner.kind === 'css') nested = { raw: arg, selector: inner.selector, tasks: [], action: ['hide'] };
        else if (inner.kind === 'procedural') nested = inner.filter;
        else return { kind: 'invalid', reason: ':style inside :has()' };
        tasks.push([op, nested]);
        break;
      }
      default:
        return { kind: 'invalid', reason: `unknown operator :${seg.op}` };
    }
  }

  if (!selector && !nested && tasks[0]?.[0] !== 'xpath') {
    return { kind: 'invalid', reason: 'procedural filter needs a leading selector' };
  }
  return { kind: 'procedural', filter: { raw: sel, selector, tasks, action } };
}
