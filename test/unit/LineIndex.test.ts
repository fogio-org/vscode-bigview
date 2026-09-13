import { describe, expect, it } from 'vitest';
import {
  estimateLineCount,
  LineIndex,
  LineStartScanner,
  MAX_ANCHORS,
  strideForEstimate,
} from '../../src/core/LineIndex';
import { buildIndex, EDGE_CASES, enc, naiveLines } from './helpers';

function assertSparseMatches(index: LineIndex, data: Uint8Array): void {
  const expected = naiveLines(data);
  const s = index.stride;
  expect(index.isComplete).toBe(true);
  expect(index.lineCount).toBe(expected.length);
  expect(index.anchorCount).toBe(Math.ceil(expected.length / s));
  expected.forEach((_, line) => {
    const a = index.locate(line);
    expect(a.line).toBe(Math.floor(line / s) * s);
    expect(a.offset).toBe(expected[a.line]?.[0]);
  });
  const anchorOffsets = Array.from(index.toFloat64Array());
  for (let off = 0; off <= data.length; off++) {
    const a = index.locateOffset(off);
    if (expected.length === 0) {
      expect(a).toBeUndefined();
      continue;
    }
    const k = anchorOffsets.filter((o) => o <= off).length - 1;
    expect(a).toEqual({ line: k * s, offset: anchorOffsets[k] });
  }
}

describe('LineIndex (sparse)', () => {
  for (const [name, text] of Object.entries(EDGE_CASES)) {
    it(`matches reference at every stride: ${name}`, () => {
      const data = enc(text);
      for (const stride of [1, 2, 3, 7]) {
        for (const chunkSize of [1, 3, 4096]) {
          assertSparseMatches(buildIndex(data, { stride, chunkSize }), data);
        }
      }
    });
  }

  it('empty file has zero lines', () => {
    const index = buildIndex(new Uint8Array(0));
    expect(index.lineCount).toBe(0);
    expect(index.anchorCount).toBe(0);
    expect(index.locateOffset(0)).toBeUndefined();
    expect(() => index.locate(0)).toThrow(RangeError);
  });

  it('drops the anchor at EOF produced by a trailing newline', () => {
    // lines "a", "b"; with stride 2 line 2 would start at EOF (offset 4)
    const index = buildIndex(enc('a\nb\n'), { stride: 2 });
    expect(index.lineCount).toBe(2);
    expect(Array.from(index.toFloat64Array())).toEqual([0]);
  });

  it('rejects out-of-range and non-integer lines', () => {
    const index = buildIndex(enc('a\nb'));
    expect(() => index.locate(-1)).toThrow(RangeError);
    expect(() => index.locate(2)).toThrow(RangeError);
    expect(() => index.locate(0.5)).toThrow(RangeError);
    expect(() => index.anchorAt(5)).toThrow(RangeError);
  });

  it('partial index exposes only lines whose end is known', () => {
    const scanner = new LineStartScanner({ stride: 2 });
    const index = new LineIndex();
    const feed = (s: string): void => {
      scanner.scan(enc(s));
      index.append(scanner.take(), { stride: scanner.stride, linesStarted: scanner.linesStarted, bytesIndexed: scanner.bytesScanned });
    };
    feed('aaa\nbb');
    expect(index.isComplete).toBe(false);
    expect(index.lineCount).toBe(1);
    expect(index.bytesIndexed).toBe(6);
    expect(() => index.locate(1)).toThrow(RangeError);

    feed('b\ncc\nd');
    expect(index.lineCount).toBe(3);
    expect(index.locate(2)).toEqual({ line: 2, offset: 8 });

    index.complete(scanner.bytesScanned, 4);
    expect(index.lineCount).toBe(4);
    expect(index.locate(3)).toEqual({ line: 2, offset: 8 });
  });

  it('compacts stored anchors when the stride grows', () => {
    const index = new LineIndex();
    index.append([0, 10, 20, 30, 40], { stride: 1, linesStarted: 5, bytesIndexed: 45 });
    index.append([60], { stride: 4, linesStarted: 9, bytesIndexed: 65 });
    expect(index.stride).toBe(4);
    expect(Array.from(index.toFloat64Array())).toEqual([0, 40, 60]);
  });

  it('validates stride changes and anchor counts', () => {
    const index = new LineIndex();
    index.append([0, 10], { stride: 2, linesStarted: 3, bytesIndexed: 12 });
    expect(() => index.append([], { stride: 1, linesStarted: 3, bytesIndexed: 12 })).toThrow(/Stride/);
    expect(() => index.append([], { stride: 3, linesStarted: 3, bytesIndexed: 12 })).toThrow(/Stride/);
    expect(() => index.append([99], { stride: 2, linesStarted: 3, bytesIndexed: 12 })).toThrow(/mismatch/);
  });

  it('throws when appending to a completed index', () => {
    const index = buildIndex(enc('a\n'));
    expect(() => index.append([5], { stride: 1, linesStarted: 2, bytesIndexed: 6 })).toThrow();
  });

  it('fromAnchors round-trips toFloat64Array', () => {
    const data = enc(EDGE_CASES['many short lines'] as string);
    const built = buildIndex(data, { stride: 3 });
    const restored = LineIndex.fromAnchors(built.toFloat64Array(), 3, built.lineCount, data.length);
    assertSparseMatches(restored, data);
  });

  it('spans multiple pages (> 1M anchors)', () => {
    const lines = (1 << 20) + 12345;
    const data = new Uint8Array(lines * 2);
    for (let i = 0; i < lines; i++) {
      data[i * 2] = 0x61;
      data[i * 2 + 1] = 0x0a;
    }
    const index = buildIndex(data, 1 << 20);
    expect(index.lineCount).toBe(lines);
    expect(index.anchorCount).toBe(lines);
    for (const i of [0, (1 << 20) - 1, 1 << 20, lines - 1]) {
      expect(index.locate(i).offset).toBe(i * 2);
      expect(index.locateOffset(i * 2 + 1)?.line).toBe(i);
    }
    expect(index.toFloat64Array().length).toBe(lines);
    expect(index.memoryBytes).toBe(2 * (1 << 20) * 8);
  });

  it('represents offsets above 4 GB exactly', () => {
    const big = 5 * 1024 ** 3 + 17;
    const index = LineIndex.fromAnchors(Float64Array.from([0, big, big + 10]), 1, 3, big + 20);
    expect(index.locate(1).offset).toBe(big);
    expect(index.locateOffset(big + 5)).toEqual({ line: 1, offset: big });
  });
});

