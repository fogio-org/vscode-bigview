/**
 * Line index: byte offsets of line starts (SPEC §3.3).
 *
 * M1: dense, in memory. Offsets are stored in fixed-size Float64Array pages so that
 * growing the index never reallocates/copies the whole array (no 2x memory spikes).
 *
 * Line model:
 * - An empty file has 0 lines.
 * - A `\n` terminates a line; a trailing `\n` at EOF does NOT start an extra empty line.
 * - A final line without `\n` is still a line.
 * - `lineEnd()` is exclusive and includes the terminator bytes; stripping `\r\n` is
 *   the reader's job.
 */

const PAGE_BITS = 20;
const PAGE_SIZE = 1 << PAGE_BITS; // 1M offsets = 8 MB per page
const PAGE_MASK = PAGE_SIZE - 1;

export class LineIndex {
  private readonly pages: Float64Array[] = [];
  private starts = 0;
  private scannedBytes = 0;
  private completed = false;

  /**
   * Appends ascending line-start offsets discovered while scanning up to `bytesIndexed`.
   */
  append(starts: ArrayLike<number>, bytesIndexed: number): void {
    if (this.completed) throw new Error('LineIndex is already complete');
    for (let i = 0; i < starts.length; i++) {
      const page = this.starts >>> PAGE_BITS;
      let p = this.pages[page];
      if (!p) {
        p = new Float64Array(PAGE_SIZE);
        this.pages.push(p);
      }
      p[this.starts & PAGE_MASK] = starts[i] as number;
      this.starts++;
    }
    this.scannedBytes = bytesIndexed;
  }

  /** Marks the index as covering the whole file of `fileSize` bytes. */
  complete(fileSize: number): void {
    this.scannedBytes = fileSize;
    // A newline as the very last byte produces a start == fileSize; that is not a line.
    if (this.starts > 0 && this.startAt(this.starts - 1) >= fileSize) this.starts--;
    this.completed = true;
    // Release unused tail pages.
    const neededPages = Math.ceil(this.starts / PAGE_SIZE);
    this.pages.length = neededPages;
  }

  get isComplete(): boolean {
    return this.completed;
  }

  get bytesIndexed(): number {
    return this.scannedBytes;
  }

  /**
   * Number of lines whose byte range is fully known. While indexing, the last
   * discovered start is still "open" (its end is unknown) and is not counted.
   */
  get lineCount(): number {
    return this.completed ? this.starts : Math.max(0, this.starts - 1);
  }

  /** Approximate memory held by the index, bytes. */
  get memoryBytes(): number {
    return this.pages.length * PAGE_SIZE * 8;
  }

  lineStart(line: number): number {
    this.check(line);
    return this.startAt(line);
  }

  /** Exclusive end offset of `line`, including its terminator. */
  lineEnd(line: number): number {
    this.check(line);
    return line + 1 < this.starts ? this.startAt(line + 1) : this.scannedBytes;
  }

  /**
   * Line containing byte `offset`. Offsets past the end map to the last line.
   * Returns -1 when there are no lines.
   */
  offsetToLine(offset: number): number {
    const n = this.lineCount;
    if (n === 0) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.startAt(mid) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private startAt(i: number): number {
    return (this.pages[i >>> PAGE_BITS] as Float64Array)[i & PAGE_MASK] as number;
  }

  private check(line: number): void {
    if (!Number.isInteger(line) || line < 0 || line >= this.lineCount) {
      throw new RangeError(`Line ${line} out of range [0, ${this.lineCount})`);
    }
  }
}

/**
 * Streaming scanner that turns sequential file chunks into line-start offsets.
 * Newline (0x0A) is a single byte, so chunks need no overlap for indexing.
 */
export class LineStartScanner {
  private next = 0;
  private out: Float64Array;
  private n = 0;

  constructor(initialCapacity = 1 << 16) {
    this.out = new Float64Array(initialCapacity);
  }

  /** Total bytes fed so far. */
  get bytesScanned(): number {
    return this.next;
  }

  /** Number of starts buffered and not yet taken. */
  get pending(): number {
    return this.n;
  }

  scan(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.next === 0) this.push(0);
    const base = this.next;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) {
      this.push(base + i + 1);
    }
    this.next += buf.length;
  }

  /** Returns buffered starts as an exact-length array (safe to transfer) and resets the buffer. */
  take(): Float64Array {
    const res = this.out.slice(0, this.n);
    this.n = 0;
    return res;
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
