import type { FileHandlePool } from './FileHandlePool';
import type { LineIndex } from './LineIndex';

/** Lines longer than this are cut for display (at a UTF-8 character boundary). */
export const MAX_LINE_BYTES = 16 * 1024;
/** Enough to see a full MAX_LINE_BYTES line plus `\r\n` and the byte after the cut. */
const LINE_READ_BYTES = MAX_LINE_BYTES + 8;
const DEFAULT_BLOCK_BYTES = 256 * 1024;
const DEFAULT_SCAN_BYTES = 1024 * 1024;
const EMPTY = Buffer.alloc(0);

export interface LinesResult {
  /** First line number actually returned. */
  start: number;
  lines: string[];
  /** Positions (relative to `start`) of lines that were truncated to MAX_LINE_BYTES. */
  truncated: number[];
}

export interface ChunkReaderOptions {
  /** Read-ahead block for decoding lines. */
  blockBytes?: number;
  /** Block for skipping/counting lines. */
  scanBytes?: number;
}

/** Caches one read-ahead block of the file, bounded by `limit`. */
class BlockCache {
  private buf: Buffer = EMPTY;
  private start = 0;

  constructor(
    private readonly pool: FileHandlePool,
    private readonly filePath: string,
    readonly limit: number,
    private readonly blockBytes: number,
  ) {}

  /** Up to `want` bytes starting at `pos`; shorter only at `limit`/EOF. */
  async get(pos: number, want: number): Promise<Buffer> {
    const need = Math.min(want, this.limit - pos);
    if (need <= 0) return EMPTY;
    const rel = pos - this.start;
    if (rel >= 0 && this.buf.length - rel >= need) return this.buf.subarray(rel, rel + need);
    this.buf = await this.pool.read(this.filePath, pos, Math.min(Math.max(want, this.blockBytes), this.limit - pos));
    this.start = pos;
    return this.buf.subarray(0, Math.min(need, this.buf.length));
  }
}

/**
 * Reads and decodes ranges of lines using the sparse index: seeks to the nearest anchor, skips
 * the lines in between by scanning raw bytes, and decodes only the requested lines
 * (SPEC §3.3, §3.7, §7.2).
 */
