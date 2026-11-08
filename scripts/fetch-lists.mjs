#!/usr/bin/env node
/**
 * Downloads snapshots of the default filter lists into filters/cache/ so the
 * next `npm run build` compiles them into static DNR rulesets (fast first-run
 * blocking, small runtime deltas). Without snapshots the extension still
 * works: it downloads the lists on first run and installs them dynamically.
 *
 *   npm run fetch-lists [-- --only=easylist,easyprivacy]
 *
 * `!#include` directives are resolved (same origin only) so the cached file
 * is self-contained.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'filters', 'cache');
mkdirSync(cacheDir, { recursive: true });
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');

// Reuse the registry from the TypeScript sources.
const regOut = join(root, '.build', 'registry.mjs');
await esbuild.build({ entryPoints: [join(root, 'src', 'adblock', 'registry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: regOut, logLevel: 'warning' });
const { DEFAULT_SUBSCRIPTIONS } = await import(pathToFileURL(regOut).href);

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'CleanFeed-build' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function expand(text, base, depth = 0) {
  if (depth > 3) return text;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^!#include\s+(\S+)/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const url = new URL(m[1], base);
    if (url.origin !== new URL(base).origin) continue;
    try {
      out.push(await expand(await get(url.href), url.href, depth + 1));
    } catch (err) {
      console.warn(`  include ${url.href} failed: ${err.message}`);
    }
  }
  return out.join('\n');
}

let ok = 0;
for (const sub of DEFAULT_SUBSCRIPTIONS) {
  if (!sub.bundled || !sub.url) continue;
  if (only && !only.includes(sub.id)) continue;
  const urls = [sub.url, ...(sub.mirrors ?? [])];
  let done = false;
  for (const url of urls) {
    try {
      const text = await expand(await get(url), url);
      if (/^\s*<(?:!doctype|html)/i.test(text)) throw new Error('got HTML');
      writeFileSync(join(cacheDir, `${sub.id}.txt`), text);
      console.log(`✔ ${sub.id.padEnd(18)} ${(text.length / 1024).toFixed(0).padStart(6)} KB  ${url}`);
      done = true;
      ok++;
      break;
    } catch (err) {
      console.warn(`  ${sub.id} from ${url}: ${err.message}`);
    }
  }
  if (!done) console.warn(`✘ ${sub.id}: all sources failed`);
}
console.log(`\n${ok} list(s) cached in filters/cache. Run "npm run build" to compile them.`);
