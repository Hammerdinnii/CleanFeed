#!/usr/bin/env node
/**
 * End-to-end tests: loads dist/chrome into Chromium (Playwright), serves
 * fixture pages from a local server and maps every hostname to it with
 * --host-resolver-rules, so real ad domains (doubleclick.net, …) and site
 * hostnames (x.com, www.reddit.com, www.google.com) hit local fixtures.
 *
 *   npm run test:e2e        (builds dist/chrome first)
 *
 * Requires Playwright with a Chromium that supports extensions in headless
 * mode (channel "chromium").
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const EXT = join(root, 'dist', 'chrome');
const PORT = 8123;
const page = (name) => readFileSync(join(here, 'fixtures', 'pages', name), 'utf8');

// --- tiny PNG encoder for fixture images ------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function solidPng(size, [r, g, b], text) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(size * 3 + 1);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(text ?? {})) parts.push(chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1')));
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const SD_PNG = solidPng(400, [120, 160, 200], { parameters: 'a lighthouse at dawn\nSteps: 28, Sampler: DPM++ 2M Karras, CFG scale: 6.5, Seed: 1234, Size: 400x400' });
const PLAIN_PNG = solidPng(400, [30, 60, 220]);
const RED_PNG = solidPng(400, [230, 30, 30]);

// --- fixture server ----------------------------------------------------------------
const hits = [];
const server = createServer((req, res) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const path = req.url ?? '/';
  hits.push(`${host}${path}`);
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (host === 'doubleclick.net') return send('text/javascript', 'window.__adLoaded = true;');
  if (host === 'cdn.example.test') return send('text/javascript', 'window.__libLoaded = true;');
  if (host === 'www.google-analytics.com') return send('text/javascript', 'window.__gaReal = true;');
  if (host === 'googlesyndication.com') return send('image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  if (host === 'img.example.test') {
    if (path.startsWith('/sd.png')) return send('image/png', SD_PNG);
    if (path.startsWith('/red.png')) return send('image/png', RED_PNG);
    return send('image/png', PLAIN_PNG);
  }
  if (host === 'news.example.test') return send('text/html', page('ads.html'));
  if (host === 'blog.example.test') return send('text/html', page('blog.html'));
  if (host === 'redblog.example.test') return send('text/html', '<!doctype html><body><p>Gallery</p><img id="red" src="http://img.example.test:8123/red.png" width="400" height="400"><img id="blue" src="http://img.example.test:8123/plain.png?b" width="400" height="400"></body>');
  if (host === 'lists.example.test') return send('text/plain', '! Title: Test list\n||tracker.example.test^\nshop.example.test##.upsell\n');
  if (host === 'tracker.example.test') return send('text/javascript', 'window.__trackerLoaded = true;');
  if (host === 'shop.example.test') return send('text/html', '<!doctype html><div class="upsell" id="up">Buy more</div><script src="http://tracker.example.test:8123/t.js"></script>');
  if (host === 'x.com') return send('text/html', page('x.html'));
  if (host === 'www.youtube.com') return send('text/html', page('youtube-watch.html'));
  if (host === 'www.linkedin.com') return send('text/html', page('linkedin.html'));
  if (host === 'www.reddit.com') return send('text/html', page('reddit.html'));
  if (host === 'www.google.com') return send('text/html', page('google.html'));
  res.writeHead(404);
  res.end('not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
// `||host/path` filters only match default ports, so the surrogate test needs port 80.
const server80 = createServer((req, res) => server.emit('request', req, res));
const has80 = await new Promise((r) => {
  server80.once('error', () => r(false));
  server80.listen(80, '127.0.0.1', () => r(true));
});

// --- browser -----------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'cleanfeed-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-proxy-server',
    '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
  ],
});
const swErrors = [];
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
sw.on('console', (m) => {
  if (m.type() === 'error') swErrors.push(m.text());
  if (process.env.E2E_VERBOSE) console.log('  [sw]', m.text());
});
const extId = new URL(sw.url()).host;
const extUrl = (p) => `chrome-extension://${extId}/${p}`;

const helper = await ctx.newPage();
await helper.goto(extUrl('options/options.html#about'));

async function bg(type, payload = {}) {
  const r = await helper.evaluate(([type, payload]) => chrome.runtime.sendMessage({ __cf: 1, type, payload, target: 'background' }), [type, payload]);
  if (!r?.ok) throw new Error(`${type}: ${r?.error}`);
  return r.data;
}
async function setStorage(values) {
  await helper.evaluate((v) => chrome.storage.local.set(v), values);
}
/** Deep-merges a partial settings object (extension pages forbid eval, so no closures). */
async function patchSettings(patch) {
  await helper.evaluate(async (patch) => {
    const { settings } = await chrome.storage.local.get('settings');
    const merge = (t, p) => {
      for (const [k, v] of Object.entries(p)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) merge((t[k] ??= {}), v);
        else t[k] = v;
      }
    };
    merge(settings, patch);
    await chrome.storage.local.set({ settings });
  }, patch);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for first-run initialization (bundled lists imported, rules synced).