export class ChunkReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  private readonly blockBytes: number;
  private readonly scanBytes: number;

  constructor(
    private readonly pool: FileHandlePool,
    private readonly filePath: string,
    private readonly index: LineIndex,
    opts: ChunkReaderOptions = {},
  ) {
    this.blockBytes = opts.blockBytes ?? DEFAULT_BLOCK_BYTES;
    this.scanBytes = opts.scanBytes ?? DEFAULT_SCAN_BYTES;
  }

  async readLines(start: number, count: number): Promise<LinesResult> {
    const first = Math.max(0, Math.floor(start));
    const end = Math.min(first + Math.max(0, Math.floor(count)), this.index.lineCount);
    const result: LinesResult = { start: first, lines: [], truncated: [] };
    if (first >= end) return result;

    const blocks = this.blocks();
    const anchor = this.index.locate(first);
    let pos = await this.skipLines(blocks, anchor.offset, first - anchor.line);
    for (let i = first; i < end; i++) {
      pos = await this.readLineAt(blocks, pos, result, i - first);
    }
    return result;
  }

  /**
   * Reads the given lines, e.g. the rows of a filtered view. Ascending lines share read blocks
   * and skip forward from the previous line instead of seeking to an anchor. Stops at the first
   * line that is not indexed yet; `result.lines[k]` is `targets[k]`.
   */
  async readLinesAt(targets: readonly number[]): Promise<LinesResult> {
    const result: LinesResult = { start: 0, lines: [], truncated: [] };
    const blocks = this.blocks();
    let prevLine = -1;
    let nextOffset = 0; // where prevLine + 1 starts
    for (let k = 0; k < targets.length; k++) {
      const line = targets[k] as number;
      if (line >= this.index.lineCount) break;
      const anchor = this.index.locate(line);
      const pos =
        prevLine >= 0 && line > prevLine && prevLine + 1 >= anchor.line
          ? await this.skipLines(blocks, nextOffset, line - prevLine - 1)
          : await this.skipLines(blocks, anchor.offset, line - anchor.line);
      nextOffset = await this.readLineAt(blocks, pos, result, k);
      prevLine = line;
    }
    return result;
  }

  /** One line up to `maxBytes` (for detail views), cut at a character boundary. */
  async readLineText(line: number, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const start = await this.lineStart(line);
    const available = Math.max(0, this.index.bytesIndexed - start);
    const buf = await this.pool.read(this.filePath, start, Math.min(maxBytes + 4, available));
    let e = buf.indexOf(10);
    let truncated = false;
    if (e === -1 ? buf.length > maxBytes : e > maxBytes) {
      truncated = true;
      e = maxBytes;
      while (e > 0 && ((buf[e] as number) & 0xc0) === 0x80) e--;
    } else if (e === -1) {
      e = buf.length;
    }
    if (!truncated && e > 0 && buf[e - 1] === 0x0d) e--;
    const s = start === 0 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? Math.min(3, e) : 0;
    return { text: this.decoder.decode(buf.subarray(s, e)), truncated };
  }

  /** Byte offset where `line` starts. */
  async lineStart(line: number): Promise<number> {
    const anchor = this.index.locate(line);
    return this.skipLines(this.blocks(), anchor.offset, line - anchor.line);
  }

  /** Line containing byte `offset` (offsets past the end map to the last line); -1 if no lines. */
  async offsetToLine(offset: number): Promise<number> {
    const anchor = this.index.locateOffset(offset);
    if (!anchor || this.index.lineCount === 0) return -1;
    const to = Math.min(offset, this.index.bytesIndexed);
    const newlines = to > anchor.offset ? await countNewlines(this.pool, this.filePath, anchor.offset, to, this.scanBytes) : 0;
    return Math.min(anchor.line + newlines, this.index.lineCount - 1);
  }

  private blocks(): BlockCache {
    return new BlockCache(this.pool, this.filePath, this.index.bytesIndexed, this.blockBytes);
  }

  /** Offset after skipping `n` line terminators from `pos`. */
  private async skipLines(blocks: BlockCache, pos: number, n: number): Promise<number> {
    // Start with a small read (usually a few lines away) and grow for long lines.
    let want = Math.max(1, Math.min(this.blockBytes, this.scanBytes));
    while (n > 0) {
      const view = await blocks.get(pos, want);
      if (view.length === 0) return blocks.limit;
      let i = -1;
      while (n > 0) {
        i = view.indexOf(10, i + 1);
        if (i === -1) break;
        n--;
      }
      if (n === 0) return pos + i + 1;
      pos += view.length;
      want = Math.min(want * 2, Math.max(this.blockBytes, this.scanBytes));
    }
    return pos;
  }

  /** Offset of the next `\n` at or after `pos`, or -1. */
  private async findNewline(blocks: BlockCache, pos: number): Promise<number> {
    let want = Math.max(1, Math.min(this.blockBytes, this.scanBytes));
    for (;;) {
      const view = await blocks.get(pos, want);
      if (view.length === 0) return -1;
      const i = view.indexOf(10);
      if (i !== -1) return pos + i;
      pos += view.length;
      want = Math.min(want * 2, Math.max(this.blockBytes, this.scanBytes));
    }
  }

  /** Decodes the line starting at `pos` into `result`; returns the next line's offset. */
  private async readLineAt(blocks: BlockCache, pos: number, result: LinesResult, rel: number): Promise<number> {
    const view = await blocks.get(pos, LINE_READ_BYTES);
    const nl = view.indexOf(10);
    const complete = nl !== -1 || view.length < LINE_READ_BYTES;
    let e = nl !== -1 ? nl : view.length;
    if (complete && e > 0 && view[e - 1] === 0x0d) e--;

    let s = 0;
    if (pos === 0 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) s = 3;
    let truncated = false;
    if (e - s > MAX_LINE_BYTES) {
      truncated = true;
      e = s + MAX_LINE_BYTES;
      // Do not cut a multi-byte character: back off to its lead byte.
      while (e > s && ((view[e] ?? 0) & 0xc0) === 0x80) e--;
    }
    // Decode before reading further: the next read replaces the cached block.
    result.lines.push(e > s ? this.decoder.decode(view.subarray(s, e)) : '');
    if (truncated) result.truncated.push(rel);

    if (nl !== -1) return pos + nl + 1;
    if (view.length < LINE_READ_BYTES) return pos + view.length;
    const found = await this.findNewline(blocks, pos + view.length);
    return found === -1 ? blocks.limit : found + 1;
  }
}

/** Number of `\n` bytes in [from, to). */
export async function countNewlines(
  pool: FileHandlePool,
  filePath: string,
  from: number,
  to: number,
  blockBytes = DEFAULT_SCAN_BYTES,
): Promise<number> {
  let count = 0;
  for (let pos = from; pos < to; ) {
    const buf = await pool.read(filePath, pos, Math.min(blockBytes, to - pos));
    if (buf.length === 0) break;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) count++;
    pos += buf.length;
  }
  return count;
}

/**
 * Number of lines starting in [from, fileSize), where `from` is a line start.
 * Used to recover the line count of a persisted index (the sidecar format has no line count).
 */
export async function countLinesToEnd(
  pool: FileHandlePool,
  filePath: string,
  from: number,
  fileSize: number,
): Promise<number> {
  if (from >= fileSize) return 0;
  const newlines = await countNewlines(pool, filePath, from, fileSize);
  const last = await pool.read(filePath, fileSize - 1, 1);
  return last[0] === 0x0a ? newlines : newlines + 1;
}
