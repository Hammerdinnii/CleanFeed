import type { MetadataFindings } from '../../shared/types';

/**
 * Detector: image provenance metadata.
 *
 * Reads, from the first bytes of an image file:
 *   - C2PA Content Credentials (JPEG APP11 / PNG caBX / WebP & ISOBMFF boxes):
 *     IPTC digitalSourceType (trainedAlgorithmicMedia = AI-generated,
 *     compositeWithTrainedAlgorithmicMedia = AI-edited, digitalCapture = camera)
 *     and claim generators / software agents.
 *   - XMP (Iptc4xmpExt:DigitalSourceType, CreatorTool, Credit).
 *   - EXIF (Software, ImageDescription, UserComment, Make/Model).
 *   - PNG text chunks written by generators (Stable Diffusion WebUI
 *     "parameters", ComfyUI "prompt"/"workflow", NovelAI, InvokeAI,
 *     Midjourney descriptions…).
 *
 * C2PA signatures are NOT cryptographically verified (that would require a
 * full COSE/X.509 stack); findings are reported as "Content Credentials",
 * which is honest about what we checked. Absence of metadata proves nothing —
 * most platforms strip it — so this detector only ever adds evidence.
 */

const GENERATORS: [RegExp, string][] = [
  [/midjourney/i, 'Midjourney'],
  [/stable[\s_-]?diffusion|automatic1111|sd[\s_-]?webui/i, 'Stable Diffusion'],
  [/comfyui/i, 'ComfyUI'],
  [/dall[·\-\s]?e|openai|chatgpt|gpt-image|gpt-4o/i, 'OpenAI DALL·E / ChatGPT'],
  [/adobe[\s_]?firefly|firefly/i, 'Adobe Firefly'],
  [/\bimagen\b|made with google ai|\bgemini\b|nano[\s-]?banana|synthid/i, 'Google AI (Imagen/Gemini)'],
  [/bing image creator|microsoft designer|designer\.microsoft|copilot designer/i, 'Microsoft Designer / Bing'],
  [/leonardo\.?ai/i, 'Leonardo.Ai'],
  [/novelai/i, 'NovelAI'],
  [/invokeai/i, 'InvokeAI'],
  [/fooocus/i, 'Fooocus'],
  [/\bflux(?:\.1|[\s_-](?:dev|schnell|pro|kontext))\b/i, 'FLUX'],
  [/ideogram/i, 'Ideogram'],
  [/playground\s?ai|playgroundai/i, 'Playground AI'],
  [/nightcafe/i, 'NightCafe'],
  [/dreamstudio/i, 'DreamStudio'],
  [/craiyon/i, 'Craiyon'],
  [/runway(?:ml)?/i, 'Runway'],
  [/\bsora\b/i, 'Sora'],
  [/krea\.?ai/i, 'Krea'],
  [/recraft/i, 'Recraft'],
  [/seedream|jimeng|doubao/i, 'Seedream'],
  [/\bgrok\b|xai aurora/i, 'Grok'],
  [/\b(?:qwen[\s-]?image|hunyuan(?:dit|image)?|kolors|kling)\b/i, 'Other diffusion model'],
];

function detectGenerator(s: string): string | undefined {
  for (const [re, name] of GENERATORS) if (re.test(s)) return name;
  return undefined;
}

/** Generator named in free text only when introduced as such ("Generated with Midjourney"). */
function generatedBy(s: string): string | undefined {
  const m = /\b(?:generated|created|made|rendered)\s+(?:by|with|using|in|on)\s+(.{2,60})/i.exec(s.slice(0, 1000));
  return m ? detectGenerator(m[1]!) : undefined;
}

const td = new TextDecoder('utf-8', { fatal: false });
function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  const e = Math.min(end, bytes.length);
  for (let i = start; i < e; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, e)));
  }
  return s;
}

