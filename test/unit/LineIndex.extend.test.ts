import { describe, expect, it } from 'vitest';
import { LineIndex, LineStartScanner } from '../../src/core/LineIndex';
import { buildIndex, EDGE_CASES, enc, naiveLines } from './helpers';

/** Appends data[from, to) to a complete index the way tail does. */
function extendTo(index: LineIndex, data: Uint8Array, to: number, chunk: number, maxAnchors?: number): void {
  const from = index.bytesIndexed;
  if (to <= from) return;
  const terminated = from === 0 || data[from - 1] === 0x0a;
  const scanner = new LineStartScanner({ maxAnchors, resume: index.resumeState(terminated) });
  let lastByte = -1;
  for (let p = from; p < to; p += chunk) {
    const part = data.subarray(p, Math.min(p + chunk, to));
    scanner.scan(part);
    lastByte = part[part.length - 1] as number;
  }
  const lineCount = lastByte === 0x0a ? scanner.linesStarted - 1 : scanner.linesStarted;
  index.extend(scanner.take(), { stride: scanner.stride, linesStarted: scanner.linesStarted, bytesIndexed: to, lineCount });
}

/**
 * Same lines as a fresh scan. The stride may differ (an index extended from a short prefix keeps
 * the stride it started with), but every anchor must be the start of its line.
 */
function expectSame(actual: LineIndex, expected: LineIndex, data: Uint8Array, maxAnchors?: number): void {
  expect(actual.isComplete).toBe(true);
  expect(actual.lineCount).toBe(expected.lineCount);
  expect(actual.bytesIndexed).toBe(expected.bytesIndexed);
  const starts = naiveLines(data).map(([s]) => s);
  expect(actual.anchorCount).toBe(Math.ceil(actual.lineCount / actual.stride));
  if (maxAnchors !== undefined) expect(actual.anchorCount).toBeLessThanOrEqual(maxAnchors);
  for (let k = 0; k < actual.anchorCount; k++) expect(actual.anchorAt(k)).toBe(starts[k * actual.stride]);
  for (let line = 0; line < actual.lineCount; line += 1 + (line >> 4)) {
    const a = actual.locate(line);
    expect(a.offset).toBe(starts[a.line]);
  }
}

describe('LineIndex.extend (tail)', () => {
  for (const [name, text] of Object.entries(EDGE_CASES)) {
    it(`any split point gives the same index as scanning at once: ${name}`, () => {
      const data = enc(text);
      for (const stride of [1, 2, 3]) {
        for (let split = 0; split <= data.length; split++) {
          const index = buildIndex(data.subarray(0, split), { stride, chunkSize: 3 });
          extendTo(index, data, data.length, 2);
          expectSame(index, buildIndex(data, { stride }), data);
        }
      }
    });
  }

  it('handles many appends with stride doubling across them', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `l${i}${i % 7 === 0 ? '\r' : ''}`).join('\n');
    const data = enc(text);
    const r = (() => {
      let a = 7;
      return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
    })();
    const index = buildIndex(data.subarray(0, 100), { maxAnchors: 64 });
    while (index.bytesIndexed < data.length) {
      const to = Math.min(data.length, index.bytesIndexed + 1 + Math.floor(r() * 900));
      extendTo(index, data, to, 1 + Math.floor(r() * 50), 64);
      expect(index.anchorCount).toBeLessThanOrEqual(64);
    }
    expectSame(index, buildIndex(data, { maxAnchors: 64 }), data, 64);
  });

  it('refuses to extend a partial index and resets to empty', () => {
    const partial = new LineIndex();
    expect(() => partial.extend([], { stride: 1, linesStarted: 0, bytesIndexed: 0, lineCount: 0 })).toThrow(/complete/);
    const index = buildIndex(enc('a\nb\nc\n'), { stride: 2 });
    index.reset();
    expect(index.isComplete).toBe(false);
    expect(index.lineCount).toBe(0);
    expect(index.bytesIndexed).toBe(0);
    expect(index.stride).toBe(1);
  });
});