for (let i = 0; i < 50; i++) {
  const ready = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getEnabledRulesets()).length > 0 && !!(await chrome.storage.local.get('bundledDataVersion')).bundledDataVersion);
  if (ready) break;
  await sleep(200);
}
await sleep(500);

// --- tests -------------------------------------------------------------------------
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  ✘ ${name}\n      ${String(err?.message ?? err).split('\n').join('\n      ')}`);
  }
}

const hidden = (p, sel) => p.$eval(sel, (el) => getComputedStyle(el).display === 'none');
const barCount = (p) => p.evaluate(() => document.querySelectorAll('cleanfeed-bar').length);
const barBefore = (p, sel) => p.$eval(sel, (el) => el.previousElementSibling?.tagName.toLowerCase() === 'cleanfeed-bar');

console.log('CleanFeed e2e');

await test('user filters compile and apply', async () => {
  const r = await bg('ui:userFiltersSave', {
    text: [
      'news.example.test##.promo-box',
      'news.example.test##.post:has-text(Sponsored)',
      'news.example.test##+js(set-constant, cfTestFlag, 42)',
      '||cdn.example.test/blocked-by-user.js',
      'this is not $$ valid',
    ].join('\n'),
  });
  assert.equal(r.dnrRules, 1);
  assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
});

const news = await ctx.newPage();
await test('network blocking via static DNR rules', async () => {
  await news.goto(`http://news.example.test:${PORT}/ads.html`);
  await news.waitForLoadState('load');
  assert.equal(await news.evaluate(() => window.__adLoaded), undefined, 'doubleclick.net script should be blocked');
  assert.equal(await news.evaluate(() => window.__libLoaded), true, 'first-party lib should load');
  assert.equal(await news.$eval('#t-img', (i) => i.naturalWidth), 0, 'googlesyndication pixel should be blocked');
  assert.ok(!hits.some((h) => h.startsWith('doubleclick.net')), 'request must not reach the server');
});

await test('redirect to neutered surrogate (google-analytics)', async () => {
  if (!has80) return console.log('    (skipped: port 80 unavailable)');
  assert.equal(await news.evaluate(() => window.__gaReal), undefined, 'real analytics.js must not run');
  assert.equal(await news.evaluate(() => typeof window.ga === 'function' && window.ga.loaded === true), true, 'surrogate ga() installed');
});

await test('cosmetic: high-generic, low-generic and specific hiding', async () => {
  await news.waitForFunction(() => getComputedStyle(document.querySelector('#t-lowgeneric')).display === 'none', null, { timeout: 5000 });
  assert.ok(await hidden(news, '#div-gpt-ad-1234'), 'high-generic [id^=div-gpt-ad]');
  assert.ok(await hidden(news, '#carbonads'), 'low-generic #carbonads');
  assert.ok(await hidden(news, '#t-user'), 'user specific filter');
  assert.ok(!(await hidden(news, '#t-content')), 'content stays visible');
});

await test('cosmetic: procedural :has-text()', async () => {
  await news.waitForFunction(() => getComputedStyle(document.querySelector('#t-proc')).display === 'none', null, { timeout: 5000 });
  assert.ok(!(await hidden(news, '#t-proc-ok')));
});

await test('scriptlet set-constant runs before page scripts', async () => {
  assert.equal(await news.evaluate(() => document.documentElement.dataset.flag), '42');
});

await test('removeparam strips tracking parameters', async () => {
  await news.goto(`http://news.example.test:${PORT}/ads.html?utm_source=newsletter&id=7&fbclid=abc`);
  const u = new URL(news.url());
  assert.equal(u.searchParams.get('utm_source'), null);
  assert.equal(u.searchParams.get('fbclid'), null);
  assert.equal(u.searchParams.get('id'), '7');
});

await test('per-site allowlist disables blocking', async () => {
  await bg('data:mutate', { op: 'allowlist', hostname: 'news.example.test', value: true });
  await sleep(400);
  await news.goto(`http://news.example.test:${PORT}/ads.html`);
  await news.waitForLoadState('load');
  assert.equal(await news.evaluate(() => window.__adLoaded), true, 'ad script loads on allowlisted site');
  assert.ok(!(await hidden(news, '#t-lowgeneric')), 'no element hiding on allowlisted site');
  await bg('data:mutate', { op: 'allowlist', hostname: 'news.example.test', value: false });
  await sleep(400);
});