function u16(b: Uint8Array, o: number, le = false): number {
  return le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!;
}
function u32(b: Uint8Array, o: number, le = false): number {
  return le
    ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
    : ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

interface Collected {
  c2pa: string[]; // raw text from C2PA/JUMBF payloads
  xmp: string[];
  exif: Record<string, string>;
  text: Record<string, string>; // PNG text chunks
  comments: string[];
}

// --- EXIF (TIFF) ----------------------------------------------------------------
const EXIF_TAGS: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0131: 'Software',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x9286: 'UserComment',
  0x9003: 'DateTimeOriginal',
};

function parseTiff(b: Uint8Array, out: Record<string, string>): void {
  if (b.length < 8) return;
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return;
  const readIfd = (off: number, depth: number) => {
    if (depth > 2 || off + 2 > b.length) return;
    const n = u16(b, off, le);
    for (let i = 0; i < n && i < 200; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > b.length) return;
      const tag = u16(b, e, le);
      const type = u16(b, e + 2, le);
      const count = u32(b, e + 4, le);
      if (tag === 0x8769) {
        readIfd(u32(b, e + 8, le), depth + 1); // Exif sub-IFD
        continue;
      }
      const name = EXIF_TAGS[tag];
      if (!name || count > 65536) continue;
      const size = type === 2 || type === 7 || type === 1 ? count : 0;
      if (!size) continue;
      const valOff = size <= 4 ? e + 8 : u32(b, e + 8, le);
      if (valOff + size > b.length) continue;
      let v = latin1(b, valOff, valOff + size);
      if (name === 'UserComment') v = v.replace(/^(ASCII|UNICODE|JIS)?\0*/, '');
      out[name] = v.replace(/\0+$/, '').trim();
    }
  };
  readIfd(u32(b, 4, le), 0);
}

// --- JPEG --------------------------------------------------------------------------
function parseJpeg(b: Uint8Array, c: Collected): void {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      o += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan: metadata is over
    const len = u16(b, o + 2);
    const start = o + 4;
    const end = Math.min(o + 2 + len, b.length);
    const seg = b.subarray(start, end);
    if (marker === 0xe1) {
      if (latin1(seg, 0, 6) === 'Exif\0\0') parseTiff(seg.subarray(6), c.exif);
      else if (latin1(seg, 0, 28).startsWith('http://ns.adobe.com/xap/1.0/')) c.xmp.push(td.decode(seg.subarray(29)));
      else if (latin1(seg, 0, 34).startsWith('http://ns.adobe.com/xmp/extension/')) c.xmp.push(td.decode(seg.subarray(75)));
    } else if (marker === 0xeb) {
      // APP11: JUMBF boxes carrying the C2PA manifest store.
      c.c2pa.push(latin1(seg));
    } else if (marker === 0xfe) {
      c.comments.push(td.decode(seg));
    }
    o = o + 2 + len;
  }
}

// --- PNG ---------------------------------------------------------------------------
async function inflate(data: Uint8Array): Promise<string> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) return '';
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return td.decode(new Uint8Array(buf).subarray(0, 256 * 1024));
  } catch {
    return '';
  }
}

async function parsePng(b: Uint8Array, c: Collected): Promise<void> {
  let o = 8;
  let chunks = 0;
  while (o + 12 <= b.length && chunks++ < 2000) {
    const len = u32(b, o);
    const type = latin1(b, o + 4, o + 8);
    const start = o + 8;
    const end = start + len;
    if (end > b.length) {
      // Truncated (range request): still try to read what we have of text chunks.
      if (type !== 'tEXt' && type !== 'iTXt') break;
    }
    const data = b.subarray(start, Math.min(end, b.length));
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) c.text[latin1(data, 0, z)] = latin1(data, z + 1);
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      if (z > 0) c.text[latin1(data, 0, z)] = await inflate(data.subarray(z + 2));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const key = latin1(data, 0, z);
        const compressed = data[z + 1] === 1;
        let p = z + 3;
        const lang = data.indexOf(0, p);
        p = lang < 0 ? data.length : lang + 1;
        const trans = data.indexOf(0, p);
        p = trans < 0 ? data.length : trans + 1;
        const body = data.subarray(p);
        const val = compressed ? await inflate(body) : td.decode(body);
        if (key === 'XML:com.adobe.xmp') c.xmp.push(val);
        else c.text[key] = val;
      }
    } else if (type === 'eXIf') {
      parseTiff(data, c.exif);
    } else if (type === 'caBX') {
      c.c2pa.push(latin1(data));
    } else if (type === 'IEND') {
      break;
    }
    o = end + 4;
  }
}

