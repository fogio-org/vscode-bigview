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

/** Builds a complete LineIndex by feeding `data` in chunks of `chunkSize`. */
export function buildIndex(data: Uint8Array, chunkSize = data.length || 1): LineIndex {
  const scanner = new LineStartScanner(4);
  const index = new LineIndex();
  for (let off = 0; off < data.length; off += chunkSize) {
    scanner.scan(data.subarray(off, Math.min(off + chunkSize, data.length)));
    index.append(scanner.take(), scanner.bytesScanned);
  }
  index.complete(data.length);
  return index;
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bigview-${prefix}-`));
}
