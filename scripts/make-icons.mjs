/*
 * make-icons.mjs — 零依赖生成 PWA 图标（PNG，3× 超采样抗锯齿）
 * 用法: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
mkdirSync(OUT, { recursive: true });

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 绘制 ---------------- */
const SS = 3; // 超采样

function makeIcon(size, { maskable = false } = {}) {
  const S = size * SS;
  const buf = Buffer.alloc(S * S * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    // 简单的 alpha 混合
    const na = a / 255;
    buf[i] = Math.round(buf[i] * (1 - na) + r * na);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - na) + g * na);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - na) + b * na);
    buf[i + 3] = Math.max(buf[i + 3], a);
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const roundRectPath = (x, y, w, h, r) => (px, py) => {
    const cx = Math.max(x + r, Math.min(px, x + w - r));
    const cy = Math.max(y + r, Math.min(py, y + h - r));
    if (px >= x && px <= x + w && py >= y && py <= y + h) {
      const dx = px - cx;
      const dy = py - cy;
      return dx * dx + dy * dy <= r * r || (px > x + r && px < x + w - r) || (py > y + r && py < y + h - r);
    }
    return false;
  };

  // 背景（全出血的圆角方形；maskable 用满幅渐变）
  const pad = maskable ? 0 : Math.round(S * 0.055);
  const radius = maskable ? 0 : Math.round(S * 0.22);
  const inBg = roundRectPath(pad, pad, S - pad * 2, S - pad * 2, radius);
  for (let y = 0; y < S; y++) {
    const t = y / S;
    const r = lerp(24, 11, t);
    const g = lerp(36, 15, t);
    const b = lerp(58, 22, t);
    for (let x = 0; x < S; x++) {
      if (!inBg(x, y)) continue;
      put(x, y, r, g, b, 255);
    }
  }

  // 金色竖条（标志性的“声波 / 谱线”）
  const bars = [
    { cx: 0.320, h: 0.30, w: 0.075 },
    { cx: 0.440, h: 0.46, w: 0.085 },
    { cx: 0.560, h: 0.62, w: 0.095 },
    { cx: 0.680, h: 0.38, w: 0.075 },
  ];
  const innerScale = maskable ? 0.72 : 0.86;
  for (const bar of bars) {
    const bw = bar.w * S * innerScale;
    const bh = bar.h * S * innerScale;
    const cx = S * 0.5 + (bar.cx - 0.5) * S * innerScale;
    const cy = S * 0.5;
    const x0 = cx - bw / 2;
    const y0 = cy - bh / 2;
    const rr = bw / 2;
    const inBar = roundRectPath(x0, y0, bw, bh, rr);
    for (let y = Math.floor(y0) - 1; y <= Math.ceil(y0 + bh) + 1; y++) {
      for (let x = Math.floor(x0) - 1; x <= Math.ceil(x0 + bw) + 1; x++) {
        if (!inBar(x, y)) continue;
        const t = (y - y0) / Math.max(1, bh);
        put(x, y, lerp(255, 240, t), lerp(208, 160, t), lerp(74, 16, t), 255);
      }
    }
  }

  // 底部高光弧线
  const lineY = Math.round(S * 0.79);
  const lineW = Math.round(S * 0.30);
  for (let x = Math.round(S / 2 - lineW / 2); x <= Math.round(S / 2 + lineW / 2); x++) {
    for (let dy = 0; dy < Math.max(2, Math.round(S * 0.011)); dy++) put(x, lineY + dy, 120, 201, 160, 210);
  }

  // 下采样 3×（box filter）
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-1024.png', 1024, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
  ['favicon-32.png', 32, {}],
];

for (const [name, size, opts] of targets) {
  const png = makeIcon(size, opts);
  writeFileSync(join(OUT, name), png);
  console.log(`icons/${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
