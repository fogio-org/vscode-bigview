/**
 * Streaming copy of selected lines into another file (SPEC §6 M4 export).
 *
 * One sequential pass over the source in fixed-size chunks; runs of selected lines are written
 * straight from the read buffer, so memory stays constant however many lines are exported.
 * Line terminators are copied as they are (`\r\n` stays `\r\n`).
 */
import { readFully, SEARCH_CHUNK_BYTES, SEARCH_PROGRESS_BYTES, type ReadFn } from './search';

export interface CopySink {
  progress(bytesRead: number, linesWritten: number): void;
  isCancelled(): boolean;
}

export interface CopyOptions {
  chunkBytes?: number;
  progressBytes?: number;
}

export interface CopySummary {
  status: 'done' | 'cancelled';
  linesWritten: number;
  bytesWritten: number;
  /** Lines in the source (when done). */
  lineCount: number;
}

/** Selects lines of a LineSet bitset (or its complement within [0, lineCount)). */
export function bitsetSelector(words: Uint32Array, invert: boolean, lineCount: number): (line: number) => boolean {
  return (line) => {
    if (line >= lineCount) return false;
    const w = Math.floor(line / 32);
    const bit = w < words.length && (((words[w] as number) >>> line % 32) & 1) === 1;
    return bit !== invert;
  };
}

export function copyLines(
  read: ReadFn,
  write: (bytes: Buffer) => void,
  fileSize: number,
  selected: (line: number) => boolean,
  sink: CopySink,
  opts: CopyOptions = {},
): CopySummary {
  const chunkBytes = Math.max(1, Math.floor(opts.chunkBytes ?? SEARCH_CHUNK_BYTES));
  const progressBytes = Math.max(1, opts.progressBytes ?? SEARCH_PROGRESS_BYTES);
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, fileSize)));
  let nextProgress = progressBytes;
  let pos = 0;
  let line = 0;
  let linesWritten = 0;
  let bytesWritten = 0;
  let lastByte = -1;
  let current = fileSize > 0 && selected(0);

  const emit = (bytes: Buffer): void => {
    if (bytes.length === 0) return;
    write(bytes);
    bytesWritten += bytes.length;
  };

  while (pos < fileSize) {
    if (sink.isCancelled()) return { status: 'cancelled', linesWritten, bytesWritten, lineCount: line };
    const n = readFully(read, buf, Math.min(buf.length, fileSize - pos), pos);
    if (n === 0) break;
    const view = buf.subarray(0, n);
    let spanStart = current ? 0 : -1;
    for (let nl = view.indexOf(10); nl !== -1; nl = view.indexOf(10, nl + 1)) {
      if (current) linesWritten++;
      line++;
      const next = selected(line);
      if (current && !next) {
        emit(view.subarray(spanStart, nl + 1));
        spanStart = -1;
      } else if (!current && next) {
        spanStart = nl + 1;
      }
      current = next;
    }
    if (spanStart !== -1) emit(view.subarray(spanStart, n));
    lastByte = view[n - 1] as number;
    pos += n;
    if (pos >= nextProgress) {
      sink.progress(pos, linesWritten);
      nextProgress = (Math.floor(pos / progressBytes) + 1) * progressBytes;
    }
  }
  const unterminatedLast = pos > 0 && lastByte !== 0x0a;
  if (unterminatedLast && current) linesWritten++;
  return { status: 'done', linesWritten, bytesWritten, lineCount: unterminatedLast ? line + 1 : line };
}
