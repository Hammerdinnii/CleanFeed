import { api } from '../shared/api';
import { createLogger, errorMessage } from '../shared/log';
import { send, type ImageBackend, type ModelStatus } from '../shared/messages';
import type { ImageAnalysis } from '../shared/types';

/**
 * Where model inference runs:
 *  - Chrome: an offscreen document (created on demand, closed when idle).
 *  - Firefox: the background page itself, which has the needed DOM APIs;
 *    the engine module is imported lazily so ORT only loads when used.
 */
const log = createLogger('inference');
const IDLE_CLOSE_MS = 5 * 60_000;

type Engine = typeof import('../inference/engine');
type TestResult = { ok: boolean; score?: number; backend?: string; ms?: number; error?: string };

export interface InferenceHost {
  analyze(req: { url: string; metadata: boolean; model: boolean; backend: ImageBackend }): Promise<ImageAnalysis>;
  reload(backend: ImageBackend): Promise<ModelStatus>;
  test(backend: ImageBackend): Promise<TestResult>;
}

class OffscreenHost implements InferenceHost {
  private creating: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private async hasDocument(): Promise<boolean> {
    const rt = api.runtime as unknown as { getContexts?(f: { contextTypes: string[] }): Promise<unknown[]> };
    if (rt.getContexts) return (await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
    return false;
  }

  private async ensure(): Promise<void> {
    this.touch();
    if (await this.hasDocument()) return;
    if (!this.creating) {
      const offscreen = (api as unknown as { offscreen: { createDocument(o: object): Promise<void> } }).offscreen;
      this.creating = offscreen
        .createDocument({
          url: 'offscreen/offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Runs the local ONNX image classifier and parses image metadata on-device.',
        })
        .catch((err: unknown) => {
          // Another call may have created it concurrently.
          if (!/single offscreen|already/i.test(errorMessage(err))) throw err;
        })
        .finally(() => {
          this.creating = null;
        });
    }
    await this.creating;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
  }

  private async close(): Promise<void> {
    try {
      if (await this.hasDocument()) await (api as unknown as { offscreen: { closeDocument(): Promise<void> } }).offscreen.closeDocument();
    } catch (err) {
      log.debug('close offscreen', errorMessage(err));
    }
  }

  async analyze(req: Parameters<InferenceHost['analyze']>[0]): Promise<ImageAnalysis> {
    await this.ensure();
    return send('off:analyze', req, 'offscreen');
  }

  async reload(backend: ImageBackend): Promise<ModelStatus> {
    await this.ensure();
    return send('off:reload', { backend }, 'offscreen');
  }

  async test(backend: ImageBackend): Promise<TestResult> {
    await this.ensure();
    return send('off:test', { backend }, 'offscreen');
  }
}

class InPageHost implements InferenceHost {
  private engine: Promise<Engine> | null = null;
  private load(): Promise<Engine> {
    // Dynamic import is fine in Firefox's background *page* (it is not a service worker).
    this.engine ??= import(/* webpackIgnore: true */ api.runtime.getURL('inference/engine.js')) as Promise<Engine>;
    return this.engine;
  }
  async analyze(req: Parameters<InferenceHost['analyze']>[0]): Promise<ImageAnalysis> {
    return (await this.load()).analyzeImage(req);
  }
  async reload(backend: ImageBackend): Promise<ModelStatus> {
    return (await this.load()).loadModel(backend);
  }
  async test(backend: ImageBackend): Promise<TestResult> {
    return (await this.load()).testModel(backend);
  }
}

// `__TARGET__` is replaced by a string literal at build time, so the unused
// host (and the Firefox-only dynamic import, which service workers forbid) is
// removed from the Chrome bundle entirely.
declare const __TARGET__: string;
export const inferenceHost: InferenceHost = __TARGET__ === 'firefox' ? new InPageHost() : new OffscreenHost();