describe('LineStartScanner', () => {
  it('emits every stride-th line start', () => {
    const s = new LineStartScanner({ stride: 3 });
    s.scan(enc('a\nb\nc\nd\ne\nf\ng'));
    expect(Array.from(s.take())).toEqual([0, 6, 12]);
    expect(s.linesStarted).toBe(7);
  });

  it('take() returns exact-length transferable arrays and resets', () => {
    const s = new LineStartScanner({ initialCapacity: 2 });
    s.scan(enc('a\nb\nc\nd\n'));
    const first = s.take();
    expect(Array.from(first)).toEqual([0, 2, 4, 6, 8]);
    expect(first.buffer.byteLength).toBe(5 * 8);
    expect(s.pending).toBe(0);
    s.scan(enc('e\n'));
    expect(Array.from(s.take())).toEqual([10]);
    expect(s.bytesScanned).toBe(10);
  });

  it('ignores empty chunks and refuses setStride after scanning', () => {
    const s = new LineStartScanner();
    s.scan(new Uint8Array(0));
    s.setStride(4);
    s.scan(enc('x'));
    expect(Array.from(s.take())).toEqual([0]);
    expect(() => s.setStride(2)).toThrow();
  });

  it('doubles the stride to stay within maxAnchors, consistently with LineIndex', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n') + '\n';
    const data = enc(text);
    for (const chunkSize of [7, 100, 5000, data.length]) {
      const streamed = buildIndex(data, { chunkSize, maxAnchors: 16 });
      expect(streamed.anchorCount).toBeLessThanOrEqual(16);
      expect(streamed.stride).toBeGreaterThanOrEqual(Math.ceil(1000 / 16));
      assertSparseMatches(streamed, data);
      // Same anchors as indexing directly with the final stride.
      const direct = buildIndex(data, { stride: streamed.stride });
      expect(Array.from(streamed.toFloat64Array())).toEqual(Array.from(direct.toFloat64Array()));
    }
  });

  it('handles \\r\\n split across chunks', () => {
    const data = enc('ab\r\ncd\r\n');
    const index = buildIndex(data, 3);
    expect(index.lineCount).toBe(2);
    expect(index.locate(1).offset).toBe(4);
  });
});

describe('stride estimation', () => {
  it('strideForEstimate keeps anchors under the budget', () => {
    expect(strideForEstimate(0)).toBe(1);
    expect(strideForEstimate(MAX_ANCHORS)).toBe(1);
    expect(strideForEstimate(MAX_ANCHORS + 1)).toBe(2);
    expect(strideForEstimate(25_000_000)).toBe(7);
    expect(strideForEstimate(100, 16)).toBe(7);
  });

  it('estimateLineCount extrapolates from the sample', () => {
    const head = enc('x'.repeat(99) + '\n');
    expect(estimateLineCount(head, 100)).toBe(2); // whole file sampled: newlines + 1
    const sample = new Uint8Array(1000).fill(0x61);
    for (let i = 99; i < 1000; i += 100) sample[i] = 0x0a;
    expect(estimateLineCount(sample, 1_000_000, 1000)).toBe(10_000);
    expect(estimateLineCount(new Uint8Array(1000), 1_000_000, 1000)).toBe(1);
  });
});
