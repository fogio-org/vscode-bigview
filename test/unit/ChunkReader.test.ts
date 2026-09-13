import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChunkReader, MAX_LINE_BYTES } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { buildIndex, tmpDir } from './helpers';

const dir = tmpDir('reader');
const pool = new FileHandlePool({ idleMs: 50 });
afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

let fileNo = 0;
function readerFor(content: string | Uint8Array): ChunkReader {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const p = path.join(dir, `f${fileNo++}.txt`);
  fs.writeFileSync(p, data);
  return new ChunkReader(pool, p, buildIndex(data, 5));
}

describe('ChunkReader', () => {
  it('reads lines and strips \\n and \\r\\n', async () => {
    const r = readerFor('one\r\ntwo\n\r\nthree');
    const res = await r.readLines(0, 10);
    expect(res).toEqual({ start: 0, lines: ['one', 'two', '', 'three'], truncated: [] });
  });

  it('reads a sub-range and clamps to line count', async () => {
    const r = readerFor('a\nb\nc\nd\n');
    expect((await r.readLines(1, 2)).lines).toEqual(['b', 'c']);
    expect((await r.readLines(3, 100)).lines).toEqual(['d']);
    expect((await r.readLines(4, 1)).lines).toEqual([]);
    expect((await r.readLines(-5, 1)).lines).toEqual(['a']);
  });

  it('decodes multi-byte UTF-8 correctly', async () => {
    const r = readerFor('привет\n🚀 ok\n日本語');
    expect((await r.readLines(0, 3)).lines).toEqual(['привет', '🚀 ok', '日本語']);
  });

  it('strips a UTF-8 BOM only at file start', async () => {
    const r = readerFor('\uFEFFfirst\n\uFEFFsecond\n');
    expect((await r.readLines(0, 2)).lines).toEqual(['first', '\uFEFFsecond']);
  });

  it('does not truncate a line of exactly MAX_LINE_BYTES plus terminator', async () => {
    const line = 'x'.repeat(MAX_LINE_BYTES);
    const r = readerFor(`${line}\r\nnext`);
    const res = await r.readLines(0, 2);
    expect(res.truncated).toEqual([]);
    expect(res.lines[0]).toBe(line);
  });

  it('truncates long lines at a character boundary', async () => {
    // 'я' is 2 bytes; an odd prefix shifts every char so the cut lands mid-character.
    const long = 'a' + 'я'.repeat(MAX_LINE_BYTES);
    const r = readerFor(`short\n${long}\nafter\n`);
    const res = await r.readLines(0, 3);
    expect(res.truncated).toEqual([1]);
    const cut = res.lines[1] as string;
    expect(cut.includes('\uFFFD')).toBe(false);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(Buffer.byteLength(cut)).toBeGreaterThan(MAX_LINE_BYTES - 4);
    expect(res.lines[2]).toBe('after');
  });

  it('reads line by line when the span is huge, still truncating', async () => {
    const huge = 'z'.repeat(5 * 1024 * 1024);
    const r = readerFor(`head\n${huge}\ntail`);
    const res = await r.readLines(0, 3);
    expect(res.lines[0]).toBe('head');
    expect(res.lines[1]).toBe('z'.repeat(MAX_LINE_BYTES));
    expect(res.lines[2]).toBe('tail');
    expect(res.truncated).toEqual([1]);
  });
});