await test('temporary pause uses session rules', async () => {
  await bg('ui:pauseSite', { hostname: 'news.example.test', minutes: 5 });
  await news.goto(`http://news.example.test:${PORT}/ads.html`);
  assert.equal(await news.evaluate(() => window.__adLoaded), true);
  await bg('ui:pauseSite', { hostname: 'news.example.test', minutes: null });
  await news.goto(`http://news.example.test:${PORT}/ads.html`);
  assert.equal(await news.evaluate(() => window.__adLoaded), undefined);
});

await test('subscribing to a custom list installs dynamic network + cosmetic rules', async () => {
  const r = await bg('ui:listAdd', { url: `http://lists.example.test:${PORT}/list.txt`, name: 'E2E list' });
  assert.ok(r.ok, JSON.stringify(r));
  const status = await bg('ui:dnrStatus');
  assert.ok(status.dynamicRules >= 2, `dynamic rules: ${status.dynamicRules}`);
  const p = await ctx.newPage();
  await p.goto(`http://shop.example.test:${PORT}/`);
  await p.waitForLoadState('load');
  assert.equal(await p.evaluate(() => window.__trackerLoaded), undefined, 'tracker from custom list blocked');
  await p.waitForFunction(() => getComputedStyle(document.querySelector('#up')).display === 'none', null, { timeout: 5000 });
  await bg('ui:listRemove', { id: r.id });
  await p.goto(`http://shop.example.test:${PORT}/`);
  await p.waitForLoadState('load');
  assert.equal(await p.evaluate(() => window.__trackerLoaded), true, 'removing the list removes its rules');
  await p.close();
});

const blog = await ctx.newPage();
await test('AI text on generic sites is labeled, human text untouched', async () => {
  await blog.goto(`http://blog.example.test:${PORT}/`);
  await blog.waitForFunction(() => document.querySelector('#ai')?.previousElementSibling?.tagName === 'CLEANFEED-BAR', null, { timeout: 8000 });
  assert.equal(await blog.$eval('#ai', (el) => el.hasAttribute('data-cleanfeed-ai')), false, 'label mode must not hide');
  assert.equal(await barBefore(blog, '#human'), false, 'human article must not be flagged');
});

await test('image metadata: Stable Diffusion PNG parameters flagged', async () => {
  await blog.waitForFunction(() => document.querySelector('#sd')?.previousElementSibling?.tagName === 'CLEANFEED-BAR', null, { timeout: 10000 });
  assert.equal(await barBefore(blog, '#photo'), false, 'plain image without metadata stays untouched');
});

