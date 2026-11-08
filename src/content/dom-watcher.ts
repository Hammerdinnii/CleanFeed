/**
 * One shared, throttled MutationObserver for every content-side feature.
 *
 * Features subscribe with a callback receiving the batch of *element* roots
 * added since the last flush. Batches are delivered at most every `minDelay`
 * ms, backing off to `maxDelay` while the page mutates continuously (infinite
 * scroll, live feeds), which bounds CPU use on busy pages.
 */
export type BatchCallback = (added: Element[]) => void;

class DomWatcher {
  private subs = new Set<BatchCallback>();
  private pending: Element[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private delay = 60;
  private lastFlush = 0;
  private readonly minDelay = 60;
  private readonly maxDelay = 300;

  subscribe(cb: BatchCallback): () => void {
    this.subs.add(cb);
    this.start();
    return () => this.subs.delete(cb);
  }

  private start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n.nodeType === 1) this.pending.push(n as Element);
      }
      if (this.pending.length) this.schedule();
    });
    this.observer.observe(document, { childList: true, subtree: true });
  }

  private schedule(): void {
    if (this.timer) return;
    const now = performance.now();
    // Back off if flushes are happening back to back.
    this.delay = now - this.lastFlush < this.maxDelay ? Math.min(this.maxDelay, this.delay * 1.5) : this.minDelay;
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  /** Delivers the pending batch immediately. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lastFlush = performance.now();
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    // Drop nodes that were removed again or are contained in another added root.
    const roots = new Set<Element>();
    for (const el of batch) if (el.isConnected) roots.add(el);
    const deduped: Element[] = [];
    for (const el of roots) {
      let p = el.parentElement;
      let nested = false;
      while (p) {
        if (roots.has(p)) {
          nested = true;
          break;
        }
        p = p.parentElement;
      }
      if (!nested) deduped.push(el);
    }
    for (const cb of this.subs) {
      try {
        cb(deduped);
      } catch (err) {
        console.warn('[CleanFeed] watcher subscriber failed', err);
      }
    }
  }
}

export const domWatcher = new DomWatcher();

/** Resolves once the DOM is parsed (or immediately if it already is). */
export function domReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((r) => document.addEventListener('DOMContentLoaded', () => r(), { once: true }));
}
