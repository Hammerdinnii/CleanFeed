/** Small, dependency-free helpers shared across contexts. */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Returns the local calendar day as YYYY-MM-DD (used for "today" stats). */
export function dayKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Serializes async tasks: each call waits for the previous one to settle.
 * Used for storage read-modify-write cycles and DNR updates, which must not
 * interleave.
 */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** Least-recently-used map with a fixed capacity. */
export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

/** Splits an array into chunks of at most `size` elements. */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Escapes a literal string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses "/regex/flags" into a RegExp, or builds a case-insensitive literal
 * matcher from plain text. Returns null on invalid regex.
 */
export function toMatcher(pattern: string, opts: { wholeWord?: boolean } = {}): RegExp | null {
  const m = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern);
  try {
    if (m) return new RegExp(m[1]!, m[2]!.includes('i') ? m[2] : m[2] + 'i');
    const lit = escapeRegExp(pattern.trim());
    if (!lit) return null;
    return new RegExp(opts.wholeWord ? `(?:^|\\b)${lit}(?:\\b|$)` : lit, 'i');
  } catch {
    return null;
  }
}

/** Schedules work for idle time with a timeout, falling back to setTimeout. */
export function whenIdle(cb: () => void, timeout = 500): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(cb, { timeout });
  else setTimeout(cb, 16);
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
