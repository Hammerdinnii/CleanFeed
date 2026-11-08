import { api } from '../../shared/api';
import { HAS_ONNX } from '../../shared/env';
import { sha256Hex } from '../../shared/hash';
import { idbDelete, idbPut } from '../../shared/idb';
import { send } from '../../shared/messages';
import { getOne, setLocal } from '../../shared/storage';
import type { AiMode, DetectorId, ModelManifest, Sensitivity, SiteId } from '../../shared/types';
import { h, pickFile, segmented, selectEl, toast, toggleRow } from '../../ui/dom';
import { confirmAction, errorText, field, padPanel, page, panel, save, settings } from '../common';

/** AI filtering settings and local image model management. */

const MODES: { value: AiMode; label: string; title: string }[] = [
  { value: 'collapse', label: 'Collapse', title: 'Hide behind a compact bar with “Show anyway”' },
  { value: 'blur', label: 'Blur', title: 'Blur with a bar to reveal' },
  { value: 'dim', label: 'Dim', title: 'Fade out; hover to read' },
  { value: 'label', label: 'Label only', title: 'Only add a small badge' },
];

const DETECTORS: [DetectorId, string, string][] = [
  ['platformLabels', 'Platform labels & disclosures', 'YouTube “Altered or synthetic content”, “Made with AI”, AI flairs, Community Notes, Google AI Overviews'],
  ['metadata', 'Image metadata & Content Credentials', 'C2PA, IPTC digital source type, generator tags in EXIF/XMP/PNG'],
  ['textPatterns', 'AI writing patterns', 'Phrase and structure tells, em-dash overuse, staccato paragraphs (editable list)'],
  ['textStats', 'Statistical text scoring', 'Sentence uniformity and style; only ever corroborates other signals'],
  ['imageModel', 'Local image model (ONNX)', 'Runs a classifier you install on this device'],
  ['blocklist', 'Creator & community blocklists', 'Your blocklist, subscribed community lists, known AI-art communities'],
  ['keywords', 'Keyword rules', 'Your own phrases and regular expressions'],
];

const SITES: [SiteId, string][] = [
  ['twitter', 'X / Twitter'],
  ['youtube', 'YouTube (incl. Shorts)'],
  ['google', 'Google Search'],
  ['reddit', 'Reddit'],
  ['linkedin', 'LinkedIn'],
  ['generic', 'All other websites'],
];

export async function aiSection(): Promise<HTMLElement> {
  const a = settings.ai;
  return page(
    'AI content filter',
    'Detects AI-generated text and images by combining several local signals into one confidence score. It is tuned to avoid false positives: a single weak hint never hides anything.',
    panel(
      toggleRow('Filter AI-generated content', a.enabled, (v) => void save((x) => (x.ai.enabled = v))),
      field('What to do with flagged content', 'Every treatment is reversible from the item itself.', segmented(MODES, a.mode, (v) => void save((x) => (x.ai.mode = v)), 'AI treatment')),
      field(
        'Sensitivity',
        'Low = only near-certain items. High = more coverage, more mistakes.',
        segmented<Sensitivity>(
          [
            { value: 'low', label: 'Low' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'high', label: 'High' },
          ],
          a.sensitivity,
          (v) => void save((x) => (x.ai.sensitivity = v)),
          'Sensitivity',
        ),
      ),
      toggleRow('Show reasons and confidence', a.showReasons, (v) => void save((x) => (x.ai.showReasons = v)), 'e.g. “AI writing patterns · 82%”'),
    ),
    h('h2', null, 'Sites'),
    panel(
      ...SITES.map(([id, label]) => toggleRow(label, a.sites[id], (v) => void save((x) => (x.ai.sites[id] = v)), id === 'generic' ? 'Articles and large images on any page' : undefined)),
      field('Treatment on other websites', 'Heuristics are less reliable without site context, so this defaults to labels.', selectEl(MODES.map(({ value, label }) => ({ value, label })), a.genericMode, (v) => void save((x) => (x.ai.genericMode = v)), 'Generic mode')),
      field(
        'Google AI Overviews',
        null,
        selectEl(
          [
            { value: 'collapse', label: 'Collapse (Show anyway)' },
            { value: 'show', label: 'Show' },
          ],
          a.googleAiOverview,
          (v) => void save((x) => (x.ai.googleAiOverview = v)),
          'Google AI Overviews',
        ),
      ),
      toggleRow('Hide Google “AI Mode” tab', a.hideGoogleAiMode, (v) => void save((x) => (x.ai.hideGoogleAiMode = v))),
    ),
    h('h2', null, 'Detectors'),
    panel(...DETECTORS.map(([id, label, desc]) => toggleRow(label, a.detectors[id], (v) => void save((x) => (x.ai.detectors[id] = v)), desc))),
    h('h2', null, 'Tuning'),
    panel(
      field('Minimum words for text heuristics', 'Shorter posts need stronger evidence.', numberInput(a.minWords, 10, 400, (v) => save((x) => (x.ai.minWords = v)))),
      field('Minimum image size (px)', null, numberInput(a.imageMinPx, 64, 1024, (v) => save((x) => (x.ai.imageMinPx = v)))),
      toggleRow('Read image metadata', a.fetchImageMetadata, (v) => void save((x) => (x.ai.fetchImageMetadata = v)), 'Re-reads the first 256 KB of large images from their own server, without cookies'),
      toggleRow('Analyze images on other websites', a.genericImages, (v) => void save((x) => (x.ai.genericImages = v))),
    ),
  );
}