await test('collapse mode hides flagged content and is recoverable', async () => {
  await patchSettings({ ai: { genericMode: 'collapse' } });
  await blog.reload();
  await blog.waitForFunction(() => document.querySelector('#ai')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  assert.ok(await hidden(blog, '#ai'));
  const tabId = await helper.evaluate(async () => (await chrome.tabs.query({ url: '*://blog.example.test/*' }))[0]?.id);
  await bg('ui:revealPage', { tabId });
  await blog.waitForFunction(() => !document.querySelector('#ai')?.hasAttribute('data-cleanfeed-ai'), null, { timeout: 5000 });
  assert.ok(!(await hidden(blog, '#ai')), 'reveal shows the content again');
});

const x = await ctx.newPage();
await test('X: promoted post hidden, chatbot post collapsed, human post untouched', async () => {
  await bg('data:mutate', { op: 'blockAuthor', entry: { platform: 'twitter', handle: '@SlopFarm', added: Date.now(), source: 'user' } });
  await x.goto(`http://x.com:${PORT}/home`);
  await x.waitForFunction(() => getComputedStyle(document.querySelector('#cell-ad')).display === 'none', null, { timeout: 8000 });
  await x.waitForFunction(() => document.querySelector('#tw-ai')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  assert.ok(await barBefore(x, '#tw-ai'));
  assert.equal(await x.$eval('#tw-human', (el) => el.hasAttribute('data-cleanfeed-ai')), false);
  await x.waitForFunction(() => document.querySelector('#tw-blocked')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
});

await test('X: "Not AI" mutation clears the flag live', async () => {
  await bg('data:mutate', { op: 'notAi', key: 'twitter:status/222', value: true });
  await x.waitForFunction(() => !document.querySelector('#tw-ai')?.hasAttribute('data-cleanfeed-ai'), null, { timeout: 5000 });
  assert.equal(await barBefore(x, '#tw-ai'), false);
});

await test('Reddit: AI community post flagged, ad hidden, normal post untouched', async () => {
  const r = await ctx.newPage();
  await r.goto(`http://www.reddit.com:${PORT}/`);
  await r.waitForFunction(() => document.querySelector('#rp-ai')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  assert.ok(await hidden(r, '#rp-ad'));
  assert.equal(await r.$eval('#rp-human', (el) => el.hasAttribute('data-cleanfeed-ai')), false);
  await r.close();
});

await test('Google: AI Overview collapsed, sponsored block hidden, results untouched', async () => {
  const g = await ctx.newPage();
  await g.goto(`http://www.google.com:${PORT}/search?q=test`);
  await g.waitForFunction(() => document.querySelector('#aio-block')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  assert.ok(await hidden(g, '#tads'));
  assert.equal(await g.$eval('#res1', (el) => el.hasAttribute('data-cleanfeed-ai')), false);
  await g.close();
});

await test('YouTube: synthetic-content disclosure collapses the player; channel blocklist; ad slot hidden', async () => {
  await bg('data:mutate', { op: 'blockAuthor', entry: { platform: 'youtube', handle: '@SlopChannel', added: Date.now(), source: 'user' } });
  const y = await ctx.newPage();
  await y.goto(`http://www.youtube.com:${PORT}/watch?v=abcdefghijk`);
  await y.waitForFunction(() => document.querySelector('#player-container-outer')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  await y.waitForFunction(() => document.querySelector('#yt-blocked')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  assert.equal(await y.$eval('#yt-ok', (el) => el.hasAttribute('data-cleanfeed-ai')), false);
  assert.ok(await hidden(y, '#yt-ad'));
  await y.close();
});

await test('LinkedIn: promoted post hidden, AI-written post collapsed, human post untouched', async () => {
  const l = await ctx.newPage();
  await l.goto(`http://www.linkedin.com:${PORT}/feed/`);
  await l.waitForFunction(() => getComputedStyle(document.querySelector('#li-promo')).display === 'none', null, { timeout: 8000 });
  await l.waitForFunction(() => document.querySelector('#li-ai')?.getAttribute('data-cleanfeed-ai') === 'collapse', null, { timeout: 8000 });
  assert.equal(await l.$eval('#li-human', (el) => el.hasAttribute('data-cleanfeed-ai')), false);
  await l.close();
});

await test('ONNX model: install, load in offscreen document, classify images', async () => {
  const bytes = [...readFileSync(join(here, 'fixtures', 'tiny-classifier.onnx'))];
  await helper.evaluate(async (bytes) => {
    const buf = new Uint8Array(bytes).buffer;
    const manifest = { id: 'tiny-test', name: 'Tiny test model', inputSize: 224, layout: 'NCHW', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], output: 'softmax', aiIndex: 1, resize: 'stretch', sizeBytes: buf.byteLength };
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('cleanfeed');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put({ manifest, bytes: buf }, 'active');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    await chrome.storage.local.set({ modelManifest: manifest });
  }, bytes);
  const st = await bg('ui:modelChanged');
  assert.ok(st.installed && !st.error, JSON.stringify(st));
  const t = await bg('ui:modelTest');
  assert.ok(t.ok, JSON.stringify(t));
  const p = await ctx.newPage();
  await p.goto(`http://redblog.example.test:${PORT}/`);
  await p.waitForFunction(() => document.querySelector('#red')?.closest('body')?.querySelector('cleanfeed-bar'), null, { timeout: 15000 });
  assert.ok(await barBefore(p, '#red'), 'red image (class 1 in the test model) flagged');
  assert.equal(await barBefore(p, '#blue'), false, 'blue image not flagged');
  await p.close();
});

await test('popup and options pages render without errors', async () => {
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.goto(extUrl('popup/popup.html'));
  await p.waitForSelector('.brand');
  for (const id of ['overview', 'ads', 'lists', 'filters', 'sites', 'ai', 'model', 'creators', 'keywords', 'patterns', 'notai', 'backup', 'about']) {
    await p.goto(extUrl(`options/options.html#${id}`));
    await p.waitForSelector('main h1', { timeout: 5000 });
  }
  await p.close();
  assert.deepEqual(errors, []);
});

await test('service worker logged no errors', async () => {
  assert.deepEqual(swErrors, []);
});

await ctx.close();
server.close();
server80.close();
rmSync(profile, { recursive: true, force: true });

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
