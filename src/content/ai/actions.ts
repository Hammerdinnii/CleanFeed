import { describeVerdict } from '../../ai/scoring';
import type { AiMode, Verdict } from '../../shared/types';

/**
 * Visual treatments for flagged content: collapse, blur, dim, label.
 *
 * The flagged element itself is only given a `data-cleanfeed-ai` attribute;
 * the matching CSS lives in a user-origin stylesheet (see AI_PAGE_CSS). Our UI
 * (bar or badge) is a separate `<cleanfeed-bar>` element inserted *before* the
 * target, rendered in a closed shadow root so page styles can't leak in and
 * page scripts can't poke at it. Removing the attribute and the bar fully
 * restores the original page.
 */
export const AI_ATTR = 'data-cleanfeed-ai';

export const AI_PAGE_CSS = `
[${AI_ATTR}="collapse"]{display:none!important}
[${AI_ATTR}="blur"]{filter:blur(16px) saturate(.6)!important;pointer-events:none!important;user-select:none!important;transition:filter .2s ease!important}
[${AI_ATTR}="blur"] video,[${AI_ATTR}="blur"] img{filter:none!important}
[${AI_ATTR}="dim"]{opacity:.3!important;filter:grayscale(.75)!important;transition:opacity .2s ease!important}
[${AI_ATTR}="dim"]:hover{opacity:.92!important;filter:none!important}
cleanfeed-bar{display:block!important;position:relative!important;z-index:1!important;margin:0!important;padding:0!important;float:none!important;width:auto!important;max-width:100%!important;box-sizing:border-box!important}
`;

export interface ActionHandlers {
  onShow(): void;
  onHideAgain(): void;
  onNotAi(): void;
  onBlockAuthor?: () => void;
  onOpenSettings(): void;
}

export interface ActionOptions {
  mode: AiMode;
  verdict: Verdict;
  showReasons: boolean;
  authorLabel?: string;
  /** Content was revealed by the user ("Show anyway"). */
  revealed: boolean;
}

