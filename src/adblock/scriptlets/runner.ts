/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Scriptlet runtime, executed in the page's MAIN world via
 * `scripting.executeScript({ func: scriptletRunner, world: 'MAIN' })`.
 *
 * IMPORTANT: this function is serialized with Function.prototype.toString()
 * and re-evaluated in the page, so it must be completely self-contained — no
 * imports, no references to module-level bindings, no build helpers. Every
 * scriptlet is an inner function. All code here is part of the extension
 * package (filter lists only supply names and arguments), which keeps it
 * compliant with the MV3 remote-code policy.
 *
 * Behaviour follows the uBlock Origin scriptlets of the same names closely
 * enough for list compatibility, but the implementations are independent and
 * intentionally simpler.
 */
export function scriptletRunner(calls: [string, string[]][]): void {
  const win = window as any;
  const MAGIC = 'cf-' + Math.random().toString(36).slice(2, 9);
  const nativeJsonParse = JSON.parse;
  const nativeStringify = JSON.stringify;
  const objectDefineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const reflectApply = Reflect.apply;
  let errorHandlerInstalled = false;

  /** Converts "/re/flags", "!negated" or literal text into a tester. */
  function toTester(pattern: string | undefined): (s: string) => boolean {
    let p = pattern ?? '';
    let negate = false;
    if (p.startsWith('!')) {
      negate = true;
      p = p.slice(1);
    }
    let re: RegExp | null = null;
    if (p === '' || p === '*') {
      re = null;
    } else {
      const m = /^\/(.+)\/([imsu]*)$/.exec(p);
      try {
        re = m ? new RegExp(m[1]!, m[2]) : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      } catch {
        re = /^\b$/; // never matches
      }
    }
    return (s: string) => {
      const hit = re === null ? true : re.test(s);
      return negate ? !hit : hit;
    };
  }

  function installErrorSilencer() {
    if (errorHandlerInstalled) return;
    errorHandlerInstalled = true;
    win.addEventListener(
      'error',
      (ev: ErrorEvent) => {
        if (typeof ev.message === 'string' && ev.message.includes(MAGIC)) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  function abortError(): never {
    installErrorSilencer();
    throw new ReferenceError(MAGIC);
  }

  /**
   * Walks a dotted property chain, trapping not-yet-defined links so the
   * final property can be intercepted whenever the chain gets created.
   */
  function trapChain(owner: any, chain: string, finalize: (owner: any, prop: string) => void): void {
    const dot = chain.indexOf('.');
    if (dot === -1) {
      finalize(owner, chain);
      return;
    }
    const prop = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    let value = owner[prop];
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      trapChain(value, rest, finalize);
      return;
    }
    const desc = getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    try {
      objectDefineProperty(owner, prop, {
        configurable: true,
        enumerable: true,
        get() {
          return value;
        },
        set(nv) {
          value = nv;
          if (nv !== null && (typeof nv === 'object' || typeof nv === 'function')) trapChain(nv, rest, finalize);
        },
      });
    } catch {
      /* non-extensible owner */
    }
  }

  function defineSafely(owner: any, prop: string, desc: PropertyDescriptor): void {
    const cur = getOwnPropertyDescriptor(owner, prop);
    if (cur && cur.configurable === false) return;
    try {
      objectDefineProperty(owner, prop, { configurable: true, ...desc });
    } catch {
      /* ignore */
    }
  }

  // --- property path helpers for json-prune ---------------------------------
  function eachTarget(obj: any, path: string[], cb: (owner: any, key: string) => void): void {
    if (obj === null || typeof obj !== 'object') return;
    const [head, ...rest] = path;
    if (head === undefined) return;
    if (head === '[]' || head === '*') {
      const keys = Array.isArray(obj) ? obj.map((_, i) => String(i)) : Object.keys(obj);
      for (const k of keys) {
        if (rest.length === 0) cb(obj, k);
        else eachTarget(obj[k], rest, cb);
      }
      return;
    }
    if (!(head in obj)) return;
    if (rest.length === 0) cb(obj, head);
    else eachTarget(obj[head], rest, cb);
  }

  function hasPath(obj: any, path: string): boolean {
    let found = false;
    eachTarget(obj, path.split('.'), () => {
      found = true;
    });
    return found;
  }

  function makePruner(propsToRemove: string, required: string): (obj: any) => any {
    const remove = (propsToRemove ?? '').split(/\s+/).filter(Boolean);
    const req = (required ?? '').split(/\s+/).filter(Boolean);
    return (obj: any) => {
      try {
        if (obj === null || typeof obj !== 'object' || remove.length === 0) return obj;
        if (req.length && !req.every((p) => hasPath(obj, p))) return obj;
        for (const p of remove) {
          eachTarget(obj, p.split('.'), (owner, key) => {
            try {
              delete owner[key];
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* never break the page */
      }
      return obj;
    };
  }

  function extraArgs(args: string[], from: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = from; i + 1 < args.length; i += 2) out[args[i]!] = args[i + 1]!;
    return out;
  }

  function fnText(fn: unknown): string {
    try {
      return typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
    } catch {
      return '';
    }
  }

  function safeValue(raw: string | undefined): { ok: boolean; value?: any } {
    const v = raw ?? '';
    switch (v) {
      case 'undefined':
        return { ok: true, value: undefined };
      case 'false':
        return { ok: true, value: false };
      case 'true':
        return { ok: true, value: true };
      case 'null':
        return { ok: true, value: null };
      case "''":
      case '':
      case 'emptyStr':
        return { ok: true, value: '' };
      case 'noopFunc':
        return { ok: true, value: function () {} };
      case 'trueFunc':
        return { ok: true, value: () => true };
      case 'falseFunc':
        return { ok: true, value: () => false };
      case 'throwFunc':
        return {
          ok: true,
          value: () => {
            throw new Error(MAGIC);
          },
        };
      case 'emptyArr':
      case '[]':
        return { ok: true, value: [] };
      case 'emptyObj':
      case '{}':
        return { ok: true, value: {} };
      case 'noopPromiseResolve':
        return { ok: true, value: () => Promise.resolve() };
      case 'noopPromiseReject':
        return { ok: true, value: () => Promise.reject() };
    }
    if (/^-?\d{1,6}(\.\d+)?$/.test(v)) return { ok: true, value: Number(v) };
    if (/^(yes|no|on|off|ok|accept|accepted|reject|rejected|allowed|denied|necessary|required|1|0)$/i.test(v))
      return { ok: true, value: v };
    return { ok: false };
  }

  function onDomReady(fn: () => void): void {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function observeDom(fn: () => void, durationMs: number | null): void {
    let scheduled = false;
    const run = () => {
      scheduled = false;
      try {
        fn();
      } catch {
        /* ignore */
      }
    };
    const mo = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(run);
    });
    const start = () => {
      mo.observe(document.documentElement ?? document, { childList: true, subtree: true, attributes: true });
      if (durationMs !== null) setTimeout(() => mo.disconnect(), durationMs);
    };
    if (document.documentElement) start();
    else document.addEventListener('readystatechange', start, { once: true });
  }

  // --- scriptlets -----------------------------------------------------------
  const impl: Record<string, (...a: string[]) => void> = {
    'abort-on-property-read'(chain) {
      if (!chain) return;
      trapChain(win, chain, (owner, prop) => {
        defineSafely(owner, prop, { get: abortError, set() {} });
      });
    },

    'abort-on-property-write'(prop) {
      if (!prop) return;
      trapChain(win, prop, (owner, p) => {
        defineSafely(owner, p, { set: abortError });
      });
    },

    'abort-current-script'(chain, needle, context) {
      if (!chain) return;
      const matchesNeedle = toTester(needle);
      const matchesContext = toTester(context);
      const check = () => {
        const s = document.currentScript as HTMLScriptElement | null;
        if (!(s instanceof HTMLScriptElement)) return;
        const text = s.src ? s.src : s.textContent ?? '';
        if (context && !matchesContext(s.src || location.href)) return;
        if (matchesNeedle(text)) abortError();
      };
      trapChain(win, chain, (owner, prop) => {
        const desc = getOwnPropertyDescriptor(owner, prop);
        let value = owner[prop];
        defineSafely(owner, prop, {
          get() {
            check();
            return desc && desc.get ? desc.get.call(this) : value;
          },
          set(v) {
            check();
            if (desc && desc.set) desc.set.call(this, v);
            else value = v;
          },
        });
      });
    },

    'abort-on-stack-trace'(chain, needle) {
      if (!chain || !needle) return;
      const matches = toTester(needle);
      const check = () => {
        const stack = new Error().stack ?? '';
        if (matches(stack)) abortError();
      };
      trapChain(win, chain, (owner, prop) => {
        let value = owner[prop];
        defineSafely(owner, prop, {
          get() {
            check();
            return value;
          },
          set(v) {
            check();
            value = v;
          },
        });
      });
    },

    'set-constant'(chain, rawValue) {
      if (!chain) return;
      const sv = safeValue(rawValue);
      if (!sv.ok) return;
      const value = sv.value;
      trapChain(win, chain, (owner, prop) => {
        defineSafely(owner, prop, {
          enumerable: true,
          get() {
            return value;
          },
          set() {},
        });
      });
    },

    'json-prune'(props, required) {
      const prune = makePruner(props!, required!);
      JSON.parse = new Proxy(nativeJsonParse, {
        apply(target, thisArg, args) {
          return prune(reflectApply(target, thisArg, args));
        },
      });
      const proto = (win.Response as typeof Response | undefined)?.prototype;
      if (proto) {
        const nativeJson = proto.json;
        proto.json = new Proxy(nativeJson, {
          apply(target, thisArg, args) {
            return (reflectApply(target, thisArg, args) as Promise<unknown>).then(prune);
          },
        });
      }
    },

    'json-prune-fetch-response'(props, required, ...rest) {
      const prune = makePruner(props!, required!);
      const extra = extraArgs(rest, 0);
      const urlMatch = toTester(extra['propsToMatch'] ?? extra['url'] ?? '');
      const nativeFetch = win.fetch;
      if (typeof nativeFetch !== 'function') return;
      win.fetch = new Proxy(nativeFetch, {
        apply(target, thisArg, args) {
          const p = reflectApply(target, thisArg, args) as Promise<Response>;
          let url = '';
          try {
            url = args[0] instanceof Request ? args[0].url : String(args[0]);
          } catch {
            /* ignore */
          }
          if (!urlMatch(url)) return p;
          return p.then((resp) =>
            resp
              .clone()
              .text()
              .then((text) => {
                let obj: unknown;
                try {
                  obj = nativeJsonParse(text);
                } catch {
                  return resp;
                }
                const out = new Response(nativeStringify(prune(obj)), {
                  status: resp.status,
                  statusText: resp.statusText,
                  headers: resp.headers,
                });
                try {
                  objectDefineProperty(out, 'url', { value: resp.url });
                  objectDefineProperty(out, 'redirected', { value: resp.redirected });
                } catch {
                  /* ignore */
                }
                return out;
              })
              .catch(() => resp),
          );
        },
      });
    },

    'json-prune-xhr-response'(props, required, ...rest) {
      const prune = makePruner(props!, required!);
      const extra = extraArgs(rest, 0);
      const urlMatch = toTester(extra['propsToMatch'] ?? extra['url'] ?? '');
      const Native = win.XMLHttpRequest as typeof XMLHttpRequest;
      if (!Native) return;
      const urls = new WeakMap<XMLHttpRequest, string>();
      const cache = new WeakMap<XMLHttpRequest, { text: string; json: unknown }>();
      const proto = Native.prototype;
      const nativeOpen = proto.open;
      proto.open = function (this: XMLHttpRequest, ...args: any[]) {
        urls.set(this, String(args[1]));
        return reflectApply(nativeOpen, this, args);
      } as typeof proto.open;
      const rDesc = getOwnPropertyDescriptor(proto, 'response');
      const tDesc = getOwnPropertyDescriptor(proto, 'responseText');
      const pruned = (xhr: XMLHttpRequest): { text: string; json: unknown } | null => {
        if (xhr.readyState !== 4 || !urlMatch(urls.get(xhr) ?? '')) return null;
        const c = cache.get(xhr);
        if (c) return c;
        const raw = tDesc?.get && (xhr.responseType === '' || xhr.responseType === 'text') ? tDesc.get.call(xhr) : rDesc?.get?.call(xhr);
        let obj: unknown = raw;
        if (typeof raw === 'string') {
          try {
            obj = nativeJsonParse(raw);
          } catch {
            return null;
          }
        }
        if (obj === null || typeof obj !== 'object') return null;
        prune(obj);
        const out = { text: nativeStringify(obj), json: obj };
        cache.set(xhr, out);
        return out;
      };
      if (rDesc?.get) {
        objectDefineProperty(proto, 'response', {
          ...rDesc,
          get() {
            const p = pruned(this);
            if (!p) return rDesc.get!.call(this);
            return this.responseType === 'json' ? p.json : p.text;
          },
        });
      }
      if (tDesc?.get) {
        objectDefineProperty(proto, 'responseText', {
          ...tDesc,
          get() {
            const p = pruned(this);
            return p ? p.text : tDesc.get!.call(this);
          },
        });
      }
    },

    'no-setTimeout-if'(needle, delay) {
      const matches = toTester(needle);
      const delayTest = delay ? toTester(delay.startsWith('!') ? delay : `/^${delay}$/`) : () => true;
      win.setTimeout = new Proxy(win.setTimeout, {
        apply(target, thisArg, args) {
          const [fn, ms] = args;
          if (matches(fnText(fn)) && delayTest(String(ms ?? 0))) {
            return reflectApply(target, thisArg, [function () {}, ms]);
          }
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'no-setInterval-if'(needle, delay) {
      const matches = toTester(needle);
      const delayTest = delay ? toTester(delay.startsWith('!') ? delay : `/^${delay}$/`) : () => true;
      win.setInterval = new Proxy(win.setInterval, {
        apply(target, thisArg, args) {
          const [fn, ms] = args;
          if (matches(fnText(fn)) && delayTest(String(ms ?? 0))) {
            return reflectApply(target, thisArg, [function () {}, ms]);
          }
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'adjust-setTimeout'(needle, delay, boost) {
      const matches = toTester(needle);
      const d = delay ? Number(delay) : 1000;
      let b = boost ? Number(boost) : 0.05;
      if (!Number.isFinite(b) || b < 0.001) b = 0.05;
      if (b > 50) b = 50;
      win.setTimeout = new Proxy(win.setTimeout, {
        apply(target, thisArg, args) {
          const [fn, ms] = args;
          if (matches(fnText(fn)) && (Number.isNaN(d) || Number(ms) === d)) args[1] = Number(ms) * b;
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'adjust-setInterval'(needle, delay, boost) {
      const matches = toTester(needle);
      const d = delay ? Number(delay) : 1000;
      let b = boost ? Number(boost) : 0.05;
      if (!Number.isFinite(b) || b < 0.001) b = 0.05;
      if (b > 50) b = 50;
      win.setInterval = new Proxy(win.setInterval, {
        apply(target, thisArg, args) {
          const [fn, ms] = args;
          if (matches(fnText(fn)) && (Number.isNaN(d) || Number(ms) === d)) args[1] = Number(ms) * b;
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'no-requestAnimationFrame-if'(needle) {
      const matches = toTester(needle);
      win.requestAnimationFrame = new Proxy(win.requestAnimationFrame, {
        apply(target, thisArg, args) {
          if (matches(fnText(args[0]))) return reflectApply(target, thisArg, [function () {}]);
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'prevent-addEventListener'(type, needle) {
      const typeMatch = toTester(type);
      const needleMatch = toTester(needle);
      const proto = EventTarget.prototype;
      proto.addEventListener = new Proxy(proto.addEventListener, {
        apply(target, thisArg, args) {
          const [t, handler] = args;
          let text = '';
          try {
            text = typeof handler === 'function' ? fnText(handler) : handler && typeof handler.handleEvent === 'function' ? fnText(handler.handleEvent) : String(handler);
          } catch {
            /* ignore */
          }
          if (typeMatch(String(t)) && needleMatch(text)) return undefined;
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'no-fetch-if'(conditions) {
      const nativeFetch = win.fetch;
      if (typeof nativeFetch !== 'function') return;
      const tests: { key: string; test: (s: string) => boolean }[] = [];
      for (const part of (conditions ?? '').split(/\s+/).filter(Boolean)) {
        const i = part.indexOf(':');
        if (i > 0 && /^[a-z]+$/i.test(part.slice(0, i))) tests.push({ key: part.slice(0, i), test: toTester(part.slice(i + 1)) });
        else tests.push({ key: 'url', test: toTester(part) });
      }
      if (tests.length === 0) tests.push({ key: 'url', test: () => true });
      win.fetch = new Proxy(nativeFetch, {
        apply(target, thisArg, args) {
          const details: Record<string, string> = { url: '', method: 'GET', body: '' };
          try {
            const [input, init] = args;
            if (input instanceof Request) {
              details.url = input.url;
              details.method = input.method;
            } else details.url = String(input);
            if (init) {
              if (init.method) details.method = String(init.method);
              if (typeof init.body === 'string') details.body = init.body;
            }
          } catch {
            /* ignore */
          }
          if (tests.every((t) => t.test(details[t.key] ?? ''))) {
            return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
          }
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'no-xhr-if'(pattern) {
      const matches = toTester(pattern);
      const Native = win.XMLHttpRequest as typeof XMLHttpRequest;
      if (!Native) return;
      const proto = Native.prototype;
      const blocked = new WeakSet<XMLHttpRequest>();
      const nativeOpen = proto.open;
      const nativeSend = proto.send;
      proto.open = function (this: XMLHttpRequest, ...args: any[]) {
        if (matches(String(args[1]))) blocked.add(this);
        return reflectApply(nativeOpen, this, args);
      } as typeof proto.open;
      proto.send = function (this: XMLHttpRequest, ...args: any[]) {
        if (!blocked.has(this)) return reflectApply(nativeSend, this, args);
        const xhr = this;
        try {
          objectDefineProperty(xhr, 'readyState', { value: 4, configurable: true });
          objectDefineProperty(xhr, 'status', { value: 200, configurable: true });
          objectDefineProperty(xhr, 'statusText', { value: 'OK', configurable: true });
          objectDefineProperty(xhr, 'response', { value: '', configurable: true });
          objectDefineProperty(xhr, 'responseText', { value: '', configurable: true });
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          for (const t of ['readystatechange', 'load', 'loadend']) xhr.dispatchEvent(new Event(t));
        }, 1);
        return undefined;
      } as typeof proto.send;
    },

    'no-window-open-if'(pattern, delay, decoy) {
      const matches = toTester(pattern);
      const nativeOpen = win.open;
      win.open = new Proxy(nativeOpen, {
        apply(target, thisArg, args) {
          const url = String(args[0] ?? '');
          if (!matches(url)) return reflectApply(target, thisArg, args);
          if (decoy) {
            // Some sites check the return value; hand back an inert window-like object.
            return new Proxy(
              {},
              {
                get(_t, prop) {
                  if (prop === 'closed') return false;
                  if (prop === 'document') return document.implementation.createHTMLDocument('');
                  return typeof prop === 'string' && /^(close|focus|blur|postMessage)$/.test(prop) ? () => {} : undefined;
                },
                set() {
                  return true;
                },
              },
            );
          }
          void delay;
          return null;
        },
      });
    },

    'noeval-if'(needle) {
      const matches = toTester(needle);
      win.eval = new Proxy(win.eval, {
        apply(target, thisArg, args) {
          if (matches(String(args[0] ?? ''))) return undefined;
          return reflectApply(target, thisArg, args);
        },
      });
    },

    'remove-attr'(attrs, selector, behavior) {
      const names = (attrs ?? '').split(/\s*\|\s*/).filter(Boolean);
      if (!names.length) return;
      const sel = selector || names.map((n) => `[${CSS.escape(n)}]`).join(',');
      const run = () => {
        try {
          for (const el of document.querySelectorAll(sel)) for (const n of names) el.removeAttribute(n);
        } catch {
          /* bad selector */
        }
      };
      onDomReady(run);
      win.addEventListener('load', run, { once: true });
      observeDom(run, /stay/.test(behavior ?? '') ? null : 15000);
    },

    'remove-class'(classes, selector, behavior) {
      const names = (classes ?? '').split(/\s*\|\s*/).filter(Boolean);
      if (!names.length) return;
      const sel = selector || names.map((n) => `.${CSS.escape(n)}`).join(',');
      const run = () => {
        try {
          for (const el of document.querySelectorAll(sel)) el.classList.remove(...names);
        } catch {
          /* bad selector */
        }
      };
      onDomReady(run);
      win.addEventListener('load', run, { once: true });
      observeDom(run, /stay/.test(behavior ?? '') ? null : 15000);
    },

    'set-attr'(selector, attr, value) {
      if (!selector || !attr) return;
      const v = value ?? '';
      const copyFrom = /^\[([\w-]+)\]$/.exec(v)?.[1];
      if (!copyFrom && !/^(?:-?\d+|true|false|)$/.test(v)) return;
      const run = () => {
        try {
          for (const el of document.querySelectorAll(selector)) {
            el.setAttribute(attr, copyFrom ? el.getAttribute(copyFrom) ?? '' : v);
          }
        } catch {
          /* ignore */
        }
      };
      onDomReady(run);
      observeDom(run, 15000);
    },

    'set-cookie'(name, value, path) {
      if (!name) return;
      const sv = safeValue(value);
      if (!sv.ok || typeof sv.value === 'function' || typeof sv.value === 'object') return;
      const p = path === 'none' ? '' : `; path=${path || '/'}`;
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(String(sv.value ?? ''))}${p}`;
    },

    'set-local-storage-item'(key, value) {
      setStorage(win.localStorage, key, value);
    },

    'set-session-storage-item'(key, value) {
      setStorage(win.sessionStorage, key, value);
    },

    'remove-cookie'(needle) {
      const matches = toTester(needle);
      const run = () => {
        for (const c of document.cookie.split(';')) {
          const name = c.split('=')[0]!.trim();
          if (!name || !matches(name)) continue;
          const host = location.hostname;
          for (const domain of ['', host, '.' + host]) {
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? '; domain=' + domain : ''}`;
          }
        }
      };
      run();
      win.addEventListener('beforeunload', run);
      document.addEventListener('visibilitychange', run);
    },

    'remove-node-text'(nodeName, needle) {
      if (!nodeName) return;
      const nameMatch = toTester(nodeName.startsWith('/') ? nodeName : `/^${nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$/i`);
      const textMatch = toTester(needle);
      const handle = (node: Node) => {
        if (!nameMatch(node.nodeName.toLowerCase())) return;
        const text = node.textContent ?? '';
        if (text && textMatch(text)) node.textContent = '';
      };
      const mo = new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) handle(n);
      });
      const start = () => {
        mo.observe(document.documentElement ?? document, { childList: true, subtree: true });
        onDomReady(() => {
          const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ALL);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) handle(n);
        });
      };
      if (document.documentElement) start();
      else document.addEventListener('readystatechange', start, { once: true });
    },

    'disable-newtab-links'() {
      document.addEventListener(
        'click',
        (ev) => {
          let el = ev.target as Element | null;
          while (el && el.tagName !== 'A') el = el.parentElement;
          if (el && el.getAttribute('target') === '_blank') {
            ev.stopPropagation();
            el.removeAttribute('target');
          }
        },
        true,
      );
    },
  };

  function setStorage(storage: Storage | undefined, key: string | undefined, value: string | undefined) {
    if (!storage || !key) return;
    try {
      if (value === '$remove$') {
        storage.removeItem(key);
        return;
      }
      const sv = safeValue(value);
      if (!sv.ok || typeof sv.value === 'function') return;
      if (sv.value === undefined) storage.removeItem(key);
      else storage.setItem(key, typeof sv.value === 'object' ? nativeStringify(sv.value) : String(sv.value));
    } catch {
      /* storage disabled */
    }
  }

  for (const [name, args] of calls) {
    const fn = impl[name];
    if (!fn) continue;
    try {
      fn(...args);
    } catch {
      /* a broken scriptlet must never break the page or other scriptlets */
    }
  }
}
