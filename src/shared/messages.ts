import { api } from './api';
import { createLogger, errorMessage } from './log';
import type { EffectiveSiteState } from './settings';
import type {
  AiMode,
  BlockEntry,
  Counts,
  ImageAnalysis,
  KeywordRule,
  ModelManifest,
  SiteOverride,
} from './types';
import type { ProceduralFilter } from '../adblock/procedural';

/**
 * Typed messaging between contexts.
 *
 *   content script ──runtime.sendMessage──▶ background
 *   popup/options  ──runtime.sendMessage──▶ background
 *   background     ──tabs.sendMessage─────▶ content script
 *   background     ──runtime.sendMessage──▶ offscreen document (target: 'offscreen')
 *
 * Every message is wrapped in an envelope so listeners can ignore traffic not
 * meant for them: runtime.sendMessage is delivered to *every* extension page
 * (popup, options, offscreen), so a stray listener answering would race the
 * background's reply.
 */
const log = createLogger('msg');

export type MessageTarget = 'background' | 'offscreen' | 'content';

export interface ContentInit {
  hostname: string;
  state: EffectiveSiteState & { allowlisted: boolean; paused: boolean };
  cosmetic: {
    /** Collect class/id tokens and request matching generic selectors. */
    generic: boolean;
    procedural: ProceduralFilter[];
    /** Attribute used to hide elements found by procedural filters; CSS for it is pre-injected. */
    hideAttr: string;
    /** CSS chunks inserted for this frame (kept so "reveal" can remove them). */
    css: string[];
  };
  feedAds: boolean;
  youtubeVideoAds: boolean;
}

export interface PopupState {
  url: string;
  hostname: string;
  isWeb: boolean;
  enabled: boolean;
  adsEnabled: boolean;
  aiEnabled: boolean;
  site: {
    allowlisted: boolean;
    pausedUntil: number | null;
    override: SiteOverride | null;
    aiMode: AiMode;
    adsActive: boolean;
    aiActive: boolean;
  };
  counts: { page: Counts; today: Counts; session: Counts };
  lists: { enabled: number; rules: number; lastUpdated: number | null; updating: boolean };
  statsEnabled: boolean;
}

export type DataMutation =
  | { op: 'notAi'; key: string; value: boolean }
  | { op: 'blockAuthor'; entry: BlockEntry }
  | { op: 'unblockAuthor'; platform: string; handle: string }
  | { op: 'trustAuthor'; key: string; value: boolean }
  | { op: 'siteOverride'; hostname: string; override: SiteOverride | null }
  | { op: 'allowlist'; hostname: string; value: boolean }
  | { op: 'keywordRule'; id: string; rule: KeywordRule | null };

export interface FilterError {
  line: number;
  text: string;
  message: string;
}

export interface UserFiltersResult {
  ok: boolean;
  errors: FilterError[];
  network: number;
  cosmetic: number;
  dnrRules: number;
}

export interface DnrStatus {
  staticRulesets: { id: string; enabled: boolean }[];
  dynamicRules: number;
  dynamicLimit: number;
  sessionRules: number;
  availableStatic: number | null;
  regexRules: number;
}

export interface ModelStatus {
  installed: boolean;
  manifest: ModelManifest | null;
  backend?: string;
  error?: string;
  available: boolean;
}

/** Request/response pairs, keyed by message type. */
export interface MessageMap {
  // content → background
  'cs:init': { req: { url: string; isTop: boolean }; res: ContentInit | null };
  'cs:generic': { req: { tokens: string[] }; res: { css: string | null } };
  'cs:css': { req: { css: string; remove?: boolean }; res: boolean };
  'cs:count': { req: { elements?: number; ai?: number }; res: void };
  'cs:image': { req: { url: string; metadata: boolean; model: boolean }; res: ImageAnalysis | null };
  'cs:pickerCreate': { req: { filter: string }; res: { ok: boolean; error?: string } };
  'cs:openOptions': { req: { section?: string }; res: void };
  // ui (popup/options) → background
  'ui:popupState': { req: { tabId: number }; res: PopupState | null };
  'ui:pauseSite': { req: { hostname: string; minutes: number | null }; res: void };
  'ui:revealPage': { req: { tabId: number }; res: void };
  'ui:startPicker': { req: { tabId: number }; res: { ok: boolean; error?: string } };
  'ui:listsUpdate': { req: { ids?: string[]; force?: boolean }; res: { updated: string[]; errors: Record<string, string> } };
  'ui:listSet': { req: { id: string; enabled: boolean }; res: { ok: boolean; error?: string } };
  'ui:listAdd': { req: { url: string; name?: string }; res: { ok: boolean; error?: string; id?: string } };
  'ui:listRemove': { req: { id: string }; res: void };
  'ui:userFiltersSave': { req: { text: string }; res: UserFiltersResult };
  'ui:dnrStatus': { req: Record<string, never>; res: DnrStatus };
  'ui:modelChanged': { req: Record<string, never>; res: ModelStatus };
  'ui:modelStatus': { req: Record<string, never>; res: ModelStatus };
  'ui:modelTest': { req: { url?: string }; res: { ok: boolean; score?: number; backend?: string; ms?: number; error?: string } };
  'ui:clearImageCache': { req: Record<string, never>; res: void };
  'ui:communityUpdate': { req: { id?: string }; res: { ok: boolean; errors: Record<string, string> } };
  'ui:resetAll': { req: Record<string, never>; res: void };
  'ui:resetStats': { req: Record<string, never>; res: void };
  // content or ui → background
  'data:mutate': { req: DataMutation; res: { ok: boolean; error?: string } };
  // background → content
  'tab:reveal': { req: Record<string, never>; res: void };
  'tab:counts': { req: Record<string, never>; res: { elements: number; ai: number } };
  'tab:refreshAi': { req: Record<string, never>; res: void };
  // background → offscreen
  'off:analyze': { req: { url: string; metadata: boolean; model: boolean }; res: ImageAnalysis };
  'off:reload': { req: Record<string, never>; res: ModelStatus };
  'off:ping': { req: Record<string, never>; res: boolean };
}