// --- WebP / ISOBMFF (AVIF, HEIC) -----------------------------------------------------
function parseWebp(b: Uint8Array, c: Collected): void {
  let o = 12;
  while (o + 8 <= b.length) {
    const type = latin1(b, o, o + 4);
    const len = u32(b, o + 4, true);
    const data = b.subarray(o + 8, Math.min(o + 8 + len, b.length));
    if (type === 'EXIF') parseTiff(latin1(data, 0, 6) === 'Exif\0\0' ? data.subarray(6) : data, c.exif);
    else if (type === 'XMP ') c.xmp.push(td.decode(data));
    else if (type === 'C2PA') c.c2pa.push(latin1(data));
    o += 8 + len + (len & 1);
  }
}

/** For containers we don't parse structurally, scan for embedded C2PA / XMP text. */
function scanGeneric(b: Uint8Array, c: Collected): void {
  const s = latin1(b, 0, Math.min(b.length, 512 * 1024));
  const jumb = s.indexOf('jumb');
  if (jumb >= 0 && s.indexOf('c2pa', jumb) >= 0) c.c2pa.push(s.slice(jumb, jumb + 200_000));
  const x = s.indexOf('<x:xmpmeta');
  if (x >= 0) {
    const end = s.indexOf('</x:xmpmeta>', x);
    c.xmp.push(s.slice(x, end >= 0 ? end + 12 : x + 50_000));
  }
}

// --- interpretation ------------------------------------------------------------------
const DST_AI = /trainedAlgorithmicMedia/;
const DST_COMPOSITE_AI = /compositeWithTrainedAlgorithmicMedia/;
const DST_CAMERA = /digitalsourcetype\/digitalCapture|\bdigitalCapture\b/;

export async function parseImageMetadata(bytes: Uint8Array): Promise<MetadataFindings> {
  const c: Collected = { c2pa: [], xmp: [], exif: {}, text: {}, comments: [] };
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) parseJpeg(bytes, c);
    else if (bytes[0] === 0x89 && latin1(bytes, 1, 4) === 'PNG') await parsePng(bytes, c);
    else if (latin1(bytes, 0, 4) === 'RIFF' && latin1(bytes, 8, 12) === 'WEBP') parseWebp(bytes, c);
    else scanGeneric(bytes, c);
  } catch {
    /* malformed file: report what we have */
  }
  return interpret(c);
}

