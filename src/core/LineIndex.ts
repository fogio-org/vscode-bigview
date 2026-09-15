/**
 * Sparse line index (SPEC §3.3).
 *
 * Stores the byte offset of every `stride`-th line start ("anchors"): anchor k is the start of
 * line k * stride. Lines between anchors are found on the fly by ChunkReader. The stride is
 * chosen from an estimate so the index stays under MAX_ANCHORS (32 MB); if the estimate was
 * wrong, the scanner doubles the stride and the index compacts itself, so the bound holds for
 * any file.
 *
 * Line model:
 * - An empty file has 0 lines.
 * - A `\n` terminates a line; a trailing `\n` at EOF does NOT start an extra empty line.
 * - A final line without `\n` is still a line.
 */

/** 4M anchors x 8 bytes = 32 MB. */
export const MAX_ANCHORS = 4_000_000;

const PAGE_BITS = 20; // 1M anchors = 8 MB per page
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;

/** The stride is estimated from the newline density of the first 4 MB (SPEC §3.3). */
export const ESTIMATE_SAMPLE_BYTES = 4 * 1024 * 1024;

export function strideForEstimate(estimatedLines: number, maxAnchors = MAX_ANCHORS): number {
  return Math.max(1, Math.ceil(estimatedLines / maxAnchors));
}

/** Estimates the total line count from the start of the file. */
export function estimateLineCount(head: Uint8Array, fileSize: number, sampleBytes = ESTIMATE_SAMPLE_BYTES): number {
  const buf = Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, sampleBytes));
  let newlines = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) newlines++;
  if (fileSize <= buf.length) return newlines + 1;
  return Math.max(1, Math.ceil((newlines * fileSize) / buf.length));
}

export interface LineAnchor {
  /** Line number of the anchor. */
  line: number;
  /** Byte offset where that line starts. */
  offset: number;
}

export interface IndexProgress {
  stride: number;
  /** Line starts seen so far, including a still-open last line. */
  linesStarted: number;
  bytesIndexed: number;
}

export class LineIndex {
  private readonly pages: Float64Array[] = [];
  private count = 0;
  private strideValue = 1;
  private lines = 0;
  private scannedBytes = 0;
  private completed = false;

  /** Builds a complete index from persisted anchors. */
  static fromAnchors(anchors: Float64Array, stride: number, lineCount: number, fileSize: number): LineIndex {
    const index = new LineIndex();
    index.append(anchors, { stride, linesStarted: lineCount, bytesIndexed: fileSize });
    index.complete(fileSize, lineCount);
    return index;
  }

  /**
   * Appends anchors produced by LineStartScanner. A larger `stride` than the current one means
   * the scanner doubled it: already stored anchors are compacted first.
   */
  append(anchors: ArrayLike<number>, progress: IndexProgress): void {
    if (this.completed) throw new Error('LineIndex is already complete');
    if (progress.stride !== this.strideValue) {
      if (progress.stride < this.strideValue || progress.stride % this.strideValue !== 0) {
        throw new Error(`Stride can only grow by a whole factor: ${this.strideValue} -> ${progress.stride}`);
      }
      this.compact(progress.stride / this.strideValue);
      this.strideValue = progress.stride;
    }
    for (let i = 0; i < anchors.length; i++) this.set(this.count++, anchors[i] as number);
    const expected = Math.ceil(progress.linesStarted / this.strideValue);
    if (this.count !== expected) {
      throw new Error(`Anchor count mismatch: have ${this.count}, expected ${expected}`);
    }
    this.lines = Math.max(0, progress.linesStarted - 1);
    this.scannedBytes = progress.bytesIndexed;
  }

  /** Marks the index as covering the whole file. */
  complete(fileSize: number, lineCount: number): void {
    this.lines = lineCount;
    // A trailing newline produces an anchor at EOF when lineCount % stride == 0: drop it.
    this.count = Math.min(this.count, Math.ceil(lineCount / this.strideValue));
    this.scannedBytes = fileSize;
    this.completed = true;
    this.pages.length = Math.ceil(this.count / PAGE_SIZE);
  }

