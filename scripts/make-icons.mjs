#!/usr/bin/env node
/**
 * Renders the CleanFeed icon (gradient rounded square with three "filter"
 * bars) to PNG at the sizes the manifest needs, using 4x4 supersampling and a
 * minimal PNG encoder — no image dependencies.
 *
 *   node scripts/make-icons.mjs   → static/icons/icon-{16,32,48,128}.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Geometry in a 32x32 design space (same as the SVG logo).
function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x <= w && y <= h;
}
function inCapsule(x, y, x1, x2, cy, r) {
  const px = Math.min(Math.max(x, x1), x2);
  return (x - px) ** 2 + (y - cy) ** 2 <= r * r;
}
const A = [0x7c, 0x5c, 0xff];
const B = [0x3b, 0x82, 0xf6];

function render(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  const bars = [
    [9, 23, 11],
    [11, 21, 16],
    [13.5, 18.5, 21],
  ];
  // Thicker bars at tiny sizes keep the glyph legible.
  const r = size <= 16 ? 1.9 : 1.3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cov = 0;
      let white = 0;
      let cr = 0, cg = 0, cb = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 32;
          const y = ((py + (sy + 0.5) / ss) / size) * 32;
          if (!inRoundedRect(x, y, 32, 32, 9)) continue;
          cov++;
          const t = Math.min(1, Math.max(0, (x + y) / 64));
          if (bars.some(([x1, x2, cy]) => inCapsule(x, y, x1, x2, cy, r))) {
            white++;
            cr += 255; cg += 255; cb += 255;
          } else {
            cr += A[0] + (B[0] - A[0]) * t;
            cg += A[1] + (B[1] - A[1]) * t;
            cb += A[2] + (B[2] - A[2]) * t;
          }
        }
      }
      const i = (py * size + px) * 4;
      if (cov) {
        buf[i] = Math.round(cr / cov);
        buf[i + 1] = Math.round(cg / cov);
        buf[i + 2] = Math.round(cb / cov);
      }
      buf[i + 3] = Math.round((cov / (ss * ss)) * 255);
      void white;
    }
  }
  return png(size, buf);
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(out, `icon-${s}.png`), render(s));
  console.log(`icon-${s}.png`);
}
