import type { ProceduralAction, ProceduralFilter, ProceduralTask, TextMatch } from '../../adblock/procedural';

/**
 * Executes compiled procedural cosmetic filters (see adblock/procedural.ts)
 * against the live DOM. Each task maps a set of elements to a new set.
 */
const reCache = new Map<string, RegExp>();

function toRe(tm: TextMatch): RegExp {
  const key = tm.flags + '/' + tm.re;
  let re = reCache.get(key);
  if (!re) {
    try {
      re = new RegExp(tm.re, tm.flags);
    } catch {
      re = /(?!)/;
    }
    reCache.set(key, re);
  }
  return re;
}

function qsa(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function spath(el: Element, text: string): Element[] {
  const t = text.trim();
  if (t.startsWith('+') || t.startsWith('~')) {
    const rest = t.slice(1).trim();
    const out: Element[] = [];
    for (let s = el.nextElementSibling; s; s = s.nextElementSibling) {
      try {
        if (s.matches(rest)) out.push(s);
      } catch {
        return [];
      }
      if (t.startsWith('+')) break;
    }
    return out;
  }
  // Descendant (" x") or child ("> x") combinators.
  return qsa(el, `:scope ${t.startsWith('>') ? t : ' ' + t}`);
}

function applyTasks(start: Element[], tasks: readonly ProceduralTask[]): Element[] {
  let cur = start;
  for (const task of tasks) {
    if (!cur.length) return cur;
    const next: Element[] = [];
    switch (task[0]) {
      case 'spath':
        for (const el of cur) next.push(...spath(el, task[1]));
        break;
      case 'matches':
        for (const el of cur) {
          try {
            if (el.matches(task[1])) next.push(el);
          } catch {
            /* invalid */
          }
        }
        break;
      case 'has-text': {
        const re = toRe(task[1]);
        for (const el of cur) if (re.test(el.textContent ?? '')) next.push(el);
        break;
      }
      case 'min-text-length':
        for (const el of cur) if ((el.textContent ?? '').length >= task[1]) next.push(el);
        break;
      case 'upward': {
        const arg = task[1];
        for (const el of cur) {
          let p: Element | null = null;
          if (typeof arg === 'number') {
            p = el;
            for (let i = 0; i < arg && p; i++) p = p.parentElement;
          } else {
            try {
              p = el.parentElement?.closest(arg) ?? null;
            } catch {
              p = null;
            }
          }
          if (p && p !== document.documentElement && p !== document.body) next.push(p);
        }
        break;
      }
      case 'xpath':
        for (const el of cur) {
          try {
            const res = document.evaluate(task[1], el, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < res.snapshotLength; i++) {
              const n = res.snapshotItem(i);
              if (n && n.nodeType === 1) next.push(n as Element);
            }
          } catch {
            /* invalid xpath */
          }
        }
        break;
      case 'matches-css': {
        const { pseudo, name, value } = task[1];
        const re = toRe(value);
        for (const el of cur) {
          const v = getComputedStyle(el, pseudo).getPropertyValue(name);
          if (re.test(v)) next.push(el);
        }
        break;
      }
      case 'matches-attr': {
        const { name, value } = task[1];
        const nre = toRe(name);
        const vre = value ? toRe(value) : null;
        for (const el of cur) {
          for (const a of el.attributes) {
            if (nre.test(a.name) && (!vre || vre.test(a.value))) {
              next.push(el);
              break;
            }
          }
        }
        break;
      }
      case 'matches-path':
        if (toRe(task[1]).test(location.pathname + location.search)) next.push(...cur);
        break;
      case 'matches-media':
        try {
          if (matchMedia(task[1]).matches) next.push(...cur);
        } catch {
          /* invalid query */
        }
        break;
      case 'has':
        for (const el of cur) if (runRelative(task[1], el).length) next.push(el);
        break;
      case 'not':
        for (const el of cur) if (!selfMatches(task[1], el)) next.push(el);
        break;
      case 'watch-attr':
        next.push(...cur);
        break;
    }
    cur = next;
  }
  return cur;
}

/** Nested filter evaluated relative to `ctx` (used by :has()). */
function runRelative(f: ProceduralFilter, ctx: Element): Element[] {
  const sel = f.selector.trim();
  let start: Element[];
  if (!sel) start = [ctx];
  else if (/^[>+~]/.test(sel)) start = spath(ctx, sel);
  else start = qsa(ctx, sel);
  return applyTasks(start, f.tasks);
}

/** Whether `el` itself satisfies a nested filter (used by :not()). */
function selfMatches(f: ProceduralFilter, el: Element): boolean {
  const sel = f.selector.trim();
  if (sel) {
    try {
      if (!el.matches(sel)) return false;
    } catch {
      return false;
    }
  }
  return applyTasks([el], f.tasks).length > 0;
}

/** Runs a top-level procedural filter on the document. */
export function runProcedural(f: ProceduralFilter, root: ParentNode = document): Element[] {
  const start = f.selector ? qsa(root, f.selector) : [document.documentElement];
  return [...new Set(applyTasks(start, f.tasks))];
}

/** Attributes the filters ask us to watch (for :watch-attr). */
export function watchedAttributes(filters: readonly ProceduralFilter[]): string[] {
  const out = new Set<string>();
  const visit = (f: ProceduralFilter) => {
    for (const t of f.tasks) {
      if (t[0] === 'watch-attr') for (const a of t[1]) out.add(a);
      if (t[0] === 'has' || t[0] === 'not') visit(t[1]);
    }
  };
  filters.forEach(visit);
  return [...out];
}

function parseDeclarations(css: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    out.push([part.slice(0, i).trim(), part.slice(i + 1).replace(/!important/i, '').trim()]);
  }
  return out;
}

export interface AppliedAction {
  el: Element;
  undo: () => void;
}

/** Applies a filter's action to one element; returns an undo handle (except for removals). */
export function applyAction(el: Element, action: ProceduralAction, hideAttr: string): AppliedAction | null {
  switch (action[0]) {
    case 'hide':
      if (el.hasAttribute(hideAttr)) return null;
      el.setAttribute(hideAttr, '');
      return { el, undo: () => el.removeAttribute(hideAttr) };
    case 'remove':
      el.remove();
      return null;
    case 'style': {
      const s = (el as HTMLElement).style;
      if (!s) return null;
      const prev = s.cssText;
      for (const [k, v] of parseDeclarations(action[1])) s.setProperty(k, v, 'important');
      return { el, undo: () => (s.cssText = prev) };
    }
    case 'remove-attr': {
      const re = toRe(action[1]);
      for (const a of [...el.attributes]) if (re.test(a.name)) el.removeAttribute(a.name);
      return null;
    }
    case 'remove-class': {
      const re = toRe(action[1]);
      for (const c of [...el.classList]) if (re.test(c)) el.classList.remove(c);
      return null;
    }
  }
}
