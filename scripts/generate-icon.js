/**
 * Generates media/pulse-icon.png – a 128×128 PNG icon for the extension.
 * Uses only Node.js built-ins (zlib). Run with: node scripts/generate-icon.js
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const SIZE = 128;

// ── CRC-32 ────────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const l = Buffer.alloc(4);
  l.writeUInt32BE(data.length, 0);
  const cc = Buffer.alloc(4);
  cc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([l, t, data, cc]);
}

// ── Pixel buffer (RGB) ────────────────────────────────────────────────
const px = Buffer.alloc(SIZE * SIZE * 3);

// Background colour: #0f172a (navy)
for (let i = 0; i < SIZE * SIZE; i++) {
  px[i * 3] = 15;
  px[i * 3 + 1] = 23;
  px[i * 3 + 2] = 42;
}

function setPixel(x, y, r, g, b) {
  const xi = Math.round(x),
    yi = Math.round(y);
  if (xi >= 0 && xi < SIZE && yi >= 0 && yi < SIZE) {
    px[(yi * SIZE + xi) * 3] = r;
    px[(yi * SIZE + xi) * 3 + 1] = g;
    px[(yi * SIZE + xi) * 3 + 2] = b;
  }
}

function drawLine(x0, y0, x1, y1, r, g, b, th) {
  const dx = x1 - x0,
    dy = y1 - y0;
  const steps = Math.ceil(Math.sqrt(dx * dx + dy * dy) * 2) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps,
      cx = x0 + dx * t,
      cy = y0 + dy * t;
    for (let tx = -th; tx <= th; tx++)
      for (let ty = -th; ty <= th; ty++)
        if (tx * tx + ty * ty <= th * th) setPixel(cx + tx, cy + ty, r, g, b);
  }
}

function drawArc(cx, cy, radius, a0, a1, r, g, b, th) {
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + (a1 - a0) * (i / steps)) * (Math.PI / 180);
    const x = cx + radius * Math.cos(a),
      y = cy + radius * Math.sin(a);
    for (let tx = -th; tx <= th; tx++)
      for (let ty = -th; ty <= th; ty++)
        if (tx * tx + ty * ty <= th * th) setPixel(x + tx, y + ty, r, g, b);
  }
}

// ── Rounded-rect border (#3f4450 – subtle slate) ──────────────────────
const M = 10,
  R = 16,
  [br, bg, bb] = [63, 68, 80];
drawLine(M + R, M, SIZE - M - R, M, br, bg, bb, 1.5); // top
drawLine(M + R, SIZE - M, SIZE - M - R, SIZE - M, br, bg, bb, 1.5); // bottom
drawLine(M, M + R, M, SIZE - M - R, br, bg, bb, 1.5); // left
drawLine(SIZE - M, M + R, SIZE - M, SIZE - M - R, br, bg, bb, 1.5); // right
drawArc(M + R, M + R, R, 180, 270, br, bg, bb, 1.5); // TL
drawArc(SIZE - M - R, M + R, R, 270, 360, br, bg, bb, 1.5); // TR
drawArc(M + R, SIZE - M - R, R, 90, 180, br, bg, bb, 1.5); // BL
drawArc(SIZE - M - R, SIZE - M - R, R, 0, 90, br, bg, bb, 1.5); // BR

// ── Amber glow backdrop for waveform (soft ellipse) ───────────────────
const GCX = SIZE / 2,
  GCY = SIZE / 2,
  GRX = 42,
  GRY = 22;
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    const dx = (x - GCX) / GRX,
      dy = (y - GCY) / GRY;
    const dist = dx * dx + dy * dy;
    if (dist < 1) {
      const alpha = Math.max(0, (1 - dist) * 0.07);
      const i = (y * SIZE + x) * 3;
      px[i] = Math.min(255, px[i] + Math.round(245 * alpha));
      px[i + 1] = Math.min(255, px[i + 1] + Math.round(158 * alpha));
      px[i + 2] = Math.min(255, px[i + 2] + Math.round(11 * alpha));
    }
  }

// ── Pulse waveform (#f59e0b amber) ────────────────────────────────────
// SVG viewBox 0 0 24 24; map into canvas with padding
const SC = 4.6,
  OX = (SIZE - 24 * SC) / 2,
  OY = (SIZE - 24 * SC) / 2;
const svgX = (x) => OX + x * SC,
  svgY = (y) => OY + y * SC;

// Control points for an ECG-style trace
const wave = [
  [3.5, 12.5],
  [6.0, 12.5],
  [7.0, 10.2],
  [8.0, 16.5],
  [9.0, 4.5], // main spike up
  [10.0, 14.5],
  [11.0, 10.5],
  [12.2, 12.5],
  [13.2, 11.2],
  [14.5, 12.5],
  [20.5, 12.5],
];

for (let i = 0; i < wave.length - 1; i++) {
  drawLine(
    svgX(wave[i][0]),
    svgY(wave[i][1]),
    svgX(wave[i + 1][0]),
    svgY(wave[i + 1][1]),
    245,
    158,
    11,
    2.2,
  );
}

// ── Encode PNG ────────────────────────────────────────────────────────
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 2; // 8-bit RGB

const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 3)] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const s = (y * SIZE + x) * 3,
      d = y * (1 + SIZE * 3) + 1 + x * 3;
    raw[d] = px[s];
    raw[d + 1] = px[s + 1];
    raw[d + 2] = px[s + 2];
  }
}

const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  makeChunk("IHDR", ihdr),
  makeChunk("IDAT", idat),
  makeChunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "media", "pulse-icon.png");
fs.writeFileSync(out, png);
console.log(`Generated ${out} (${png.length} bytes)`);
