/**
 * Local image classification with ONNX Runtime Web.
 *
 * Runs in Chrome's offscreen document (service workers can't host ORT: no
 * dynamic import, no DOM-ish APIs) and directly in Firefox's background page.
 * WebGPU is used when available, with a WASM (SIMD) fallback.
 *
 * The model is supplied by the user (imported file or opt-in download) and
 * stored in IndexedDB together with its manifest describing preprocessing
 * and which output is the "AI-generated" class. Nothing leaves the device.
 */
import { parseImageMetadata } from '../ai/detectors/metadata';
import { api } from '../shared/api';
import { sha256Hex } from '../shared/hash';
import { idbGet, idbPut } from '../shared/idb';
import { errorMessage } from '../shared/log';
import type { ImageBackend, ModelStatus } from '../shared/messages';
import type { ImageAnalysis, ModelManifest } from '../shared/types';
import { fetchImageBytes } from './fetch-image';

export interface StoredModel {
  manifest: ModelManifest;
  bytes: ArrayBuffer;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ort = any;
let ort: Ort | null = null;
let session: any = null;
let manifest: ModelManifest | null = null;
let backend = '';
let loadError: string | undefined;
let loading: Promise<ModelStatus> | null = null;
let loadedFor = '';

async function loadOrt(): Promise<Ort> {
  if (ort) return ort;
  const url = api.runtime.getURL('vendor/ort/ort.webgpu.min.mjs');
  const mod = await import(/* webpackIgnore: true */ url);
  ort = mod.default ?? mod;
  ort.env.wasm.wasmPaths = api.runtime.getURL('vendor/ort/');
  // Extension pages aren't cross-origin isolated, so WASM threads are unavailable.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  return ort;
}

function inputDims(m: ModelManifest): [number, number] {
  return Array.isArray(m.inputSize) ? m.inputSize : [m.inputSize, m.inputSize];
}

export async function loadModel(preferred: ImageBackend): Promise<ModelStatus> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const stored = await idbGet<StoredModel>('models', 'active');
      if (!stored) {
        await unloadModel();
        return { installed: false, manifest: null, available: true };
      }
      const key = `${stored.manifest.id}:${stored.manifest.sha256 ?? stored.bytes.byteLength}:${preferred}`;
      if (session && loadedFor === key) return status();
      await unloadModel();
      const o = await loadOrt();
      const bytes = new Uint8Array(stored.bytes);
      const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
      const order: string[][] = preferred === 'wasm' || !gpu ? [['wasm']] : [['webgpu'], ['wasm']];
      let lastErr: unknown;
      for (const eps of order) {
        try {
          session = await o.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: 'all' });
          backend = eps[0]!;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!session) throw lastErr ?? new Error('could not create session');
      manifest = stored.manifest;
      loadedFor = key;
      loadError = undefined;
      return status();
    } catch (err) {
      loadError = errorMessage(err);
      return status();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function unloadModel(): Promise<void> {
  try {
    await session?.release?.();
  } catch {
    /* ignore */
  }
  session = null;
  manifest = null;
  backend = '';
  loadedFor = '';
}

export function status(): ModelStatus {
  return {
    installed: !!manifest || !!loadError,
    manifest,
    backend: backend || undefined,
    error: loadError,
    available: true,
  };
}

/** Resizes and normalizes an image into the model's input tensor. */
async function preprocess(blob: Blob, m: ModelManifest): Promise<Float32Array> {
  const [H, W] = inputDims(m);
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    if (m.resize === 'center-crop') {
      const scale = Math.max(W / bmp.width, H / bmp.height);
      const sw = W / scale;
      const sh = H / scale;
      ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, W, H);
    } else {
      ctx.drawImage(bmp, 0, 0, W, H);
    }
    const px = ctx.getImageData(0, 0, W, H).data;
    const out = new Float32Array(3 * H * W);
    const plane = H * W;
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) {
        const v = (px[i * 4 + c]! / 255 - m.mean[c]!) / m.std[c]!;
        if (m.layout === 'NCHW') out[c * plane + i] = v;
        else out[i * 3 + c] = v;
      }
    }
    return out;
  } finally {
    bmp.close();
  }
}

function aiProbability(data: Float32Array | number[], m: ModelManifest): number {
  const arr = Array.from(data as ArrayLike<number>);
  if (m.output === 'sigmoid') {
    const p = 1 / (1 + Math.exp(-arr[0]!));
    return m.aiIndex === 0 ? p : 1 - p;
  }
  if (m.output === 'probabilities') return arr[m.aiIndex] ?? 0;
  const max = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return (exps[m.aiIndex] ?? 0) / sum;
}

async function runModel(blob: Blob, preferred: ImageBackend): Promise<ImageAnalysis['model']> {
  await loadModel(preferred);
  if (!session || !manifest || !ort) return undefined;
  const t0 = performance.now();
  const input = await preprocess(blob, manifest);
  const [H, W] = inputDims(manifest);
  const dims = manifest.layout === 'NCHW' ? [1, 3, H, W] : [1, H, W, 3];
  const feeds: Record<string, unknown> = {
    [manifest.inputName ?? session.inputNames[0]]: new ort.Tensor('float32', input, dims),
  };
  const results = await session.run(feeds);
  const out = results[manifest.outputName ?? session.outputNames[0]];
  const score = aiProbability(out.data, manifest);
  return { score, modelId: manifest.id, backend, ms: Math.round(performance.now() - t0) };
}

interface HashEntry {
  t: number;
  a: ImageAnalysis;
  modelId: string | null;
  md: boolean;
}

/**
 * Full analysis: fetch, hash, metadata and/or model. Results are cached by
 * content hash, so the same image under different URLs is analyzed once.
 */
export async function analyzeImage(req: { url: string; metadata: boolean; model: boolean; backend: ImageBackend }): Promise<ImageAnalysis> {
  const out: ImageAnalysis = { url: req.url };
  try {
    const img = await fetchImageBytes(req.url, { full: req.model });
    const sha = await sha256Hex(img.bytes);
    out.sha256 = sha;
    const modelId = req.model ? ((await idbGet<StoredModel>('models', 'active'))?.manifest.id ?? null) : null;
    const cached = await idbGet<HashEntry>('imageHash', sha);
    if (cached && (!req.metadata || cached.md) && (!req.model || cached.modelId === modelId)) {
      return { ...cached.a, url: req.url };
    }
    if (req.metadata) out.metadata = await parseImageMetadata(img.bytes);
    if (req.model && !img.truncated) {
      out.model = await runModel(new Blob([img.bytes as BlobPart], { type: img.type || 'image/jpeg' }), req.backend);
    }
    await idbPut('imageHash', sha, { t: Date.now(), a: out, modelId: out.model ? modelId : null, md: req.metadata } satisfies HashEntry);
  } catch (err) {
    out.error = errorMessage(err);
  }
  return out;
}

/** Sanity check: runs the model on a synthetic gradient image. */
export async function testModel(preferred: ImageBackend): Promise<{ ok: boolean; score?: number; backend?: string; ms?: number; error?: string }> {
  const st = await loadModel(preferred);
  if (!session || !manifest) return { ok: false, error: st.error ?? 'No model installed' };
  try {
    const c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 256, 256);
    g.addColorStop(0, '#3060c0');
    g.addColorStop(1, '#f0c040');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const r = await runModel(blob, preferred);
    return { ok: true, score: r?.score, backend: r?.backend, ms: r?.ms };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
