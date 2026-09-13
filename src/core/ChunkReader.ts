import type { FileHandlePool } from './FileHandlePool';
import type { LineIndex } from './LineIndex';

/** Lines longer than this are cut for display (at a UTF-8 character boundary). */
export const MAX_LINE_BYTES = 16 * 1024;
/** A range of lines spanning more bytes than this is read line by line with capped reads. */
const MAX_SPAN_BYTES = 4 * 1024 * 1024;

export interface LinesResult {
  /** First line number actually returned. */
  start: number;
  lines: string[];
  /** Positions (relative to `start`) of lines that were truncated to MAX_LINE_BYTES. */
  truncated: number[];
}

/**
 * Reads and decodes a range of lines using the line index. Only the requested lines are
 * decoded (SPEC §3.7, §7.2).
 */
export class ChunkReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

  constructor(
    private readonly pool: FileHandlePool,
    private readonly filePath: string,
    private readonly index: LineIndex,
  ) {}

  async readLines(start: number, count: number): Promise<LinesResult> {
    const first = Math.max(0, Math.floor(start));
    const end = Math.min(first + Math.max(0, Math.floor(count)), this.index.lineCount);
    const result: LinesResult = { start: first, lines: [], truncated: [] };
    if (first >= end) return result;

    const spanStart = this.index.lineStart(first);
    const spanEnd = this.index.lineEnd(end - 1);

    if (spanEnd - spanStart <= MAX_SPAN_BYTES) {
      const buf = await this.pool.read(this.filePath, spanStart, spanEnd - spanStart);
      for (let i = first; i < end; i++) {
        const s = this.index.lineStart(i) - spanStart;
        const e = this.index.lineEnd(i) - spanStart;
        this.pushLine(result, buf, s, e, spanStart + s === 0, i - first);
      }
    } else {
      for (let i = first; i < end; i++) {
        const ls = this.index.lineStart(i);
        const len = this.index.lineEnd(i) - ls;
        // One extra byte lets pushLine see whether the cut lands inside a character.
        const readLen = len > MAX_LINE_BYTES ? MAX_LINE_BYTES + 4 : len;
        const buf = await this.pool.read(this.filePath, ls, readLen);
        this.pushLine(result, buf, 0, len, ls === 0, i - first);
      }
    }
    return result;
  }

  /**
   * Decodes bytes [s, e) of `buf` as one line. `e` may exceed buf.length when the line
   * was read partially (long line) or the file shrank underneath us.
   */
  private pushLine(result: LinesResult, buf: Buffer, s: number, e: number, atFileStart: boolean, rel: number): void {
    if (atFileStart && buf[s] === 0xef && buf[s + 1] === 0xbb && buf[s + 2] === 0xbf) s += 3;

    // Terminator is only visible when the whole line was read.
    if (e <= buf.length) {
      if (e > s && buf[e - 1] === 0x0a) e--;
      if (e > s && buf[e - 1] === 0x0d) e--;
    }
    let truncated = false;
    if (e - s > MAX_LINE_BYTES) {
      truncated = true;
      e = s + MAX_LINE_BYTES;
      // Do not cut a multi-byte character: back off to its lead byte.
      while (e > s && ((buf[e] ?? 0) & 0xc0) === 0x80) e--;
    }
    e = Math.min(e, buf.length);
    result.lines.push(e > s ? this.decoder.decode(buf.subarray(s, e)) : '');
    if (truncated) result.truncated.push(rel);
  }
}
