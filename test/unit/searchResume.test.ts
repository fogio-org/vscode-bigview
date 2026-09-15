import { describe, expect, it } from 'vitest';
import { searchFile, type SearchOptions } from '../../src/core/search';
import { EMPTY_QUERY, type Query } from '../../src/shared/searchQuery';
import { enc, naiveLines } from './helpers';

function run(data: Uint8Array, query: Query, opts: SearchOptions): { hits: number[]; lineCount: number; bytes: number } {
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hits: number[] = [];
  const s = searchFile(
    (buf, offset, length, position) => (position >= src.length ? 0 : src.copy(buf, offset, position, Math.min(position + length, src.length))),
    src.length,
    query,
    { hit: (l) => hits.push(l), progress: () => undefined, isCancelled: () => false },
    opts,
  );
  return { hits, lineCount: s.lineCount, bytes: s.bytesSearched };
}

describe('searchFile from an offset (tail)', () => {
  const text = `﻿${Array.from({ length: 800 }, (_, i) => `${i % 5 === 0 ? 'NEEDLE ' : ''}line ${i} ${'x'.repeat(i % 90)}`).join('\r\n')}`;
  const data = enc(text);
  const lines = naiveLines(data);
  const queries: Query[] = [
    { ...EMPTY_QUERY, caseSensitive: true, text: 'NEEDLE' },
    { ...EMPTY_QUERY, text: '^needle line \\d+5 ', regex: true },
    { ...EMPTY_QUERY, caseSensitive: true, text: 'line 7' },
  ];

  it('finds the same hits as a full search, from any line start', () => {
    for (const query of queries) {
      const full = run(data, query, {});
      for (const startLine of [0, 1, 5, 399, 400, 798, 799]) {
        for (const opts of [{}, { chunkBytes: 256, decodeBytes: 50 }]) {
          const startOffset = (lines[startLine] as [number, number])[0];
          const part = run(data, query, { ...opts, startOffset, startLine });
          expect(part.hits).toEqual(full.hits.filter((l) => l >= startLine));
          expect(part.lineCount).toBe(full.lineCount);
          expect(part.bytes).toBe(data.length);
        }
      }
    }
  });

  it('starting at EOF finds nothing and keeps the line count', () => {
    expect(run(data, queries[0] as Query, { startOffset: data.length, startLine: 800 })).toEqual({ hits: [], lineCount: 800, bytes: data.length });
  });
});
