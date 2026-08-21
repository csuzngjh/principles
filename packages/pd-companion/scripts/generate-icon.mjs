/**
 * Generate assets/icon.png for PD Companion with a contrast-safe design.
 *
 * Problem being fixed (owner report 2026-08-21): the previous icon was the
 * brand glyph (#243B53 navy strokes) on a fully transparent canvas. On the
 * default dark Windows taskbar the navy strokes vanish and only the small
 * amber dot stays visible.
 *
 * Fix: keep the exact brand mark (logo.svg geometry: two vertical strokes +
 * one horizontal stroke + center dot) but put it on an opaque warm off-white
 * rounded plate (#FAFAF7, the site's light-surface color) and enlarge the dot.
 * Light plate + dark strokes reads on both dark and light taskbars.
 *
 * Zero-dependency: SDF rasterization with 3x3 supersampling + minimal PNG
 * encoder (zlib is a Node builtin). Run: node scripts/generate-icon.mjs
 * Outputs: assets/icon.png (512) and .tmp/icon-preview.png (dark/light strips).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Brand palette (from packages/website/public/images/logo.svg)
const NAVY = [0x24, 0x3b, 0x53];
const AMBER = [0xb7, 0x79, 0x1f];
const PLATE = [0xfa, 0xfa, 0xf7];

// Scene in a 512x512 design space
const PLATE_MARGIN = 26;
const PLATE_RADIUS = 100;
const STROKE = 26; // capsule diameter
const BAR_X = [152, 360];
const BAR_Y = [51, 461];
const CROSS_Y = 256;
const CROSS_X = [48, 464];
const DOT_R = 44;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function len(x, y) { return Math.hypot(x, y); }

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const t = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return len(pax - bax * t, pay - bay * t) - r;
}
function sdCircle(px, py, cx, cy, r) { return len(px - cx, py - cy) - r; }

// Coverage of shape i at design-space point, half-pixel corrected
function coverage(dist) { return clamp(0.5 - dist, 0, 1); }

/** Render the icon into size x size RGBA buffer. bg = [r,g,b] | null (transparent). */
function render(size, bg) {
  const s = size / 512;
  const px = new Uint8Array(size * size * 4);
  const SS = size >= 128 ? 3 : 4; // more supersampling when tiny
  const off = [];
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) off.push([(sx + 0.5) / SS, (sy + 0.5) / SS]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of off) {
        const dx = (x + ox) / s, dy = (y + oy) / s;
        // layers: plate -> strokes -> dot (src-over in that order)
        const aPlate = coverage(sdRoundRect(dx, dy, PLATE_MARGIN, PLATE_MARGIN, 512 - PLATE_MARGIN, 512 - PLATE_MARGIN, PLATE_RADIUS));
        const aStroke = Math.max(
          coverage(sdCapsule(dx, dy, BAR_X[0], BAR_Y[0], BAR_X[0], BAR_Y[1], STROKE / 2)),
          coverage(sdCapsule(dx, dy, BAR_X[1], BAR_Y[0], BAR_X[1], BAR_Y[1], STROKE / 2)),
          coverage(sdCapsule(dx, dy, CROSS_X[0], CROSS_Y, CROSS_X[1], CROSS_Y, STROKE / 2)),
        );
        const aDot = coverage(sdCircle(dx, dy, 256, 256, DOT_R));

        // start from background
        let cr, cg, cb, ca;
        if (bg) { [cr, cg, cb] = bg; ca = 1; } else { cr = cg = cb = 0; ca = 0; }
        // plate over bg
        if (aPlate > 0) { cr = PLATE[0]; cg = PLATE[1]; cb = PLATE[2]; ca = aPlate + ca * (1 - aPlate); }
        // strokes over plate
        if (aStroke > 0) { cr = NAVY[0]; cg = NAVY[1]; cb = NAVY[2]; ca = aStroke + ca * (1 - aStroke); }
        // dot over all
        if (aDot > 0) { cr = AMBER[0]; cg = AMBER[1]; cb = AMBER[2]; ca = aDot + ca * (1 - aDot); }

        r += cr; g += cg; b += cb; a += ca;
      }
      const n = off.length, i = (y * size + x) * 4;
      px[i] = Math.round(r / n); px[i + 1] = Math.round(g / n); px[i + 2] = Math.round(b / n); px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// --- minimal PNG encoder (color type 6, filter 0) ---
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- outputs ---
writeFileSync(path.join(ROOT, 'assets', 'icon.png'), encodePng(render(512, null), 512));
console.log('wrote assets/icon.png (512x512)');

// Preview sheet: icon on dark taskbar-like and light strips at several sizes
mkdirSync(path.join(ROOT, '..', '..', '.tmp'), { recursive: true });
const SIZES = [128, 64, 48, 32, 16];
const W = 512, H = 320, MID = 160;
const DARK = [0x11, 0x18, 0x27], LIGHT = [0xf3, 0xf4, 0xf6];
const sheet = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const [bg] = y < MID ? [DARK] : [LIGHT];
    const i = (y * W + x) * 4;
    sheet[i] = bg[0]; sheet[i + 1] = bg[1]; sheet[i + 2] = bg[2]; sheet[i + 3] = 255;
  }
}
let cursor = 16;
for (const size of SIZES) {
  const icon = render(size, null);
  for (const baseY of [Math.round((MID - size) / 2), MID + Math.round((MID - size) / 2)]) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const si = (y * size + x) * 4;
        const sa = icon[si + 3] / 255;
        if (sa === 0) continue;
        const di = ((baseY + y) * W + (cursor + x)) * 4;
        for (let c = 0; c < 3; c++) sheet[di + c] = Math.round(icon[si + c] * sa + sheet[di + c] * (1 - sa));
      }
    }
  }
  cursor += size + 16;
}
writeFileSync(path.join(ROOT, '..', '..', '.tmp', 'icon-preview.png'), encodePngRect(sheet, W, H));
console.log('wrote .tmp/icon-preview.png');

// encodePng is square-only; add a rect wrapper for the sheet
function encodePngRect(px, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
