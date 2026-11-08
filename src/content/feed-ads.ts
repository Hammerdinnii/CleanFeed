import { trySend } from '../shared/messages';
import type { SiteAdapter } from '../sites/adapters';
import { domReady, domWatcher } from './dom-watcher';

/**
 * Hides promoted posts in social feeds using the site adapter's
 * `isPromoted()` logic (text badges like "Ad"/"Promoted" that filter lists
 * can't target reliably) plus its ad-container selector.
 *
 * Elements are hidden with the per-page random attribute whose CSS the
 * background injected as a user stylesheet; "reveal" removes it.
 */
export class FeedAdHider {
  private hidden = new Set<Element>();
  private checked = new WeakSet<Element>();
  private unsub: (() => void) | null = null;
  private revealed = false;

  constructor(
    private adapter: SiteAdapter,
    private hideAttr: string,
  ) {}

  start(): void {
    if (!this.adapter.isPromoted && !this.adapter.feedAdSelector) return;
    void domReady().then(() => this.scan(document));
    this.unsub = domWatcher.subscribe((added) => {
      for (const root of added) this.scan(root);
    });
  }

  private scan(root: ParentNode): void {
    if (this.revealed) return;
    let newly = 0;
    const sel = this.adapter.feedAdSelector;
    if (sel) {
      const els = root instanceof Element && root.matches(sel) ? [root] : [];
      for (const el of [...els, ...root.querySelectorAll(sel)]) newly += this.hide(el);
    }
    if (this.adapter.isPromoted) {
      const items = root instanceof Element && root.matches(this.adapter.itemSelector) ? [root] : [];
      for (const el of [...items, ...root.querySelectorAll(this.adapter.itemSelector)]) {
        if (this.checked.has(el)) continue;
        // Promoted badges can render a moment after the item; re-check items once later.
        this.check(el);
      }
    }
    if (newly) void trySend('cs:count', { elements: newly }, undefined);
  }

  private check(el: Element, retry = true): void {
    if (this.adapter.isPromoted!(el)) {
      this.checked.add(el);
      const target = this.adapter.adTarget?.(el) ?? this.adapter.target?.(el) ?? el;
      if (this.hide(target)) void trySend('cs:count', { elements: 1 }, undefined);
    } else if (retry) {
      setTimeout(() => this.check(el, false), 1200);
    } else {
      this.checked.add(el);
    }
  }

  private hide(el: Element): number {
    if (this.revealed || el.hasAttribute(this.hideAttr)) return 0;
    el.setAttribute(this.hideAttr, '');
    this.hidden.add(el);
    return 1;
  }

  reveal(): void {
    this.revealed = true;
    this.unsub?.();
    for (const el of this.hidden) el.removeAttribute(this.hideAttr);
    this.hidden.clear();
  }
}
