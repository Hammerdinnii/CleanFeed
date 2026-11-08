/**
 * Minimal DOM helpers for the popup and options page (no framework needed).
 */
type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  style?: string;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
  [attr: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') {
        for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
      } else if (k === 'class') el.className = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

let switchId = 0;
/** Accessible toggle switch row. */
export function toggleRow(label: string, checked: boolean, onChange: (v: boolean) => void, desc?: string, disabled = false): HTMLElement {
  const id = `sw${++switchId}`;
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked, disabled, on: { change: () => onChange(input.checked) } });
  return h(
    'div',
    { class: 'row' },
    h('label', { for: id, class: 'row-text' }, h('span', { class: 'row-label' }, label), desc ? h('span', { class: 'row-desc' }, desc) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'slider', 'aria-hidden': 'true' })),
  );
}

/** Segmented control. */
export function segmented<T extends string>(options: { value: T; label: string; title?: string }[], value: T, onChange: (v: T) => void, label?: string): HTMLElement {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label ?? '' });
  for (const o of options) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(o.value === value), title: o.title ?? '', class: o.value === value ? 'on' : '' }, o.label);
    b.addEventListener('click', () => {
      for (const c of group.children) {
        c.classList.remove('on');
        c.setAttribute('aria-checked', 'false');
      }
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      onChange(o.value);
    });
    group.append(b);
  }
  return group;
}

export function selectEl<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, label?: string): HTMLSelectElement {
  const s = h('select', { 'aria-label': label ?? '' });
  for (const o of options) s.append(h('option', { value: o.value, selected: o.value === value }, o.label));
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = message;
  t.className = `toast show ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.remove('show'), 2600);
}

export function formatNumber(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Applies the theme preference to <html data-theme>. */
export function applyTheme(theme: 'system' | 'light' | 'dark'): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/** Triggers a download of text content. */
export function download(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and resolves with the chosen file (or null). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}
