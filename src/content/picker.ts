/**
 * Element picker ("Hide an element on this page"). Injected on demand.
 * Hover to highlight, click to select, adjust how broad the rule is, then
 * create a cosmetic filter that is saved to "My filters".
 */
import { send } from '../shared/messages';

declare global {
  var __cleanfeedPicker: (() => void) | undefined;
}

(() => {
  globalThis.__cleanfeedPicker?.();

  const host = document.createElement('cleanfeed-picker');
  host.setAttribute('data-cleanfeed-ui', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host{all:initial}
  .hl{position:fixed;pointer-events:none;background:rgba(124,92,255,.22);outline:2px solid #7c5cff;border-radius:3px;transition:all .06s}
  .panel{position:fixed;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));pointer-events:auto;box-sizing:border-box;
    font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#171a25;background:#fff;border:1px solid #e1e4ee;border-radius:14px;
    box-shadow:0 10px 40px rgba(0,0,0,.25);padding:14px}
  @media (prefers-color-scheme:dark){.panel{color:#e8eaf2;background:#171a23;border-color:#2a2f3d}}
  .title{font-weight:700;margin-bottom:6px;display:flex;justify-content:space-between}
  textarea{width:100%;box-sizing:border-box;min-height:56px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;border-radius:8px;border:1px solid #9995;padding:6px;background:transparent;color:inherit;resize:vertical}
  .row{display:flex;gap:8px;align-items:center;margin-top:8px}
  input[type=range]{flex:1}
  button{all:unset;cursor:pointer;padding:6px 12px;border-radius:999px;font-weight:600;border:1px solid #9996}
  button.primary{background:#7c5cff;border-color:#7c5cff;color:#fff}
  .muted{opacity:.7;font-size:12px}
  .hint{opacity:.75}
</style>
<div class="hl" hidden></div>
<div class="panel">
  <div class="title"><span>CleanFeed · Hide an element</span><span class="muted">Esc to cancel</span></div>
  <div class="hint">Hover over the page and click the element to hide.</div>
  <div class="editor" hidden>
    <textarea spellcheck="false" aria-label="Filter"></textarea>
    <div class="row"><span class="muted">Specific</span><input type="range" min="0" max="0" value="0" aria-label="Breadth"><span class="muted">Broad</span></div>
    <div class="row"><span class="muted count"></span><span style="flex:1"></span><button class="repick">Pick again</button><button class="primary create">Create</button></div>
  </div>
  <div class="row"><span style="flex:1"></span><button class="cancel">Cancel</button></div>
</div>`;
  const hl = root.querySelector<HTMLDivElement>('.hl')!;
  const hint = root.querySelector<HTMLDivElement>('.hint')!;
  const editor = root.querySelector<HTMLDivElement>('.editor')!;
  const ta = root.querySelector('textarea')!;
  const range = root.querySelector<HTMLInputElement>('input[type=range]')!;
  const count = root.querySelector<HTMLSpanElement>('.count')!;
  (document.documentElement ?? document.body).append(host);

  let picking = true;
  let selected: Element | null = null;
  let candidates: string[] = [];
  const preview = new Set<Element>();

  const looksRandom = (s: string) => /\d{3,}|[a-z]+[A-Z][a-z]+[A-Z]|^[a-z0-9]{6,}$|__|--[a-z0-9]{4,}|^css-|^sc-|^jsx-/.test(s) && !/^(ad|ads|sponsor|promo|banner)/i.test(s);

  function part(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (el.id && !looksRandom(el.id) && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
    const classes = [...el.classList].filter((c) => !looksRandom(c) && /^[A-Za-z_-][\w-]*$/.test(c)).slice(0, 3);
    if (classes.length) return tag + classes.map((c) => `.${CSS.escape(c)}`).join('');
    for (const attr of ['data-testid', 'data-ad', 'aria-label', 'role', 'name']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) return `${tag}[${attr}="${CSS.escape(v)}"]`;
    }
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) return `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return tag;
  }

  /** Candidate selectors from most specific (full path) to broadest (single part). */
  function buildCandidates(el: Element): string[] {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 6) {
      const p = part(cur);
      parts.unshift(p);
      if (p.startsWith('#')) break;
      cur = cur.parentElement;
    }
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join(' > '));
    return [...new Set(out)];
  }

  function count_(sel: string): number {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return 0;
    }
  }

  function clearPreview() {
    for (const el of preview) (el as HTMLElement).style.removeProperty('outline');
    preview.clear();
  }

  function updateFilter() {
    const sel = candidates[Number(range.value)] ?? '';
    ta.value = `${location.hostname}##${sel}`;
    clearPreview();
    let n = 0;
    try {
      for (const el of document.querySelectorAll(sel)) {
        if (n++ < 200) {
          (el as HTMLElement).style?.setProperty('outline', '2px dashed #e0613a', 'important');
          preview.add(el);
        }
      }
    } catch {
      /* invalid */
    }
    count.textContent = `${n} element${n === 1 ? '' : 's'} match`;
  }

  function onMove(e: MouseEvent) {
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    const r = el.getBoundingClientRect();
    hl.hidden = false;
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function onClick(e: MouseEvent) {
    if (e.composedPath().includes(host)) return;
    if (!picking) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    selected = el;
    picking = false;
    candidates = buildCandidates(el);
    // Default to the broadest candidate that still matches only a few elements.
    let idx = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (count_(candidates[i]!) <= 3) {
        idx = i;
        break;
      }
    }
    range.max = String(Math.max(0, candidates.length - 1));
    range.value = String(idx);
    hint.hidden = true;
    editor.hidden = false;
    updateFilter();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      stop();
    }
  }

  function stop() {
    clearPreview();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    globalThis.__cleanfeedPicker = undefined;
  }

  range.addEventListener('input', updateFilter);
  root.querySelector('.cancel')!.addEventListener('click', stop);
  root.querySelector('.repick')!.addEventListener('click', () => {
    clearPreview();
    picking = true;
    selected = null;
    editor.hidden = true;
    hint.hidden = false;
  });
  root.querySelector('.create')!.addEventListener('click', async () => {
    const filter = ta.value.trim();
    if (!filter) return;
    const sel = filter.slice(filter.indexOf('##') + 2);
    try {
      const r = await send('cs:pickerCreate', { filter });
      if (!r.ok) {
        count.textContent = `Could not create filter: ${r.error}`;
        return;
      }
      try {
        for (const el of document.querySelectorAll(sel)) (el as HTMLElement).style.setProperty('display', 'none', 'important');
      } catch {
        /* procedural filters apply after reload */
      }
      void selected;
      stop();
    } catch (err) {
      count.textContent = String(err);
    }
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  globalThis.__cleanfeedPicker = stop;
})();
