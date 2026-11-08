/** 32-bit FNV-1a. Fast, stable, non-cryptographic; used for bucketing and cache keys. */
export function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 52-bit-ish hash rendered as base36: two independent FNV passes, low collision rate. */
export function hashString(str: string): string {
  const a = fnv1a(str);
  const b = fnv1a(str, 0x9747b28c);
  return a.toString(36) + (b & 0xfffff).toString(36);
}

/** SHA-256 hex digest via WebCrypto (available in SW, pages, offscreen docs and Node 20+). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}
