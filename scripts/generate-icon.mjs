// Generates assets/icon.png (640×640) in the fogio extension icon style: a full-bleed rounded
// square in a muted color with a bold white glyph. No dependencies: supersampled shapes → PNG.
//   node scripts/generate-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 640;
const SS = 3; // samples per axis
const RADIUS = 120; // same corner radius as the other fogio icons

const BG = [0x9a, 0x5c, 0xa3];
const FG = [0xff, 0xff, 0xff];

const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const capsule = (x, y, ax, ay, bx, by, r) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= r;
};

// Glyph: a magnifier over two lines of text — viewing and searching inside a file.
// Same geometry as the 32-unit SVG on fogio.org (×20): stroke 2.4 → 48 px.
const lens = { cx: 290, cy: 290, inner: 120, outer: 168 };

function shade(x, y) {
  if (!roundRect(x, y, 0, 0, SIZE, SIZE, RADIUS)) return null;
  const d = Math.hypot(x - lens.cx, y - lens.cy);
  const glyph =
    (d >= lens.inner && d <= lens.outer) ||
    capsule(x, y, 392, 392, 500, 500, 24) ||
    capsule(x, y, 230, 250, 350, 250, 24) ||
    capsule(x, y, 230, 330, 310, 330, 24);
  return glyph ? FG : BG;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        n++;
      }
    }
    const i = (py * SIZE + px) * 4;
    pixels[i] = n ? Math.round(r / n) : 0;
    pixels[i + 1] = n ? Math.round(g / n) : 0;
    pixels[i + 2] = n ? Math.round(b / n) : 0;
    pixels[i + 3] = Math.round((n / (SS * SS)) * 255);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.png', png);
console.log(`assets/icon.png ${png.length} bytes`);
