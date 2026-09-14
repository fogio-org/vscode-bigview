import { describe, expect, it } from 'vitest';
import { bitsetSelector, copyLines, type CopyOptions } from '../../src/core/exportLines';
import { LineSet } from '../../src/core/LineSet';
import { enc, naiveLines } from './helpers';

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

const WORDS = ['log', 'ERROR', 'привет', '🚀', 'x', '', 'retry\ttimeout'];

function corpus(seed: number, lines: number, trailingNewline: boolean): Uint8Array {
  const r = mulberry32(seed);
  let text = '';
  for (let i = 0; i < lines; i++) {
    const n = Math.floor(r() * 6);
    text += Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
    text += r() < 0.3 ? '\r\n' : '\n';
  }
  if (!trailingNewline) text = text.replace(/\r?\n$/, '');
  return enc(text);
}

function copy(data: Uint8Array, selected: (line: number) => boolean, opts: CopyOptions = {}, cancelAfter = Infinity) {
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const parts: Buffer[] = [];
  let checks = 0;
  const summary = copyLines(
    (buf, offset, length, position) => (position >= src.length ? 0 : src.copy(buf, offset, position, Math.min(position + length, src.length))),
    (bytes) => parts.push(Buffer.from(bytes)), // the buffer is reused: copy
    src.length,
    selected,
    { progress: () => undefined, isCancelled: () => checks++ >= cancelAfter },
    opts,
  );
  return { ...summary, output: Buffer.concat(parts) };
}

function reference(data: Uint8Array, selected: (line: number) => boolean): { output: Buffer; lines: number } {
  const picked = naiveLines(data).filter((_, i) => selected(i));
  return { output: Buffer.concat(picked.map(([s, e]) => Buffer.from(data.subarray(s, e)))), lines: picked.length };
}

describe('copyLines', () => {
  for (const trailingNewline of [true, false]) {
    it(`copies exactly the selected lines (trailing newline: ${trailingNewline})`, () => {
      const data = corpus(trailingNewline ? 1 : 2, 700, trailingNewline);
      const lineCount = naiveLines(data).length;
      const r = mulberry32(99);
      const selections: Array<(line: number) => boolean> = [
        () => true,
        () => false,
        (l) => l % 2 === 0,
        (l) => l === lineCount - 1,
        (l) => l === 0,
        (() => {
          const picks = new Set(Array.from({ length: 50 }, () => Math.floor(r() * lineCount)));
          return (l: number) => picks.has(l);
        })(),
        (l) => Math.floor(l / 37) % 2 === 1, // runs
      ];
      for (const selected of selections) {
        const expected = reference(data, selected);
        for (const chunkBytes of [1, 3, 64, 4096, undefined]) {
          const res = copy(data, selected, { chunkBytes });
          expect(res.status).toBe('done');
          expect(res.output.equals(expected.output)).toBe(true);
          expect(res.linesWritten).toBe(expected.lines);
          expect(res.bytesWritten).toBe(expected.output.length);
          expect(res.lineCount).toBe(lineCount);
        }
      }
    });
  }

  it('selects from a LineSet bitset and its complement', () => {
    const data = corpus(3, 1000, true);
    const lineCount = naiveLines(data).length;
    const set = new LineSet();
    for (let l = 0; l < lineCount; l += 7) set.add(l);
    const words = set.toWords();
    const matches = copy(data, bitsetSelector(words, false, lineCount), { chunkBytes: 100 });
    const inverted = copy(data, bitsetSelector(words, true, lineCount), { chunkBytes: 100 });
    expect(matches.output.equals(reference(data, (l) => set.has(l)).output)).toBe(true);
    expect(inverted.output.equals(reference(data, (l) => !set.has(l)).output)).toBe(true);
    expect(matches.linesWritten + inverted.linesWritten).toBe(lineCount);
    // lines past the bitset are selected only when inverted (and only below lineCount)
    expect(bitsetSelector(words, true, lineCount)(lineCount - 1)).toBe((lineCount - 1) % 7 !== 0);
    expect(bitsetSelector(words, true, lineCount)(lineCount)).toBe(false);
  });

  it('handles an empty file and stops when cancelled', () => {
    expect(copy(new Uint8Array(0), () => true)).toMatchObject({ status: 'done', linesWritten: 0, bytesWritten: 0, lineCount: 0 });
    const data = enc('aaaa\n'.repeat(100));
    const res = copy(data, () => true, { chunkBytes: 50 }, 2);
    expect(res.status).toBe('cancelled');
    expect(res.output.toString()).toBe('aaaa\n'.repeat(20));
  });
});