  /**
   * Appends lines written after `bytesIndexed` to a complete index (tail). `anchors` come from a
   * scanner resumed with `resumeState()`. The index stays complete, so readers never see a
   * partial state.
   */
  extend(anchors: ArrayLike<number>, p: IndexProgress & { lineCount: number }): void {
    if (!this.completed) throw new Error('extend() needs a complete index');
    if (p.stride !== this.strideValue) {
      if (p.stride < this.strideValue || p.stride % this.strideValue !== 0) {
        throw new Error(`Stride can only grow by a whole factor: ${this.strideValue} -> ${p.stride}`);
      }
      this.compact(p.stride / this.strideValue);
      this.strideValue = p.stride;
    }
    for (let i = 0; i < anchors.length; i++) this.set(this.count++, anchors[i] as number);
    const expected = Math.ceil(p.linesStarted / this.strideValue);
    if (this.count !== expected) throw new Error(`Anchor count mismatch: have ${this.count}, expected ${expected}`);
    this.lines = p.lineCount;
    this.count = Math.min(this.count, Math.ceil(p.lineCount / this.strideValue));
    this.scannedBytes = p.bytesIndexed;
    this.pages.length = Math.ceil(this.count / PAGE_SIZE);
  }

  /** Scanner state to continue indexing after `bytesIndexed` of a complete index. */
  resumeState(lastLineTerminated: boolean): ScannerResume {
    return {
      offset: this.scannedBytes,
      linesStarted: this.lines,
      pendingStart: lastLineTerminated,
      anchors: this.count,
      stride: this.strideValue,
    };
  }

  /** Drops everything (the file was replaced); the index is then rebuilt with append(). */
  reset(): void {
    this.pages.length = 0;
    this.count = 0;
    this.strideValue = 1;
    this.lines = 0;
    this.scannedBytes = 0;
    this.completed = false;
  }

  get isComplete(): boolean {
    return this.completed;
  }

  get bytesIndexed(): number {
    return this.scannedBytes;
  }

  /** Lines whose byte range is fully known (while indexing, the open last line is excluded). */
  get lineCount(): number {
    return this.lines;
  }

  get stride(): number {
    return this.strideValue;
  }

  get anchorCount(): number {
    return this.count;
  }

  /** Memory held by anchor pages, bytes. */
  get memoryBytes(): number {
    return this.pages.length * PAGE_SIZE * 8;
  }

  anchorAt(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k >= this.count) throw new RangeError(`Anchor ${k} out of range`);
    return this.get(k);
  }

  /** Nearest anchor at or before `line`. */
  locate(line: number): LineAnchor {
    if (!Number.isInteger(line) || line < 0 || line >= this.lines) {
      throw new RangeError(`Line ${line} out of range [0, ${this.lines})`);
    }
    const k = Math.floor(line / this.strideValue);
    return { line: k * this.strideValue, offset: this.get(k) };
  }

  /** Anchor with the largest offset <= `offset`; undefined for an empty index. */
  locateOffset(offset: number): LineAnchor | undefined {
    if (this.count === 0) return undefined;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.get(mid) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo * this.strideValue, offset: this.get(lo) };
  }

  /** Copy of all anchors (for persisting). */
  toFloat64Array(): Float64Array {
    const out = new Float64Array(this.count);
    for (let p = 0; p * PAGE_SIZE < this.count; p++) {
      const page = this.pages[p] as Float64Array;
      out.set(page.subarray(0, Math.min(PAGE_SIZE, this.count - p * PAGE_SIZE)), p * PAGE_SIZE);
    }
    return out;
  }

  private compact(factor: number): void {
    let w = 0;
    for (let k = 0; k < this.count; k += factor) this.set(w++, this.get(k));
    this.count = w;
    this.pages.length = Math.ceil(this.count / PAGE_SIZE);
  }

  private get(i: number): number {
    return (this.pages[i >>> PAGE_BITS] as Float64Array)[i & PAGE_MASK] as number;
  }

  private set(i: number, v: number): void {
    const p = i >>> PAGE_BITS;
    while (this.pages.length <= p) this.pages.push(new Float64Array(PAGE_SIZE));
    (this.pages[p] as Float64Array)[i & PAGE_MASK] = v;
  }
}

