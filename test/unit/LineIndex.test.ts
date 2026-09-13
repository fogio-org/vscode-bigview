import { describe, expect, it } from 'vitest';
import { LineIndex, LineStartScanner } from '../../src/core/LineIndex';
import { buildIndex, naiveLines } from './helpers';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const CASES: Record<string, string> = {
  empty: '',
  'single line without newline': 'abc',
  'single line with newline': 'abc\n',
  'only newline': '\n',
  'two newlines': '\n\n',
  'no trailing newline': 'a\nbb\nccc',
  'trailing newline': 'a\nbb\nccc\n',
  'empty lines in middle': 'a\n\n\nb\n',
  crlf: 'one\r\ntwo\r\n\r\nthree',
  'lone cr is not a terminator': 'a\rb\nc',
  unicode: 'привет\n🚀 emoji\n日本語\n',
};

function assertMatchesNaive(index: LineIndex, data: Uint8Array): void {
  const expected = naiveLines(data);
  expect(index.isComplete).toBe(true);
  expect(index.lineCount).toBe(expected.length);
  expected.forEach(([s, e], i) => {
    expect(index.lineStart(i)).toBe(s);
    expect(index.lineEnd(i)).toBe(e);
  });
  for (let off = 0; off < data.length; off++) {
    const line = expected.findIndex(([s, e]) => off >= s && off < e);
    expect(index.offsetToLine(off)).toBe(line);
  }
}

describe('LineIndex', () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(`matches reference: ${name}`, () => {
      const data = enc(text);
      for (const chunk of [1, 2, 3, 7, 4096]) {
        assertMatchesNaive(buildIndex(data, chunk), data);
      }
    });
  }

  it('empty file has zero lines and offsetToLine returns -1', () => {
    const index = buildIndex(new Uint8Array(0));
    expect(index.lineCount).toBe(0);
    expect(index.offsetToLine(0)).toBe(-1);
    expect(() => index.lineStart(0)).toThrow(RangeError);
  });

  it('last line without newline ends at file size', () => {
    const data = enc('first\nlast');
    const index = buildIndex(data);
    expect(index.lineCount).toBe(2);
    expect(index.lineStart(1)).toBe(6);
    expect(index.lineEnd(1)).toBe(10);
  });

  it('offsets beyond EOF map to the last line', () => {
    const index = buildIndex(enc('a\nb\n'));
    expect(index.offsetToLine(1e12)).toBe(1);
  });

  it('rejects out-of-range and non-integer lines', () => {
    const index = buildIndex(enc('a\nb'));
    expect(() => index.lineStart(-1)).toThrow(RangeError);
    expect(() => index.lineStart(2)).toThrow(RangeError);
    expect(() => index.lineEnd(0.5)).toThrow(RangeError);
  });

  it('partial index exposes only lines whose end is known', () => {
    const scanner = new LineStartScanner();
    const index = new LineIndex();
    scanner.scan(enc('aaa\nbb'));
    index.append(scanner.take(), scanner.bytesScanned);
    expect(index.isComplete).toBe(false);
    expect(index.lineCount).toBe(1);
    expect(index.lineEnd(0)).toBe(4);
    expect(() => index.lineStart(1)).toThrow(RangeError);

    scanner.scan(enc('b\ncc'));
    index.append(scanner.take(), scanner.bytesScanned);
    expect(index.lineCount).toBe(2);

    index.complete(scanner.bytesScanned);
    expect(index.lineCount).toBe(3);
    // "aaa\nbbb\ncc"
    expect(index.lineStart(2)).toBe(8);
    expect(index.lineEnd(2)).toBe(10);
  });

  it('throws when appending to a completed index', () => {
    const index = buildIndex(enc('a\n'));
    expect(() => index.append([5], 6)).toThrow();
  });

  it('spans multiple pages (> 1M lines)', () => {
    const lines = (1 << 20) + 12345;
    const data = new Uint8Array(lines * 2);
    for (let i = 0; i < lines; i++) {
      data[i * 2] = 0x61;
      data[i * 2 + 1] = 0x0a;
    }
    const index = buildIndex(data, 1 << 20);
    expect(index.lineCount).toBe(lines);
    for (const i of [0, 1, (1 << 20) - 1, 1 << 20, (1 << 20) + 1, lines - 1]) {
      expect(index.lineStart(i)).toBe(i * 2);
      expect(index.lineEnd(i)).toBe(i * 2 + 2);
      expect(index.offsetToLine(i * 2 + 1)).toBe(i);
    }
    expect(index.memoryBytes).toBe(2 * (1 << 20) * 8);
  });

  it('represents offsets above 4 GB exactly', () => {
    const index = new LineIndex();
    const big = 5 * 1024 ** 3 + 17;
    index.append([0, big, big + 10], big + 10);
    index.complete(big + 20);
    expect(index.lineCount).toBe(3);
    expect(index.lineStart(1)).toBe(big);
    expect(index.lineEnd(2)).toBe(big + 20);
    expect(index.offsetToLine(big + 5)).toBe(1);
  });
});

describe('LineStartScanner', () => {
  it('take() returns exact-length transferable arrays and resets', () => {
    const s = new LineStartScanner(2);
    s.scan(enc('a\nb\nc\nd\n'));
    const first = s.take();
    expect(Array.from(first)).toEqual([0, 2, 4, 6, 8]);
    expect(first.buffer.byteLength).toBe(5 * 8);
    expect(s.pending).toBe(0);
    s.scan(enc('e\n'));
    expect(Array.from(s.take())).toEqual([10]);
    expect(s.bytesScanned).toBe(10);
  });

  it('ignores empty chunks, including a leading one', () => {
    const s = new LineStartScanner();
    s.scan(new Uint8Array(0));
    expect(s.pending).toBe(0);
    s.scan(enc('x'));
    expect(Array.from(s.take())).toEqual([0]);
  });

  it('handles \\r\\n split across chunks', () => {
    const data = enc('ab\r\ncd\r\n');
    const index = buildIndex(data, 3); // chunk boundary between \r and \n
    expect(index.lineCount).toBe(2);
    expect(index.lineStart(1)).toBe(4);
  });
});
