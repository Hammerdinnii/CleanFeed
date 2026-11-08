# CleanFeed

A Manifest V3 browser extension for **Chrome and Firefox** that does two jobs:

1. **Ad & tracker blocking** in the uBlock Origin tradition: `declarativeNetRequest` network rules compiled from standard filter lists (EasyList, EasyPrivacy, uBlock filters, …), uBO-style cosmetic filtering with procedural filters, scriptlets against anti-adblock, popup blocking, tracking-parameter removal, and per-site allowlists.
2. **AI content filtering**: detects AI-generated posts, comments, articles, videos and images by combining several local signals (platform labels, provenance metadata, writing patterns, text statistics, an optional ONNX image model, creator blocklists, your own keywords) into one confidence score. Flagged content is collapsed, blurred, dimmed or labeled, and can always be shown again.

**Everything runs locally.** No accounts, no telemetry, no remote configuration. Page text, images, URLs and browsing history are processed in the browser and never sent anywhere. The only network traffic is described in [Privacy](#privacy).

---

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [How AI detection works](#how-ai-detection-works)
- [Image model (ONNX)](#image-model-onnx)
- [Architecture](#architecture)
- [Maintaining selectors, patterns and lists](#maintaining-selectors-patterns-and-lists)
- [Filter syntax support](#filter-syntax-support)
- [Testing](#testing)
- [Privacy](#privacy)
- [Permissions](#permissions)
- [Known limitations](#known-limitations)

---

## Quick start

Requirements: **Node.js 20+** and npm.

```bash
npm install
```

```bash
npm run build
```

This produces two unpacked extensions:

| Browser | Folder         | Load it                                                                                              |
| ------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Chrome / Edge / Brave (121+) | `dist/chrome`  | `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/chrome` |
| Firefox (140+) | `dist/firefox` | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `dist/firefox/manifest.json` |

On Firefox, if CleanFeed opens its settings page on install, click **Grant access** (Firefox can install MV3 extensions without site access).

### Recommended: bundle full filter lists

Out of the box the build includes the small built-in **CleanFeed Base** list, and the extension downloads EasyList, EasyPrivacy, uBlock filters etc. on first run (installing them as dynamic rules). For the best first-run experience and lowest runtime cost, download list snapshots before building so they become **static rulesets**:

```bash
npm run fetch-lists
```

```bash
npm run build
```

Lists are then updated at runtime as small deltas against the bundled snapshot (see [Architecture](#architecture)).

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run build:chrome` / `npm run build:firefox` | Build one target |
| `npm run watch` | Rebuild on change (`--dev` adds inline source maps: `node scripts/build.mjs --dev --watch`) |
| `node scripts/build.mjs --no-onnx` | Lean build without ONNX Runtime (no image model support); metadata, text and label detection still work |
| `npm run package` | Build and write store-ready `artifacts/cleanfeed-chrome-<v>.zip` and `artifacts/cleanfeed-firefox-<v>.xpi` |
| `npm run typecheck` | TypeScript type check |
| `npm test` | Unit tests (filter compiler, AI detectors, scoring) |
| `npm run test:e2e` | End-to-end tests in real Chromium via Playwright |
| `npm run lint:firefox` | `web-ext lint` on the Firefox build |
| `npm run icons` | Regenerate the PNG icons |

---

## Features

### Ad blocking

- **Network blocking** with `declarativeNetRequest`: block, allow, `$important`, `$document` exceptions, `$redirect` to neutered surrogates (Google Analytics, GTM, AdSense, comScore, apstag, AMP…), `$removeparam` (utm_*, fbclid, gclid…), `$csp`, `$domain`/`$to`/`$denyallow`, `$method`, `$third-party`, `$match-case`, `$badfilter`, regex filters (RE2-checked), hosts files.
- **Filter list subscriptions** with automatic updates (respecting each list's `! Expires:`), mirrors, `!#include` and `!#if` preprocessing, and custom lists by URL.
- **Cosmetic filtering**: `##`/`#@#` rules injected as *user-origin* stylesheets (cannot be overridden by page CSS and are invisible to `document.styleSheets`), lazy injection of generic selectors keyed by the classes/ids actually present on the page, `:style()`, and procedural filters (`:has-text`, `:upward`, `:xpath`, `:matches-css`, `:matches-attr`, `:matches-path`, `:min-text-length`, `:watch-attr`, `:remove`, `:remove-attr`, `:remove-class`, procedural `:has`/`:not`).
- **Scriptlets** (`##+js(...)`) run in the page's main world for anti-adblock and ad-script neutralization: `set-constant`, `abort-on-property-read/write`, `abort-current-script`, `abort-on-stack-trace`, `json-prune`, `json-prune-fetch-response`, `json-prune-xhr-response`, `no-setTimeout-if`, `no-setInterval-if`, `adjust-setTimeout/Interval`, `prevent-addEventListener`, `no-fetch-if`, `no-xhr-if`, `no-window-open-if`, `noeval-if`, `remove-attr`, `remove-class`, `set-attr`, `set-cookie`, `set-local/session-storage-item`, `remove-cookie`, `remove-node-text`, `disable-newtab-links`, `no-requestAnimationFrame-if` (plus uBO, ABP-snippet and AdGuard aliases).
- **Feed ads**: promoted posts on X, Reddit, LinkedIn, YouTube and Google are hidden by site-aware logic (text badges like "Ad"/"Promoted" that lists can't target reliably).
- **YouTube video ads**: JSON pruning scriptlets plus a content-side fallback that mutes/skips ads that get through and removes the "ad blockers are not allowed" dialog.
- **Popup blocking** (`$popup` filters, or strict mode for any cross-site popup to a known ad host).
- **Element picker** ("Hide an element…" in the popup and context menu) that writes a filter to *My filters*.
- **Per-site allowlist**, temporary **pause** (session rules that expire), and a global kill switch.

### AI content filtering

- **Detectors** (each can be turned off): platform labels & disclosures, image provenance metadata (C2PA / IPTC / EXIF / PNG generator chunks), AI writing patterns (editable list with weights), statistical text scoring, local ONNX image model, creator/channel/community blocklists, keyword rules.
- **Treatments**: Collapse (compact bar with *Show anyway*), Blur, Dim, Label only. Every flag shows a short reason and confidence (e.g. *AI writing patterns · 82%*), a *Why?* breakdown, *Not AI* (remembered immediately and permanently), and *Block @creator*.
- **Sites**: dedicated adapters for X/Twitter, YouTube (feed, Shorts, watch-page "Altered or synthetic content"), Google Search (AI Overviews, AI Mode tab, result domains), Reddit (new & old, AI-art communities, flairs), LinkedIn, plus a conservative generic adapter for articles and large images anywhere (label-only by default).
- **Controls**: global sensitivity (Low / Balanced / High), per-site overrides (on/off, treatment), creator blocklist with import/export (txt, CSV, JSON), community blocklist subscriptions, trusted creators, keyword rules that hide unwanted items and/or count as AI evidence.
- **Quiet statistics**: per page, this session and today — stored locally only, can be disabled.

---

## How AI detection works

Each detector returns a **signal**: a score (0–1), a reliability weight, and a human-readable reason. `src/ai/scoring.ts` combines them:

```
p = (1 − Π(1 − weightᵢ · scoreᵢ)) × (1 − damping)
```

- **Noisy-OR** over positive evidence: independent signals reinforce each other.
- **Definitive signals** (platform labels, blocklisted creators/communities, C2PA "trainedAlgorithmicMedia") set `p ≥ 0.97` and are never damped.
- **Weak detectors are capped** (text statistics can contribute at most 0.4), so they can corroborate but never flag on their own.
- **Human-leaning evidence damps** the score (informal writing style, camera provenance).
- **Thresholds**: Low 0.85, Balanced 0.72, High 0.58.

| Detector | What it looks at | Notes |
| --- | --- | --- |
| Platform labels | YouTube "Altered or synthetic content", "Made with AI"/"AI info" badges, AI flairs, Community Notes, Google AI Overviews | Matches label elements only, never post bodies (a post *mentioning* "AI-generated" isn't labeled) |
| Metadata | C2PA manifests (JPEG APP11, PNG caBX, WebP/ISOBMFF), IPTC `DigitalSourceType`, XMP `CreatorTool`, EXIF `Software`, Stable Diffusion/ComfyUI/NovelAI/InvokeAI/Midjourney PNG chunks | Reads the first 256 KB via a Range request. C2PA signatures are not cryptographically verified (reported as "Content Credentials") |
| Text patterns | ~45 weighted tells: "it's not just X — it's Y", "in today's fast-paced world", "delve", "tapestry", chatbot boilerplate, leftover citation markers, Markdown artifacts, emoji bullets, em-dash density, staccato one-line paragraphs | Length-normalized and damped for short texts; fully editable in Options → Text patterns |
| Text statistics | Sentence-length burstiness, opening repetition, word length, triads, informal markers | Small hand-calibrated logistic model; corroboration only |
| Image model | Any ONNX image classifier you install | WebGPU or WASM, cached by image hash |
| Blocklists | Your blocklist, community lists, built-in AI-art subreddits | Exact handle matching |
| Keywords | Your phrases or `/regex/` | Can hide items (non-AI "unwanted") and/or add AI evidence |

Unit tests in `test/unit/ai-text.test.ts` pin the behaviour on representative AI and human samples (e.g. a casual tweet, a product review with an em-dash, and a single "delve" are *not* flagged).

---

## Image model (ONNX)

No model weights ship with CleanFeed (size, licensing, and keeping installs small). Image detection still works without one through metadata; the model adds pixel-level detection.

**Install a model:** Options → **Image model** → *Import .onnx file…* (or *Download* from an https URL you enter — an explicit, opt-in download of the model file only). Describe its preprocessing in the form, or load a manifest JSON:

```json
{
  "name": "My AI-image detector",
  "inputSize": 224,
  "layout": "NCHW",
  "mean": [0.485, 0.456, 0.406],
  "std": [0.229, 0.224, 0.225],
  "output": "softmax",
  "aiIndex": 1,
  "labels": ["real", "ai"],
  "resize": "center-crop"
}
```

`output` is `softmax` (logits per class), `sigmoid` (single logit; `aiIndex` 0 means the logit is "AI", 1 means it is "real") or `probabilities`. Then use **Test model** to verify it loads (the result shows the backend and latency).

**Getting a model.** A quantized ViT-S / ConvNeXt-T-sized detector (≈20–90 MB) is a good balance. For any Hugging Face `AutoModelForImageClassification` checkpoint:

```bash
pip install "transformers>=4.40" torch onnx onnxruntime pillow
```

```bash
python3 scripts/export-model.py <model-id-or-path> out/
```

This writes `model_quantized.onnx` and `cleanfeed-model.json` (check the printed labels and `aiIndex`). Research detectors such as Community Forensics that ship as plain PyTorch/timm code can be exported by constructing the model with their code and calling `export()` from the same script. Detector accuracy varies widely across generators; keep the confidence threshold conservative (default 0.80).

**Runtime.** Chrome runs inference in an **offscreen document** (service workers can't host ONNX Runtime), created on demand and closed after 5 idle minutes. Firefox runs it in the background page. WebGPU is used when available, WASM (SIMD, single-threaded) otherwise. Results are cached in IndexedDB by URL and by SHA-256 of the image bytes.

---

## Architecture

```
src/
├── shared/        cross-context utilities: browser API shim, typed messaging, settings,
│                  storage, IndexedDB, hostname/PSL helpers
├── adblock/       filter-list compiler shared by build and runtime
│   ├── preprocess.ts     !#if / !#include, list headers
│   ├── network.ts        network filter parser → DNR rules
│   ├── cosmetic.ts       ## / #@# / #$# / #%# / +js() parser
│   ├── procedural.ts     procedural selector parser (compiled to JSON programs)
│   ├── compiler.ts       whole-list compile, domain merging, rule IDs & hashes
│   ├── scriptlets/runner.ts   MAIN-world scriptlet implementations
│   └── registry.ts       default subscriptions
├── background/    service worker (Chrome) / event page (Firefox)
│   ├── dnr.ts            static/dynamic/session rules, budgets, safe bisection
│   ├── lists.ts          downloads, compile, deltas vs bundled rulesets
│   ├── cosmetic-index.ts merged per-host / per-token cosmetic index in IndexedDB
│   ├── cosmetic-service.ts  user-origin CSS injection for frames
│   ├── scriptlets.ts     MAIN-world injection on navigation commit
│   ├── popups.ts, stats.ts, pause.ts, data.ts, context-menu.ts
│   ├── ai-services.ts    image analysis queue + cache, community lists
│   └── inference-host.ts offscreen document (Chrome) / in-page (Firefox)
├── content/       content script (all frames; AI in the top frame only)
│   ├── cosmetic/         generic-token collector, procedural executor
│   ├── ai/scanner.ts     item discovery → detectors → treatment
│   ├── ai/actions.ts     bar/badge UI (closed shadow DOM)
│   ├── feed-ads.ts, youtube-ads.ts, dom-watcher.ts, picker.ts
├── ai/            pure detection logic (unit-tested): detectors, scoring, patterns
├── sites/         selectors.ts (data) + adapters/ (logic) per site
├── inference/     ONNX engine and image fetching
├── offscreen/, popup/, options/, ui/
filters/           cleanfeed-base.txt (built-in list); cache/ for fetched snapshots
manifest/          base.json + chrome.json / firefox.json overlays
static/            icons, locales, redirect surrogates
scripts/           build, list fetching/compilation, packaging, icons, model export
test/              unit (node:test) and e2e (Playwright + local fixture server)
```

**Messaging.** All messages use one typed envelope (`src/shared/messages.ts`) with an explicit target (`background`, `offscreen`, `content`), so listeners in other extension pages never answer by accident.

**Rules pipeline.** Lists compile deterministically into DNR rules. Hostname-only filters (`||ads.example^`) are merged into multi-domain rules, bucketed by domain hash so an upstream change only alters one merged rule. Bundled lists become static rulesets with a per-rule hash file. When a list updates at runtime, CleanFeed computes a delta: new rules go into dynamic rules, rules removed upstream are disabled in the static ruleset (`updateStaticRules`). Every DNR sync computes the full desired state and applies a minimal diff; invalid rules are isolated by bisection instead of failing the whole batch. Budgets: dynamic, unsafe (redirect/modifyHeaders) and regex limits are read from the browser.

**Priority ladder.** `removeparam (1) < block (100) < redirect (150) < allow / $document (200) < $important (300) < your filters (+1000) < site allowlist (10000)`. `$removeparam` is deliberately lowest: DNR applies one winning rule, and a broad removeparam rule would otherwise cancel every block. Rule IDs encode allow vs block so statistics can count blocks from `getMatchedRules()` cheaply.

**Cosmetics.** The merged index lives in IndexedDB keyed by hostname/entity (`example.*`) and by generic token (`.class`/`#id`), so a freshly woken service worker answers a page with a few keyed reads. CSS is one rule per selector, so one invalid selector can't void the others.

**Performance.** One shared, throttled `MutationObserver` with back-off; AI analysis only for items within 800 px of the viewport; text extraction walks the DOM instead of forcing layout via `innerText`; verdicts and image results are cached; recycled nodes (YouTube, X) are detected by fingerprint.

---

## Maintaining selectors, patterns and lists

- **Site selectors**: `src/sites/selectors.ts` is plain data — update it when a site changes markup. Adapter logic in `src/sites/adapters/` rarely needs changes.
- **AI writing patterns**: `src/ai/patterns/default-patterns.ts` (id, regex, weight, category, description). Users can also edit them in Options → Text patterns, and export/import them as JSON.
- **AI communities**: `src/ai/communities.ts`.
- **Built-in filter list**: `filters/cleanfeed-base.txt` (standard filter syntax).
- **Default subscriptions**: `src/adblock/registry.ts`.
- **Redirect surrogates**: `static/redirects/` + `src/adblock/resources.ts` (name aliases).

## Filter syntax support

Supported: everything listed under [Features](#ad-blocking), hosts-file lines, ABP `#$#` snippets for the mapped scriptlets, AdGuard `#%#//scriptlet()` and `#$#selector { style }`, eyeo `##selector { style }`.

Not supported (dropped, never broadened): HTML filtering (`##^`, `$$`), `$header`, `$replace`, `$permissions`, `$urltransform`, regex `$removeparam`, exceptions that cancel a modifier (`@@…$redirect`, `$csp`, `$removeparam`), `trusted-*` scriptlets, generic procedural filters. `||host/path` patterns follow ABP semantics and don't match URLs with an explicit non-default port.

---

## Testing

```bash
npm test
```

37 unit tests: filter parsing and DNR conversion, priorities, domain merging stability, preprocessing, cosmetic/procedural parsing, AI detectors on AI vs human samples, scoring guard rails.

```bash
npm run test:e2e
```

22 end-to-end tests that load `dist/chrome` into real Chromium and serve local fixtures for real hostnames (`--host-resolver-rules`): static rule blocking and surrogate redirects, low/high-generic and procedural hiding, scriptlet timing, `removeparam`, allowlist and pause, custom list subscriptions, AI flagging on generic pages, X, Reddit, Google AI Overviews, YouTube (synthetic-content disclosure, channel blocklist), LinkedIn, Stable Diffusion PNG metadata, ONNX inference in the offscreen document (tiny test model in `test/e2e/fixtures/`), popup/options rendering, and a clean service-worker console. The suite needs Playwright with Chromium; run it with full lists after `npm run fetch-lists` to exercise 13k+ static rules.

---

## Privacy

CleanFeed has no servers. It makes these network requests and nothing else:

1. **Filter-list updates** from the publishers you subscribe to, without cookies.
2. **Community blocklists**, only if you add one.
3. **Image re-reads**: to read image metadata or run your local model, CleanFeed may re-request an image from the same server the page loaded it from, without cookies or referrer (metadata reads are limited to the first 256 KB). Turn this off under AI filter → Tuning.
4. **Model download**, only when you explicitly download a model from a URL you enter.

Statistics, settings, "Not AI" decisions and caches are stored in `chrome.storage.local` / IndexedDB on your device. Backups are plain JSON files you export yourself.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequest`, `declarativeNetRequestFeedback` | Network blocking; counting blocked requests for the badge/stats |
| `<all_urls>` host access | Cosmetic filtering, scriptlets and AI filtering on every site; fetching images for local analysis |
| `scripting` | Injecting user-origin CSS, scriptlets and the element picker |
| `webNavigation` | Scriptlet timing and popup detection |
| `storage`, `unlimitedStorage` | Settings and compiled filter lists (IndexedDB) |
| `alarms` | Scheduled list updates, expiring pauses, stats polling |
| `contextMenus` | "Hide an element…" and "Pause on this site" |
| `offscreen` (Chrome) | Running ONNX Runtime outside the service worker |

## Known limitations

- **Manifest V3 limits**: dynamic rules are capped by the browser (30k on current Chrome; fewer on older versions and Firefox). Lists without a bundled snapshot that exceed the budget are installed partially and marked "partially installed" in Options → Filter lists. Bundling snapshots (`npm run fetch-lists`) avoids this.
- **Scriptlet timing**: scriptlets are injected on navigation commit with `injectImmediately`. This beats page scripts in practice (the e2e suite checks it) but MV3 offers no hard guarantee.
- **Site markup drifts**: X, YouTube, Reddit, LinkedIn and Google change their DOM often. Adapters prefer stable hooks (`data-testid`, custom elements, attributes) and degrade gracefully, but `src/sites/selectors.ts` will need periodic updates. The e2e fixtures model current structures; they are not live-site tests.
- **AI detection is probabilistic**: heuristics are tuned against false positives, but sophisticated AI text without typical tells won't be caught, and some formal human writing can trip Balanced/High sensitivity. Use *Not AI*, per-site overrides and the pattern editor to adjust.
- **C2PA**: manifests are parsed for AI source types but signatures are not verified; most social platforms strip metadata entirely.
- **Firefox**: the build passes `web-ext lint` with no errors; the end-to-end suite runs on Chromium only. Firefox needs version 140+ (the minimum that understands the manifest's `data_collection_permissions` key).

## License

No license has been chosen yet; pick one before publishing. Filter lists fetched or bundled at build time remain under their own licenses (EasyList: GPLv3 / CC BY-SA 3.0; uBlock filters: GPLv3). ONNX Runtime Web is MIT-licensed (notice in `vendor/ort/NOTICE.txt` of each build).