/** Where a scanner continues an existing index (see LineIndex.resumeState). */
export interface ScannerResume {
  /** File offset of the first byte the scanner will see. */
  offset: number;
  /** Line starts already counted, including a still-open last line. */
  linesStarted: number;
  /** `offset` starts a new line that is not counted yet (the previous byte was `\n`, or offset 0). */
  pendingStart: boolean;
  /** Anchors already stored in the index. */
  anchors: number;
  stride: number;
}

export interface ScannerOptions {
  stride?: number;
  maxAnchors?: number;
  initialCapacity?: number;
  resume?: ScannerResume;
}

/**
 * Streaming scanner that turns sequential file chunks into sparse anchors.
 * Newline (0x0A) is a single byte, so chunks need no overlap for indexing.
 */
export class LineStartScanner {
  private next = 0;
  private started = 0;
  /** Anchors already handed out by take(). */
  private sent = 0;
  private out: Float64Array;
  private n = 0;
  private strideValue: number;
  private readonly maxAnchors: number;
  /** `next` is the start of a line that has not been counted yet. */
  private pendingStart = true;

  constructor(opts: ScannerOptions = {}) {
    this.strideValue = Math.max(1, opts.stride ?? 1);
    this.maxAnchors = Math.max(1, opts.maxAnchors ?? MAX_ANCHORS);
    this.out = new Float64Array(opts.initialCapacity ?? 1 << 16);
    const r = opts.resume;
    if (r) {
      this.next = r.offset;
      this.started = r.linesStarted;
      this.sent = r.anchors;
      this.strideValue = Math.max(1, r.stride);
      this.pendingStart = r.pendingStart;
    }
  }

  get bytesScanned(): number {
    return this.next;
  }

  get linesStarted(): number {
    return this.started;
  }

  get stride(): number {
    return this.strideValue;
  }

  /** Anchors buffered and not yet taken. */
  get pending(): number {
    return this.n;
  }

  /** Sets the initial stride; only allowed before any data was scanned. */
  setStride(stride: number): void {
    if (this.next > 0 || this.started > 0) throw new Error('setStride() must be called before scanning');
    this.strideValue = Math.max(1, stride);
  }

  scan(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.pendingStart) {
      this.lineStart(this.next);
      this.pendingStart = false;
    }
    const base = this.next;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) this.lineStart(base + i + 1);
    this.next += buf.length;
  }

  /** Returns buffered anchors as an exact-length (transferable) array and resets the buffer. */
  take(): Float64Array {
    const res = this.out.slice(0, this.n);
    this.sent += this.n;
    this.n = 0;
    return res;
  }

  private lineStart(offset: number): void {
    if (this.started % this.strideValue === 0) {
      if (this.sent + this.n >= this.maxAnchors) this.doubleStride();
      if (this.started % this.strideValue === 0) this.push(offset);
    }
    this.started++;
  }

  /** Keeps every other anchor; LineIndex.append() mirrors this for already-sent anchors. */
  private doubleStride(): void {
    let w = 0;
    for (let j = 0; j < this.n; j++) {
      if ((this.sent + j) % 2 === 0) this.out[w++] = this.out[j] as number;
    }
    this.n = w;
    this.sent = Math.ceil(this.sent / 2);
    this.strideValue *= 2;
  }

  private push(v: number): void {
    if (this.n === this.out.length) {
      const grown = new Float64Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.n++] = v;
  }
}
