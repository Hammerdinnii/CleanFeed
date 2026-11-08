#!/usr/bin/env node
/**
 * CleanFeed build script.
 *
 *   node scripts/build.mjs [--target=chrome|firefox|all] [--dev] [--watch] [--no-onnx]
 *
 * Output: dist/chrome and/or dist/firefox, each loadable unpacked.
 *
 * Steps per target:
 *   1. Compile bundled filter lists → static DNR rulesets + cosmetic data.
 *   2. Bundle TypeScript entry points with esbuild.
 *   3. Copy static assets, page HTML/CSS and (optionally) ONNX Runtime Web.
 *   4. Generate manifest.json from manifest/base.json + manifest/<target>.json.
 */
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const targets = !args.target || args.target === 'all' ? ['chrome', 'firefox'] : [args.target];
const dev = !!args.dev;
const withOnnx = !args['no-onnx'];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

function log(...m) {
  console.log('[build]', ...m);
}

/** Bundles and imports the TypeScript list compiler (shared with the runtime code). */
async function loadListCompiler() {
  const out = join(root, '.build', 'compile-lists.mjs');
  await esbuild.build({
    entryPoints: [join(root, 'scripts', 'compile-lists.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: out,
    logLevel: 'warning',
  });
  return import(pathToFileURL(out).href + `?t=${Date.now()}`);
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v) && Array.isArray(a[k])) a[k] = [...a[k], ...v];
    else if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

function buildManifest(target, lists) {
  const base = JSON.parse(readFileSync(join(root, 'manifest', 'base.json'), 'utf8'));
  const overlay = JSON.parse(readFileSync(join(root, 'manifest', `${target}.json`), 'utf8'));
  const extraCs = overlay.content_scripts_extra;
  delete overlay.content_scripts_extra;
  const m = deepMerge(base, overlay);
  m.version = pkg.version;
  if (extraCs) for (const cs of m.content_scripts) Object.assign(cs, extraCs);
  m.declarative_net_request = {
    rule_resources: lists.map((l) => ({ id: l.rulesetId, enabled: l.enabled, path: `rules/${l.id}.json` })),
  };
  return m;
}

function copyDir(from, to, filter = () => true) {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true, filter });
}

/** Copies *.html and *.css that live next to the TypeScript sources of UI pages. */
function copyPageAssets(outDir) {
  for (const dir of ['popup', 'options', 'offscreen', 'ui']) {
    const src = join(root, 'src', dir);
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src)) {
      if (/\.(html|css|svg)$/.test(f)) {
        mkdirSync(join(outDir, dir), { recursive: true });
        cpSync(join(src, f), join(outDir, dir, f));
      }
    }
  }
}

function dirSize(p) {
  let total = 0;
  for (const f of readdirSync(p)) {
    const fp = join(p, f);
    const s = statSync(fp);
    total += s.isDirectory() ? dirSize(fp) : s.size;
  }
  return total;
}

async function buildTarget(target, compiler) {
  const outDir = join(root, 'dist', target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  log(`${target}: compiling bundled filter lists`);
  const lists = compiler.compileBundledLists({ target, rootDir: root, outDir, log: (m) => log(m) });

  const define = {
    __TARGET__: JSON.stringify(target),
    __DEV__: JSON.stringify(dev),
    __VERSION__: JSON.stringify(pkg.version),
    __HAS_ONNX__: JSON.stringify(withOnnx),
  };
  const common = {
    bundle: true,
    define,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    target: target === 'chrome' ? ['chrome121'] : ['firefox128'],
    logLevel: 'warning',
    legalComments: 'none',
    charset: 'utf8',
  };

  const iife = [
    ['src/background/index.ts', 'background.js'],
    ['src/content/index.ts', 'content.js'],
    ['src/content/picker.ts', 'picker.js'],
    ['src/popup/popup.ts', 'popup/popup.js'],
    ['src/options/options.ts', 'options/options.js'],
  ];
  const esm = [['src/inference/engine.ts', 'inference/engine.js']];
  if (target === 'chrome') esm.push(['src/offscreen/offscreen.ts', 'offscreen/offscreen.js']);

  const builds = [
    ...iife.map(([entry, out]) => ({ ...common, entryPoints: [join(root, entry)], outfile: join(outDir, out), format: 'iife' })),
    ...esm.map(([entry, out]) => ({ ...common, entryPoints: [join(root, entry)], outfile: join(outDir, out), format: 'esm' })),
  ];

  if (args.watch) {
    for (const b of builds) {
      const ctx = await esbuild.context(b);
      await ctx.watch();
    }
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
  }

  copyDir(join(root, 'static'), outDir);
  copyPageAssets(outDir);
  if (target !== 'chrome') rmSync(join(outDir, 'offscreen'), { recursive: true, force: true });

  if (withOnnx) {
    const ortSrc = join(root, 'node_modules', 'onnxruntime-web', 'dist');
    const ortOut = join(outDir, 'vendor', 'ort');
    mkdirSync(ortOut, { recursive: true });
    for (const f of ORT_FILES) {
      if (!existsSync(join(ortSrc, f))) throw new Error(`onnxruntime-web file missing: ${f} (run npm install)`);
      cpSync(join(ortSrc, f), join(ortOut, f));
    }
    writeFileSync(
      join(ortOut, 'NOTICE.txt'),
      `ONNX Runtime Web ${JSON.parse(readFileSync(join(root, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8')).version}\n` +
        'Copyright (c) Microsoft Corporation. Licensed under the MIT License.\nhttps://github.com/microsoft/onnxruntime\n',
    );
  }

  const manifest = buildManifest(target, lists);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`${target}: done → ${relative(root, outDir)} (${(dirSize(outDir) / 1e6).toFixed(1)} MB)`);
}

const t0 = Date.now();
const compiler = await loadListCompiler();
for (const t of targets) await buildTarget(t, compiler);
log(`finished in ${((Date.now() - t0) / 1000).toFixed(1)}s${args.watch ? ' — watching for changes' : ''}`);
