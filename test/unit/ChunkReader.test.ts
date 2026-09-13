import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChunkReader, countLinesToEnd, countNewlines, MAX_LINE_BYTES, type ChunkReaderOptions } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { LineIndex, LineStartScanner } from '../../src/core/LineIndex';
import { buildIndex, EDGE_CASES, enc, naiveLines, naiveText, tmpDir } from './helpers';

const dir = tmpDir('reader');
const pool = new FileHandlePool({ idleMs: 50 });
afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

let fileNo = 0;
function writeFile(content: string | Uint8Array): { file: string; data: Uint8Array } {
  const data = typeof content === 'string' ? enc(content) : content;
  const file = path.join(dir, `f${fileNo++}.txt`);
  fs.writeFileSync(file, data);
  return { file, data };
}

function readerFor(content: string | Uint8Array, stride = 1, opts: ChunkReaderOptions = {}): ChunkReader {
  const { file, data } = writeFile(content);
  return new ChunkReader(pool, file, buildIndex(data, { stride, chunkSize: 5 }), opts);
}

const CONFIGS: Array<{ name: string; stride: number; opts: ChunkReaderOptions }> = [
  { name: 'stride 1, default blocks', stride: 1, opts: {} },
  { name: 'stride 3, default blocks', stride: 3, opts: {} },
  { name: 'stride 2, tiny blocks', stride: 2, opts: { blockBytes: 5, scanBytes: 3 } },
  { name: 'stride 7, tiny blocks', stride: 7, opts: { blockBytes: 4, scanBytes: 1 } },
];

describe.each(CONFIGS)('ChunkReader ($name)', ({ stride, opts }) => {
  for (const [caseName, text] of Object.entries(EDGE_CASES)) {
    it(`reads every range exactly: ${caseName}`, async () => {
      const r = readerFor(text, stride, opts);
      const expected = naiveText(enc(text));
      for (let a = 0; a <= expected.length; a++) {
        for (let n = 1; a + n <= expected.length + 1; n++) {
          const res = await r.readLines(a, n);
          expect(res.lines).toEqual(expected.slice(a, a + n));
          expect(res.start).toBe(a);
        }
      }
    });

    it(`lineStart and offsetToLine: ${caseName}`, async () => {
      const data = enc(text);
      const r = readerFor(data, stride, opts);
      const lines = naiveLines(data);
      for (let i = 0; i < lines.length; i++) expect(await r.lineStart(i)).toBe(lines[i]?.[0]);
      for (let off = 0; off < data.length + 3; off++) {
        const idx = lines.findIndex(([s, e]) => off >= s && off < e);
        expect(await r.offsetToLine(off)).toBe(idx === -1 ? lines.length - 1 : idx);
      }
    });
  }

  it('decodes multi-byte characters straddling block boundaries', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `${'я'.repeat(i % 5)}🚀${'ж'.repeat(i % 3)}`).join('\r\n');
    const r = readerFor(text, stride, opts);
    expect((await r.readLines(0, 30)).lines).toEqual(naiveText(enc(text)));
  });

  it('does not truncate a line of exactly MAX_LINE_BYTES plus \\r\\n', async () => {
    const line = 'x'.repeat(MAX_LINE_BYTES);
    const r = readerFor(`${line}\r\nnext`, stride, opts);
    const res = await r.readLines(0, 2);
    expect(res.truncated).toEqual([]);
    expect(res.lines).toEqual([line, 'next']);
  });

  it('truncates long lines at a character boundary and continues after them', async () => {
    // 'я' is 2 bytes; the odd prefix makes the cut land mid-character.
    const long = 'a' + 'я'.repeat(MAX_LINE_BYTES);
    const r = readerFor(`short\n${long}\nafter\nend`, stride, opts);
    const res = await r.readLines(0, 4);
    expect(res.truncated).toEqual([1]);
    const cut = res.lines[1] as string;
    expect(cut.includes('\uFFFD')).toBe(false);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(Buffer.byteLength(cut)).toBeGreaterThan(MAX_LINE_BYTES - 4);
    expect(res.lines.slice(2)).toEqual(['after', 'end']);
    expect((await r.readLines(2, 2)).lines).toEqual(['after', 'end']);
  });
});

describe('ChunkReader (misc)', () => {
  it('skips over a huge line between anchors without decoding it', async () => {
    const huge = 'z'.repeat(3 * 1024 * 1024);
    const r = readerFor(`head\n${huge}\ntail\nlast`, 3);
    expect((await r.readLines(2, 2)).lines).toEqual(['tail', 'last']);
    const res = await r.readLines(0, 3);
    expect(res.lines[1]).toBe('z'.repeat(MAX_LINE_BYTES));
    expect(res.truncated).toEqual([1]);
  });

  it('clamps ranges to the line count', async () => {
    const r = readerFor('a\nb\nc\nd\n', 2);
    expect((await r.readLines(3, 100)).lines).toEqual(['d']);
    expect((await r.readLines(4, 1)).lines).toEqual([]);
    expect((await r.readLines(-5, 1)).lines).toEqual(['a']);
  });

  it('reads from a partial index without crossing indexed bytes', async () => {
    const { file } = writeFile('l0\nl1\nl2\nl3\nl4\n');
    const scanner = new LineStartScanner({ stride: 2 });
    const index = new LineIndex();
    scanner.scan(enc('l0\nl1\nl2\nl'));
    index.append(scanner.take(), { stride: 2, linesStarted: scanner.linesStarted, bytesIndexed: scanner.bytesScanned });
    const r = new ChunkReader(pool, file, index);
    expect(index.lineCount).toBe(3);
    expect((await r.readLines(0, 10)).lines).toEqual(['l0', 'l1', 'l2']);
  });

  it('countNewlines and countLinesToEnd', async () => {
    const { file } = writeFile('a\nbb\nccc');
    expect(await countNewlines(pool, file, 0, 8, 3)).toBe(2);
    expect(await countNewlines(pool, file, 2, 5, 1)).toBe(1);
    expect(await countLinesToEnd(pool, file, 0, 8)).toBe(3);
    expect(await countLinesToEnd(pool, file, 5, 8)).toBe(1);
    const { file: f2 } = writeFile('a\nbb\n');
    expect(await countLinesToEnd(pool, f2, 0, 5)).toBe(2);
    expect(await countLinesToEnd(pool, f2, 5, 5)).toBe(0);
  });
});
