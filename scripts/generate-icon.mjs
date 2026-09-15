// Generates images/icon.png (128×128) without dependencies: supersampled shapes → PNG via zlib.
//   node scripts/generate-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 4; // samples per axis

const rgba = (hex, a = 1) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), a];
const BG = rgba('#1b2440');
const LINE = rgba('#6f86b8');
const HIT = rgba('#f2c14e');
const LENS = rgba('#2d3d6b');
const RING = rgba('#e8eefc');

const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const segmentDistance = (x, y, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
};

// "Text lines" of a log, one highlighted as a search hit.
const bars = [
  { y: 26, x1: 98, color: LINE },
  { y: 40, x1: 76, color: LINE },
  { y: 54, x1: 104, color: HIT },
  { y: 68, x1: 60, color: LINE },
  { y: 82, x1: 50, color: LINE },
  { y: 96, x1: 44, color: LINE },
];
const lens = { cx: 82, cy: 78, r: 22 };

function shade(x, y) {
  if (!roundRect(x, y, 4, 4, 124, 124, 26)) return null;
  let color = BG;
  for (const b of bars) if (roundRect(x, y, 20, b.y - 4, b.x1, b.y + 4, 4)) color = b.color;
  const d = Math.hypot(x - lens.cx, y - lens.cy);
  if (d < lens.r - 4) color = [LENS[0], LENS[1], LENS[2], 1];
  if (d >= lens.r - 4 && d <= lens.r + 4) color = RING;
  if (segmentDistance(x, y, 99, 95, 113, 109) <= 6) color = RING;
  return color;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0] * c[3];
        g += c[1] * c[3];
        b += c[2] * c[3];
        a += c[3];
      }
    }
    const i = (py * SIZE + px) * 4;
    pixels[i] = a ? Math.round(r / a) : 0;
    pixels[i + 1] = a ? Math.round(g / a) : 0;
    pixels[i + 2] = a ? Math.round(b / a) : 0;
    pixels[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('images', { recursive: true });
writeFileSync('images/icon.png', png);
console.log(`images/icon.png ${png.length} bytes`);
