/**
 * Line numbers of search hits, ascending. Every hit is counted, but only the first `capacity`
 * are stored, so a query matching millions of lines cannot exhaust memory (8 bytes per stored
 * hit; 1M hits = 8 MB).
 */

export const MAX_STORED_HITS = 1_000_000;

const PAGE_BITS = 16;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;

export class SearchResults {
  private readonly pages: Float64Array[] = [];
  private count = 0;
  private all = 0;

  constructor(readonly capacity = MAX_STORED_HITS) {}

  /** All hits found. */
  get total(): number {
    return this.all;
  }

  /** Hits available for listing and navigation (<= total). */
  get stored(): number {
    return this.count;
  }

  add(lines: ArrayLike<number>): void {
    this.all += lines.length;
    const room = Math.min(lines.length, this.capacity - this.count);
    for (let i = 0; i < room; i++) {
      const p = this.count >>> PAGE_BITS;
      if (p === this.pages.length) this.pages.push(new Float64Array(PAGE_SIZE));
      (this.pages[p] as Float64Array)[this.count & PAGE_MASK] = lines[i] as number;
      this.count++;
    }
  }

  lineAt(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) throw new RangeError(`Hit ${i} out of range [0, ${this.count})`);
    return this.get(i);
  }

  /** Index of the first stored hit on or after `line`; `stored` if there is none. */
  lowerBound(line: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.get(mid) < line) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.get(i));
    return out;
  }

  private get(i: number): number {
    return (this.pages[i >>> PAGE_BITS] as Float64Array)[i & PAGE_MASK] as number;
  }
}
