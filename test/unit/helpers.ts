import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LineIndex, LineStartScanner } from '../../src/core/LineIndex';

/** Reference implementation: [start, endExclusive) of each line, per the LineIndex line model. */
export function naiveLines(data: Uint8Array): Array<[number, number]> {
  const res: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      res.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < data.length) res.push([start, data.length]);
  return res;
}

/** Reference decoding of every line: strips `\n`, one `\r`, and a BOM at file start. */
export function naiveText(data: Uint8Array): string[] {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return naiveLines(data).map(([s, e]) => {
    if (e > s && data[e - 1] === 0x0a) e--;
    if (e > s && data[e - 1] === 0x0d) e--;
    if (s === 0 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) s = 3;
    return e > s ? decoder.decode(data.subarray(s, e)) : '';
  });
}

export interface BuildOptions {
  chunkSize?: number;
  stride?: number;
  maxAnchors?: number;
}

/** Builds a complete LineIndex the way the indexer worker does, feeding `data` in chunks. */
export function buildIndex(data: Uint8Array, opts: BuildOptions | number = {}): LineIndex {
  const o = typeof opts === 'number' ? { chunkSize: opts } : opts;
  const chunkSize = o.chunkSize ?? (data.length || 1);
  const scanner = new LineStartScanner({ stride: o.stride, maxAnchors: o.maxAnchors, initialCapacity: 4 });
  const index = new LineIndex();
  for (let off = 0; off < data.length; off += chunkSize) {
    scanner.scan(data.subarray(off, Math.min(off + chunkSize, data.length)));
    index.append(scanner.take(), {
      stride: scanner.stride,
      linesStarted: scanner.linesStarted,
      bytesIndexed: scanner.bytesScanned,
    });
  }
  const lineCount = data[data.length - 1] === 0x0a ? scanner.linesStarted - 1 : scanner.linesStarted;
  index.complete(data.length, lineCount);
  return index;
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bigview-${prefix}-`));
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Small texts covering the line-model edge cases. */
export const EDGE_CASES: Record<string, string> = {
  empty: '',
  'single line without newline': 'abc',
  'single line with newline': 'abc\n',
  'only newline': '\n',
  'two newlines': '\n\n',
  'no trailing newline': 'a\nbb\nccc',
  'trailing newline': 'a\nbb\nccc\n',
  'empty lines in middle': 'a\n\n\nb\n',
  crlf: 'one\r\ntwo\r\n\r\nthree',
  'crlf trailing': 'one\r\ntwo\r\n',
  'lone cr is not a terminator': 'a\rb\nc',
  unicode: 'привет\n🚀 emoji\n日本語\nЖ\n',
  bom: '\uFEFFfirst\nsecond\n',
  'many short lines': Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'),
};
