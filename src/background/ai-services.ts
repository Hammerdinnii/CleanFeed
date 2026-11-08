import { parseImageMetadata } from '../ai/detectors/metadata';
import { normalizeHandle } from './data';
import { fetchImageBytes } from '../inference/fetch-image';
import { HAS_ONNX } from '../shared/env';
import { idbClear, idbGet, idbPrune, idbPut } from '../shared/idb';
import { createLogger, errorMessage } from '../shared/log';
import { listen, type ModelStatus } from '../shared/messages';
import { getLocal, setLocal } from '../shared/storage';
import type { BlockEntry, BlockPlatform, CommunityList, ImageAnalysis } from '../shared/types';
import { LRU } from '../shared/util';
import { inferenceHost } from './inference-host';
import { ready } from './state';

/**
 * Background AI services: image analysis queue + cache, model management,
 * community blocklist downloads.
 *
 * Metadata-only analysis runs right here (pure JS parsing of a ranged fetch);
 * model inference is delegated to the inference host so ONNX Runtime is only
 * ever loaded when the user has installed a model.
 */
const log = createLogger('ai');
const MAX_CONCURRENT = 3;
const CACHE_KEEP = 8000;

interface UrlEntry {
  t: number;
  a: ImageAnalysis;
  md: boolean;
  modelId: string | null;
}

const memCache = new LRU<string, UrlEntry>(2000);
const inflight = new Map<string, Promise<ImageAnalysis | null>>();
const queue: (() => void)[] = [];
let running = 0;
let writesSincePrune = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

async function activeModelId(): Promise<string | null> {
  const { modelManifest } = await getLocal(['modelManifest']);
  return modelManifest?.id ?? null;
}

async function analyze(url: string, metadata: boolean, model: boolean): Promise<ImageAnalysis | null> {
  const s = await ready();
  if (!s.settings.enabled || !s.settings.ai.enabled) return null;
  const modelId = model && HAS_ONNX ? await activeModelId() : null;
  const wantModel = !!modelId && s.settings.ai.detectors.imageModel;
  const wantMeta = metadata && s.settings.ai.detectors.metadata;
  if (!wantModel && !wantMeta) return null;

  const key = url;
  const satisfies = (e: UrlEntry | undefined) => !!e && (!wantMeta || e.md) && (!wantModel || e.modelId === modelId);
  const mem = memCache.get(key);
  if (satisfies(mem)) return mem!.a;
  const flightKey = `${url}|${wantMeta}|${wantModel}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing;

  const p = schedule(async () => {
    const stored = await idbGet<UrlEntry>('images', key);
    if (satisfies(stored)) {
      memCache.set(key, stored!);
      return stored!.a;
    }
    let a: ImageAnalysis;
    if (wantModel) {
      a = await inferenceHost.analyze({ url, metadata: wantMeta, model: true, backend: s.settings.ai.imageBackend });
    } else {
      a = { url };
      try {
        const img = await fetchImageBytes(url, { full: false });
        a.metadata = await parseImageMetadata(img.bytes);
      } catch (err) {
        a.error = errorMessage(err);
      }
    }
    const entry: UrlEntry = { t: Date.now(), a, md: wantMeta, modelId: a.model ? modelId : null };
    memCache.set(key, entry);
    if (!a.error) {
      await idbPut('images', key, entry);
      if (++writesSincePrune > 500) {
        writesSincePrune = 0;
        void idbPrune('images', CACHE_KEEP);
        void idbPrune('imageHash', CACHE_KEEP);
      }
    }
    if (a.metadata?.verdict === 'ai') log.debug('metadata AI:', url, a.metadata.evidence);
    return a;
  }).finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, p);
  return p;
}

async function modelStatus(): Promise<ModelStatus> {
  const { modelManifest } = await getLocal(['modelManifest']);
  return { installed: !!modelManifest, manifest: modelManifest ?? null, available: HAS_ONNX };
}

// --- community blocklists -----------------------------------------------------------

const PLATFORM_PREFIX: Record<string, BlockPlatform> = {
  twitter: 'twitter',
  x: 'twitter',
  youtube: 'youtube',
  yt: 'youtube',
  reddit: 'reddit',
  linkedin: 'linkedin',
  web: 'web',
  site: 'web',
  any: 'any',
};

/**
 * Community list format (one entry per line, `#` or `!` comments):
 *   twitter:handle   youtube:@channel   reddit:r/subreddit   reddit:u/user
 *   linkedin:in/name web:example.com    @handle (any platform)
 */
export function parseBlocklistText(text: string, source: string): BlockEntry[] {
  const out: BlockEntry[] = [];
  const seen = new Set<string>();
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+[#!].*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let platform: BlockPlatform = 'any';
    let handle = line;
    const m = /^([a-z]+):(.+)$/i.exec(line);
    if (m && PLATFORM_PREFIX[m[1]!.toLowerCase()]) {
      platform = PLATFORM_PREFIX[m[1]!.toLowerCase()]!;
      handle = m[2]!;
    } else if (/^r\/|^u\//i.test(line)) platform = 'reddit';
    handle = normalizeHandle(platform, handle);
    if (!handle || handle.length > 200) continue;
    const k = `${platform}:${handle}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ platform, handle, added: Date.now(), source });
    if (out.length >= 50_000) break;
  }
  return out;
}

export async function updateCommunityLists(id?: string): Promise<{ ok: boolean; errors: Record<string, string> }> {
  const { communityLists = [] } = await getLocal(['communityLists']);
  const errors: Record<string, string> = {};
  const next: CommunityList[] = [];
  for (const cl of communityLists) {
    if ((id && cl.id !== id) || (!id && !cl.enabled)) {
      next.push(cl);
      continue;
    }
    try {
      const resp = await fetch(cl.url, { cache: 'no-store', credentials: 'omit' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (text.length > 5_000_000) throw new Error('list too large');
      next.push({ ...cl, entries: parseBlocklistText(text, `community:${cl.id}`), lastUpdated: Date.now(), error: undefined });
    } catch (err) {
      errors[cl.id] = errorMessage(err);
      next.push({ ...cl, error: errorMessage(err) });
    }
  }
  await setLocal({ communityLists: next });
  return { ok: !Object.keys(errors).length, errors };
}

export function registerAiServices(): void {
  listen('background', {
    'cs:image': ({ url, metadata, model }) => analyze(url, metadata, model),
    'ui:modelStatus': () => modelStatus(),
    'ui:modelChanged': async () => {
      // Invalidate cached model results; metadata results stay valid.
      memCache.clear();
      const st = await modelStatus();
      if (!st.installed || !HAS_ONNX) return st;
      const s = await ready();
      try {
        const loaded = await inferenceHost.reload(s.settings.ai.imageBackend);
        return { ...st, backend: loaded.backend, error: loaded.error };
      } catch (err) {
        return { ...st, error: errorMessage(err) };
      }
    },
    'ui:modelTest': async () => {
      if (!HAS_ONNX) return { ok: false, error: 'This build was made without ONNX Runtime (--no-onnx).' };
      const s = await ready();
      try {
        return await inferenceHost.test(s.settings.ai.imageBackend);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    'ui:clearImageCache': async () => {
      memCache.clear();
      await idbClear('images');
      await idbClear('imageHash');
    },
    'ui:communityUpdate': ({ id }) => updateCommunityLists(id),
  });
}