function numberInput(value: number, min: number, max: number, onChange: (v: number) => Promise<void>): HTMLInputElement {
  const i = h('input', { type: 'number', class: 'narrow', value: String(value), min: String(min), max: String(max) });
  i.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Math.round(Number(i.value) || value)));
    i.value = String(v);
    void onChange(v);
  });
  return i;
}

const PRESETS: Record<string, { label: string; mean: [number, number, number]; std: [number, number, number] }> = {
  imagenet: { label: 'ImageNet (ViT, ConvNeXt, ResNet, EfficientNet)', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  clip: { label: 'CLIP', mean: [0.4815, 0.4578, 0.4082], std: [0.2686, 0.2613, 0.2758] },
  half: { label: '[-1, 1] (SigLIP, Inception)', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
  unit: { label: '[0, 1] (no normalization)', mean: [0, 0, 0], std: [1, 1, 1] },
};

function manifestForm(defaults: Partial<ModelManifest>, onSubmit: (m: Omit<ModelManifest, 'id' | 'sha256' | 'sizeBytes'>) => void): HTMLElement {
  const name = h('input', { type: 'text', value: defaults.name ?? 'Custom AI-image detector', 'aria-label': 'Model name' });
  const size = h('input', { type: 'number', class: 'narrow', value: String(Array.isArray(defaults.inputSize) ? defaults.inputSize[0] : defaults.inputSize ?? 224), 'aria-label': 'Input size' });
  let preset = 'imagenet';
  const presetSel = selectEl(Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), preset, (v) => (preset = v), 'Normalization');
  let layout: 'NCHW' | 'NHWC' = defaults.layout ?? 'NCHW';
  let output: ModelManifest['output'] = defaults.output ?? 'softmax';
  const aiIndex = h('input', { type: 'number', class: 'narrow', value: String(defaults.aiIndex ?? 1), min: '0', 'aria-label': 'AI class index' });
  let resize: ModelManifest['resize'] = defaults.resize ?? 'center-crop';
  const submit = h('button', { class: 'btn primary' }, 'Install model');
  submit.addEventListener('click', () => {
    const p = PRESETS[preset]!;
    onSubmit({
      name: name.value.trim() || 'Custom model',
      inputSize: Math.max(32, Math.min(1024, Number(size.value) || 224)),
      layout,
      mean: defaults.mean ?? p.mean,
      std: defaults.std ?? p.std,
      output,
      aiIndex: Math.max(0, Number(aiIndex.value) || 0),
      resize,
      labels: defaults.labels,
      inputName: defaults.inputName,
      outputName: defaults.outputName,
      source: defaults.source,
      license: defaults.license,
    });
  });
  return h(
    'div',
    null,
    field('Name', null, name),
    field('Input size', 'Square input in pixels (224, 256, 384…)', size),
    field('Normalization', defaults.mean ? 'Taken from the manifest file' : null, presetSel),
    field('Tensor layout', null, segmented([{ value: 'NCHW', label: 'NCHW' }, { value: 'NHWC', label: 'NHWC' }], layout, (v) => (layout = v))),
    field('Output', 'softmax = logits per class · sigmoid = single logit · probabilities = already normalized', selectEl([{ value: 'softmax', label: 'softmax' }, { value: 'sigmoid', label: 'sigmoid' }, { value: 'probabilities', label: 'probabilities' }], output, (v) => (output = v))),
    field('Index of the “AI / fake” class', defaults.labels ? `Labels: ${defaults.labels.join(', ')}` : 'For sigmoid outputs: 0 if the logit means “AI”, 1 if it means “real”', aiIndex),
    field('Resize', null, segmented([{ value: 'center-crop', label: 'Center crop' }, { value: 'stretch', label: 'Stretch' }], resize, (v) => (resize = v))),
    h('div', { class: 'toolbar' }, submit),
  );
}

async function installModel(bytes: ArrayBuffer, meta: Omit<ModelManifest, 'id' | 'sha256' | 'sizeBytes'>): Promise<void> {
  const sha = await sha256Hex(bytes);
  const manifest: ModelManifest = { ...meta, id: `model-${sha.slice(0, 12)}`, sha256: sha, sizeBytes: bytes.byteLength };
  await idbPut('models', 'active', { manifest, bytes });
  await setLocal({ modelManifest: manifest });
  const st = await send('ui:modelChanged', {});
  if (st.error) toast(`Installed, but loading failed: ${st.error}`, 'error');
  else toast(`Model installed${st.backend ? ` (${st.backend})` : ''}`);
}

export async function modelSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    container.replaceChildren();
    const manifest = await getOne('modelManifest');
    if (!HAS_ONNX) {
      container.append(padPanel(h('p', null, 'This build of CleanFeed was made without ONNX Runtime (--no-onnx), so image models are unavailable. Metadata-based image detection still works.')));
      return;
    }
    const statusBox = padPanel(
      manifest
        ? h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Model'),
            h('dd', null, manifest.name),
            h('dt', null, 'Size'),
            h('dd', null, `${((manifest.sizeBytes ?? 0) / 1e6).toFixed(1)} MB`),
            h('dt', null, 'Input'),
            h('dd', null, `${Array.isArray(manifest.inputSize) ? manifest.inputSize.join('×') : `${manifest.inputSize}×${manifest.inputSize}`} ${manifest.layout}, ${manifest.output}, AI class #${manifest.aiIndex}`),
            h('dt', null, 'SHA-256'),
            h('dd', null, h('code', { class: 'code' }, manifest.sha256 ?? '—')),
          )
        : h('p', null, 'No image model installed. Text, label, blocklist and metadata detection work without one.'),
      h(
        'div',
        { class: 'toolbar' },
        manifest
          ? h('button', { class: 'btn', on: { click: async () => {
              toast('Running test…');
              const r = await send('ui:modelTest', {});
              toast(r.ok ? `OK · ${r.backend} · ${r.ms} ms · test score ${(r.score ?? 0).toFixed(2)}` : `Test failed: ${r.error}`, r.ok ? 'info' : 'error');
            } } }, 'Test model')
          : null,
        manifest
          ? h('button', { class: 'btn danger', on: { click: async () => {
              if (!confirmAction('Remove the installed model?')) return;
              await idbDelete('models', 'active');
              await setLocal({ modelManifest: null });
              await send('ui:modelChanged', {});
              await render();
            } } }, 'Remove model')
          : null,
        h('button', { class: 'btn', on: { click: async () => { await send('ui:clearImageCache', {}); toast('Image cache cleared'); } } }, 'Clear image cache'),
      ),
    );

    const formHost = h('div');
    let pendingBytes: ArrayBuffer | null = null;
    let manifestDefaults: Partial<ModelManifest> = {};
    const showForm = () => {
      formHost.replaceChildren(
        padPanel(
          h('p', { class: 'help' }, `Model file loaded (${((pendingBytes?.byteLength ?? 0) / 1e6).toFixed(1)} MB). Describe its preprocessing:`),
          manifestForm(manifestDefaults, async (m) => {
            if (!pendingBytes) return;
            try {
              await installModel(pendingBytes, m);
              pendingBytes = null;
              await render();
            } catch (err) {
              toast(errorText(err), 'error');
            }
          }),
        ),
      );
    };
    const importBtn = h('button', { class: 'btn primary', on: { click: async () => {
      const f = await pickFile('.onnx,application/octet-stream');
      if (!f) return;
      if (f.size > 600e6) return toast('That file is larger than 600 MB', 'error');
      pendingBytes = await f.arrayBuffer();
      showForm();
    } } }, 'Import .onnx file…');
    const manifestBtn = h('button', { class: 'btn', on: { click: async () => {
      const f = await pickFile('.json,application/json');
      if (!f) return;
      try {
        manifestDefaults = JSON.parse(await f.text()) as Partial<ModelManifest>;
        toast('Manifest loaded');
        if (pendingBytes) showForm();
      } catch {
        toast('Invalid JSON', 'error');
      }
    } } }, 'Load manifest .json…');

    const urlInput = h('input', { type: 'url', class: 'wide', placeholder: 'https://…/model_quantized.onnx', 'aria-label': 'Model URL' });
    const dlBtn = h('button', { class: 'btn', on: { click: async () => {
      const url = urlInput.value.trim();
      if (!/^https:\/\//i.test(url)) return toast('Use an https:// URL', 'error');
      if (!confirmAction('CleanFeed will download this model file from the URL you entered. Only the file is requested; no browsing data is sent. Continue?')) return;
      dlBtn.disabled = true;
      dlBtn.textContent = 'Downloading…';
      try {
        const granted = await ensureOrigin(url);
        if (!granted) throw new Error('Permission to access that host was not granted');
        const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        pendingBytes = await resp.arrayBuffer();
        showForm();
      } catch (err) {
        toast(`Download failed: ${errorText(err)}`, 'error');
      } finally {
        dlBtn.disabled = false;
        dlBtn.textContent = 'Download';
      }
    } } }, 'Download');

    container.append(
      statusBox,
      h('h2', null, 'Install a model'),
      padPanel(
        h('p', { class: 'help' }, 'CleanFeed runs any ONNX image classifier locally with ONNX Runtime Web (WebGPU when available, WASM otherwise). A quantized ViT-S/ConvNeXt-T sized detector (20–90 MB) gives a good speed/accuracy balance. See the README for converting a Community Forensics-style detector to ONNX.'),
        h('div', { class: 'toolbar' }, importBtn, manifestBtn),
        h('div', { class: 'toolbar' }, urlInput, dlBtn),
        formHost,
      ),
      h('h2', null, 'Inference'),
      panel(
        field(
          'Backend',
          'Auto picks WebGPU when your browser exposes it.',
          segmented(
            [
              { value: 'auto', label: 'Auto' },
              { value: 'webgpu', label: 'WebGPU' },
              { value: 'wasm', label: 'WASM' },
            ],
            settings.ai.imageBackend,
            (v) => void save((x) => (x.ai.imageBackend = v)).then(() => send('ui:modelChanged', {})),
          ),
        ),
        field('Model confidence threshold', 'Raw model probability at which an image counts as AI on its own (Balanced sensitivity).', numberInput(Math.round(settings.ai.imageModelThreshold * 100), 50, 99, (v) => save((x) => (x.ai.imageModelThreshold = v / 100)))),
      ),
    );
  };
  await render();
  return page('Image model', 'Optional local image classifier. Results are cached by image hash so each image is analyzed once.', container);
}

async function ensureOrigin(url: string): Promise<boolean> {
  const origin = new URL(url).origin + '/*';
  try {
    if (await api.permissions.contains({ origins: [origin] })) return true;
    return await api.permissions.request({ origins: [origin] });
  } catch {
    return true; // <all_urls> already granted on most installs
  }
}