export type MessageType = keyof MessageMap;
export type Req<T extends MessageType> = MessageMap[T]['req'];
export type Res<T extends MessageType> = MessageMap[T]['res'];

interface Envelope {
  __cf: 1;
  type: MessageType;
  payload: unknown;
  target: MessageTarget;
}

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

function isEnvelope(m: unknown): m is Envelope {
  return !!m && typeof m === 'object' && (m as Envelope).__cf === 1 && typeof (m as Envelope).type === 'string';
}

function unwrap<T>(reply: Reply | undefined, type: string): T {
  if (!reply) throw new Error(`No response for ${type}`);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as T;
}

const TRANSIENT = /Receiving end does not exist|Could not establish connection|message port closed/i;

/** Sends a message to the background (or offscreen document) and awaits its reply. */
export async function send<T extends MessageType>(
  type: T,
  payload: Req<T>,
  target: MessageTarget = 'background',
): Promise<Res<T>> {
  const env: Envelope = { __cf: 1, type, payload, target };
  let lastErr: unknown;
  // The MV3 service worker may be (re)starting; retry transient failures briefly.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = (await api.runtime.sendMessage(env)) as Reply | undefined;
      return unwrap<Res<T>>(reply, type);
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.test(errorMessage(err))) break;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(errorMessage(lastErr));
}

/** Like send(), but resolves to `fallback` instead of throwing. */
export async function trySend<T extends MessageType>(
  type: T,
  payload: Req<T>,
  fallback: Res<T>,
  target: MessageTarget = 'background',
): Promise<Res<T>> {
  try {
    return await send(type, payload, target);
  } catch (err) {
    log.debug(`${type} failed:`, errorMessage(err));
    return fallback;
  }
}

/** Sends a message to a tab's content script(s). */
export async function sendToTab<T extends MessageType>(
  tabId: number,
  type: T,
  payload: Req<T>,
  frameId?: number,
): Promise<Res<T> | undefined> {
  const env: Envelope = { __cf: 1, type, payload, target: 'content' };
  try {
    const reply = (await api.tabs.sendMessage(
      tabId,
      env,
      frameId === undefined ? {} : { frameId },
    )) as Reply | undefined;
    return reply ? unwrap<Res<T>>(reply, type) : undefined;
  } catch (err) {
    log.debug(`tab ${tabId} ${type}:`, errorMessage(err));
    return undefined;
  }
}

export type Handler<T extends MessageType> = (
  payload: Req<T>,
  sender: chrome.runtime.MessageSender,
) => Res<T> | Promise<Res<T>>;

export type Handlers = { [T in MessageType]?: Handler<T> };

/**
 * Registers handlers for one context. Only envelopes addressed to `target`
 * are handled; everything else is ignored without responding.
 */
export function listen(target: MessageTarget, handlers: Handlers): void {
  api.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isEnvelope(msg) || msg.target !== target) return false;
    const handler = handlers[msg.type] as Handler<MessageType> | undefined;
    if (!handler) return false;
    let result: unknown;
    try {
      result = handler(msg.payload as never, sender);
    } catch (err) {
      sendResponse({ ok: false, error: errorMessage(err) } satisfies Reply);
      return false;
    }
    if (result instanceof Promise) {
      result.then(
        (data) => sendResponse({ ok: true, data } satisfies Reply),
        (err) => {
          log.warn(`handler ${msg.type} failed:`, err);
          sendResponse({ ok: false, error: errorMessage(err) } satisfies Reply);
        },
      );
      return true; // keep the channel open for the async reply
    }
    sendResponse({ ok: true, data: result } satisfies Reply);
    return false;
  });
}