const SHADOW_CSS = `
:host{all:initial;display:block;contain:content;color:inherit;font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;box-sizing:border-box;width:100%;margin:6px 0;padding:8px 10px;border-radius:10px;
  border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.10);color:inherit}
.chip{display:inline-flex;align-items:center;gap:6px;margin:4px 0;padding:3px 4px 3px 8px;border-radius:999px;
  border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.12);font-size:12px;max-width:100%}
.ico{flex:none;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;
  background:#7c5cff;color:#fff;letter-spacing:-.02em}
.ico.unwanted{background:#e0613a}
.txt{flex:1 1 220px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.chip .txt{flex:0 1 auto;white-space:nowrap}
.title{font-weight:600}
.reason{opacity:.78}
.btns{display:flex;gap:6px;flex:none;align-items:center}
button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;font:600 12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  border:1px solid rgba(127,127,127,.45);color:inherit;background:transparent;white-space:nowrap}
button:hover{background:rgba(127,127,127,.18)}
button:focus-visible{outline:2px solid #7c5cff;outline-offset:1px}
button.primary{background:#7c5cff;border-color:#7c5cff;color:#fff}
button.primary:hover{background:#6a4cf0}
.chip button{padding:2px 8px}
.more{position:relative}
.menu{position:absolute;right:0;top:calc(100% + 4px);min-width:200px;z-index:2147483647;padding:6px;border-radius:10px;
  background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.4);box-shadow:0 8px 24px rgba(0,0,0,.25);display:none}
.menu.open{display:block}
.menu button{display:block;width:100%;box-sizing:border-box;border:none;border-radius:6px;padding:7px 10px;font-weight:500}
.why{flex-basis:100%;margin:2px 0 0 24px;padding:0;list-style:none;font-size:12px;opacity:.85;display:none}
.why.open{display:block}
.why li{margin:2px 0}
.why b{font-weight:600}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One bar/badge instance attached to a flagged target. */
export class ActionUI {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private menuOpen = false;

  constructor(
    private target: Element,
    private handlers: ActionHandlers,
  ) {
    this.host = document.createElement('cleanfeed-bar');
    this.host.setAttribute('data-cleanfeed-ui', '');
    this.root = this.host.attachShadow({ mode: 'closed' });
    // Clicks inside our UI must not trigger the page's own handlers (e.g. opening the post).
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown']) {
      this.host.addEventListener(t, (e) => e.stopPropagation());
    }
  }

  render(opts: ActionOptions): void {
    const { mode, verdict, revealed } = opts;
    const style = el('style');
    style.textContent = SHADOW_CSS;
    const unwanted = verdict.category === 'unwanted';
    const compact = revealed || mode === 'label' || mode === 'dim';
    const wrap = el('div', { class: compact ? 'chip' : 'bar', role: 'note', 'aria-label': 'CleanFeed' });
    const ico = el('span', { class: `ico${unwanted ? ' unwanted' : ''}`, 'aria-hidden': 'true' }, unwanted ? '!' : 'AI');
    const txt = el('span', { class: 'txt' });
    const heading = unwanted
      ? revealed ? 'Shown' : 'Hidden'
      : compact
        ? revealed ? 'Shown · likely AI' : 'Likely AI'
        : mode === 'blur' ? 'Blurred: likely AI-generated' : 'Hidden: likely AI-generated';
    txt.append(el('span', { class: 'title' }, heading));
    if (opts.showReasons) txt.append(el('span', { class: 'reason' }, ` · ${describeVerdict(verdict)}`));
    const detail = verdict.signals.find((s) => s.reason === verdict.reason)?.detail;
    if (detail && opts.showReasons) txt.title = detail;

    const btns = el('span', { class: 'btns' });
    const hidden = !revealed && (mode === 'collapse' || mode === 'blur' || unwanted);
    if (hidden) {
      const show = el('button', { class: 'primary', type: 'button' }, mode === 'blur' && !unwanted ? 'Show' : 'Show anyway');
      show.addEventListener('click', () => this.handlers.onShow());
      btns.append(show);
    } else if (revealed || mode === 'label' || mode === 'dim') {
      const hide = el('button', { type: 'button', title: 'Hide this item' }, revealed ? 'Hide again' : 'Hide');
      hide.addEventListener('click', () => this.handlers.onHideAgain());
      btns.append(hide);
    }
    if (!unwanted) {
      const notAi = el('button', { type: 'button', title: 'Mark as not AI — remembered on this device' }, 'Not AI');
      notAi.addEventListener('click', () => this.handlers.onNotAi());
      btns.append(notAi);
    }

    const more = el('span', { class: 'more' });
    const moreBtn = el('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'More options' }, '⋯');
    const menu = el('div', { class: 'menu', role: 'menu' });
    const why = el('ul', { class: 'why' });
    for (const s of verdict.signals) {
      const li = el('li');
      li.append(el('b', {}, s.reason), document.createTextNode(`${s.detail ? ` — ${s.detail}` : ''} (${Math.round(s.score * 100)}%)`));
      why.append(li);
    }
    const addItem = (label: string, fn: () => void) => {
      const b = el('button', { type: 'button', role: 'menuitem' }, label);
      b.addEventListener('click', () => {
        this.toggleMenu(menu, false);
        fn();
      });
      menu.append(b);
    };
    addItem('Why was this flagged?', () => why.classList.toggle('open'));
    if (this.handlers.onBlockAuthor && opts.authorLabel) addItem(`Block ${opts.authorLabel}`, () => this.handlers.onBlockAuthor!());
    addItem('CleanFeed settings', () => this.handlers.onOpenSettings());
    moreBtn.addEventListener('click', () => this.toggleMenu(menu, !this.menuOpen));
    more.append(moreBtn, menu);
    btns.append(more);

    wrap.append(ico, txt, btns, why);
    this.root.replaceChildren(style, wrap);
  }

  private toggleMenu(menu: HTMLElement, open: boolean): void {
    this.menuOpen = open;
    menu.classList.toggle('open', open);
  }

  /** Inserts the UI before the target (idempotent). */
  attach(): void {
    if (this.host.isConnected && this.host.nextElementSibling === this.target) return;
    this.target.parentNode?.insertBefore(this.host, this.target);
  }

  detach(): void {
    this.host.remove();
  }

  get attachedTo(): Element {
    return this.target;
  }
}

/** Applies the visual treatment attribute; returns the previous value. */
export function setTreatment(target: Element, mode: AiMode | 'unwanted' | null): void {
  if (mode === null || mode === 'label') {
    target.removeAttribute(AI_ATTR);
    return;
  }
  const value = mode === 'unwanted' ? 'collapse' : mode;
  if (target.getAttribute(AI_ATTR) !== value) target.setAttribute(AI_ATTR, value);
  if (value === 'collapse' || value === 'blur') {
    // Don't let hidden/blurred media keep playing.
    for (const v of target.querySelectorAll('video')) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
    }
  }
}