function interpret(c: Collected): MetadataFindings {
  const evidence: string[] = [];
  let verdict: MetadataFindings['verdict'] = 'unknown';
  let generator: string | undefined;
  const raise = (v: MetadataFindings['verdict'], why: string, gen?: string) => {
    const rank = { unknown: 0, camera: 1, 'edited-with-ai': 2, ai: 3 };
    if (rank[v] > rank[verdict]) verdict = v;
    if (!evidence.includes(why)) evidence.push(why);
    if (gen && !generator) generator = gen;
  };

  // C2PA manifest store.
  const c2pa = c.c2pa.join('\n');
  const hasC2pa = /c2pa/i.test(c2pa);
  if (hasC2pa) {
    const gen = detectGenerator(c2pa.slice(0, 400_000));
    if (DST_COMPOSITE_AI.test(c2pa)) raise('edited-with-ai', 'Content Credentials: edited with generative AI', gen);
    else if (DST_AI.test(c2pa)) raise('ai', 'Content Credentials: created by generative AI', gen);
    else if (DST_CAMERA.test(c2pa)) raise('camera', 'Content Credentials: captured with a camera');
    // Fallback: manifests that name a known generator in their claim / softwareAgent.
    else if (gen && /claim_generator|softwareAgent/i.test(c2pa)) raise('ai', `Content Credentials: created with ${gen}`, gen);
  }

  // XMP (IPTC digital source type, creator tool).
  const xmp = c.xmp.join('\n');
  if (xmp) {
    if (DST_COMPOSITE_AI.test(xmp)) raise('edited-with-ai', 'IPTC: composite with AI-generated content');
    else if (DST_AI.test(xmp)) raise('ai', 'IPTC: AI-generated (digital source type)');
    const tool = /(?:xmp:CreatorTool|tiff:Software|photoshop:Credit|dc:creator)[^>]*?(?:=|>)\s*"?([^"<]{2,120})/i.exec(xmp)?.[1];
    const gen = tool ? detectGenerator(tool) : /made with google ai/i.test(xmp) ? 'Google AI (Imagen/Gemini)' : undefined;
    if (gen) raise('ai', `XMP: made with ${gen}`, gen);
    if (DST_CAMERA.test(xmp)) raise('camera', 'IPTC: digital capture');
  }

  // PNG text chunks from local/web generators.
  const t = c.text;
  if (t['parameters'] && /\bSteps:\s*\d+/.test(t['parameters']) && /Sampler:|CFG scale:|Seed:/.test(t['parameters'])) {
    raise('ai', 'PNG: Stable Diffusion generation parameters', 'Stable Diffusion');
  }
  if ((t['prompt'] && /"class_type"\s*:/.test(t['prompt'])) || (t['workflow'] && /"nodes"\s*:/.test(t['workflow']))) {
    raise('ai', 'PNG: ComfyUI workflow', 'ComfyUI');
  }
  if (t['invokeai_metadata'] || t['sd-metadata'] || t['Dream']) raise('ai', 'PNG: InvokeAI metadata', 'InvokeAI');
  if (t['fooocus_scheme'] || /fooocus/i.test(t['parameters'] ?? '')) raise('ai', 'PNG: Fooocus metadata', 'Fooocus');
  if (t['Software'] === 'NovelAI' || (t['Comment'] && /"(?:steps|sampler|uc)"\s*:/.test(t['Comment']))) raise('ai', 'PNG: NovelAI metadata', 'NovelAI');
  if (t['Description'] && /Job ID:\s*[0-9a-f-]{20,}/i.test(t['Description'])) raise('ai', 'PNG: Midjourney job metadata', 'Midjourney');
  for (const [k, v] of Object.entries(t)) {
    // Tool-name fields are matched directly; free-text fields need explicit "generated with …" phrasing.
    const gen = /^(?:Software|Source|Generator)$/i.test(k)
      ? detectGenerator(v.slice(0, 200))
      : /^(?:Author|Title|Description|Comment)$/i.test(k)
        ? generatedBy(v)
        : undefined;
    if (gen) raise('ai', `PNG ${k}: ${gen}`, gen);
  }

  // EXIF.
  const e = c.exif;
  if (e.Software) {
    const gen = detectGenerator(e.Software.slice(0, 200));
    if (gen) raise('ai', `EXIF Software: ${gen}`, gen);
  }
  for (const field of ['ImageDescription', 'UserComment'] as const) {
    const v = e[field];
    if (!v) continue;
    if (/\bSteps:\s*\d+.*Sampler:/s.test(v)) raise('ai', 'EXIF: Stable Diffusion parameters', 'Stable Diffusion');
    const gen = generatedBy(v);
    if (gen) raise('ai', `EXIF ${field}: ${gen}`, gen);
  }
  for (const com of c.comments) {
    const gen = generatedBy(com);
    if (gen) raise('ai', `JPEG comment: ${gen}`, gen);
  }
  if (verdict === 'unknown' && e.Make && e.Model && e.DateTimeOriginal) {
    raise('camera', `EXIF: ${e.Make.trim()} ${e.Model.trim()}`);
  }

  return { verdict, evidence, generator, hasC2pa };
}
