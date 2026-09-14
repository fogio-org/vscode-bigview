import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChunkReader, MAX_LINE_BYTES } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { LineIndex, LineStartScanner } from '../../src/core/LineIndex';
import { buildIndex, EDGE_CASES, enc, naiveText, tmpDir } from './helpers';

const dir = tmpDir('reader-at');
const pool = new FileHandlePool({ idleMs: 50 });
afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

let fileNo = 0;
function reader(data: Uint8Array, stride: number, opts = {}): ChunkReader {
  const file = path.join(dir, `f${fileNo++}.txt`);
  fs.writeFileSync(file, data);
  return new ChunkReader(pool, file, buildIndex(data, { stride, chunkSize: 7 }), opts);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ChunkReader.readLinesAt', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `${i % 11 === 0 ? 'привет🚀 ' : ''}line ${i}${'.'.repeat(i % 50)}`).join('\r\n');
  const data = enc(text);
  const expected = naiveText(data);

  for (const stride of [1, 3, 7]) {
    for (const opts of [{}, { blockBytes: 64, scanBytes: 16 }]) {
      it(`reads scattered, dense, descending and repeated lines (stride ${stride}, blocks ${JSON.stringify(opts)})`, async () => {
        const r = reader(data, stride, opts);
        const rand = mulberry32(stride);
        const sparse = [...new Set(Array.from({ length: 300 }, () => Math.floor(rand() * expected.length)))].sort((a, b) => a - b);
        const cases = [
          sparse,
          Array.from({ length: 500 }, (_, i) => 1200 + i),
          [2999, 5, 1500, 4, 4, 0],
          [0, expected.length - 1],
          [],
        ];
        for (const targets of cases) {
          const res = await r.readLinesAt(targets);
          expect(res.lines).toEqual(targets.map((l) => expected[l]));
        }
      });
    }
  }

  it('matches readLines on the edge cases', async () => {
    for (const content of Object.values(EDGE_CASES)) {
      const bytes = enc(content);
      const lines = naiveText(bytes);
      const r = reader(bytes, 2, { blockBytes: 4, scanBytes: 2 });
      const all = lines.map((_, i) => i);
      expect((await r.readLinesAt(all)).lines).toEqual(lines);
      expect((await r.readLinesAt(all.filter((i) => i % 2 === 1))).lines).toEqual(lines.filter((_, i) => i % 2 === 1));
    }
  });

  it('truncates long lines and stops at lines that are not indexed yet', async () => {
    const long = 'z'.repeat(MAX_LINE_BYTES * 2);
    const bytes = enc(`a\n${long}\nb\nc\nd`);
    const file = path.join(dir, 'partial.txt');
    fs.writeFileSync(file, bytes);
    const scanner = new LineStartScanner({ stride: 2 });
    const index = new LineIndex();
    scanner.scan(bytes.subarray(0, bytes.length - 1)); // "c\n" is the last complete line; "d" is not indexed
    index.append(scanner.take(), { stride: 2, linesStarted: scanner.linesStarted, bytesIndexed: scanner.bytesScanned });
    const r = new ChunkReader(pool, file, index);
    const res = await r.readLinesAt([0, 1, 3, 4]);
    expect(res.lines).toEqual(['a', 'z'.repeat(MAX_LINE_BYTES), 'c']);
    expect(res.truncated).toEqual([1]);
  });
});
