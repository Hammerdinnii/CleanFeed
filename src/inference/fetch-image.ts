/**
 * Fetches image bytes for local analysis.
 *
 * Privacy: the request goes only to the image's own server (the same URL the
 * page already loaded), without cookies (`credentials: 'omit'`) and without a
 * referrer. Nothing about the page or the user is sent anywhere else.
 * Metadata-only reads use a Range request for the first 256 KB.
 */
export const METADATA_RANGE = 256 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface FetchedImage {
  bytes: Uint8Array;
  type: string;
  /** True if we stopped reading before the end of the file. */
  truncated: boolean;
}

export async function fetchImageBytes(url: string, opts: { full: boolean; timeoutMs?: number }): Promise<FetchedImage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const limit = opts.full ? MAX_IMAGE_BYTES : METADATA_RANGE;
    const resp = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: opts.full ? {} : { Range: `bytes=0-${METADATA_RANGE - 1}` },
    });
    if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
    const type = resp.headers.get('content-type') ?? '';
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) throw new Error(`not an image (${type})`);
    const reader = resp.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      return { bytes: buf.subarray(0, limit), type, truncated: buf.length > limit };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= limit) {
        truncated = true;
        void reader.cancel();
        break;
      }
    }
    const out = new Uint8Array(Math.min(total, limit));
    let o = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, out.length - o);
      out.set(c.subarray(0, n), o);
      o += n;
      if (o >= out.length) break;
    }
    return { bytes: out, type, truncated: truncated || resp.status === 206 };
  } finally {
    clearTimeout(timer);
  }
}
