/**
 * Set of line numbers, built in ascending order: a paged bitset with a rank directory.
 *
 * Search hits and filter views (SPEC §6 M4) are stored here instead of an array of line numbers:
 * memory is one bit per line of the file (26M lines → 3.3 MB) no matter how many lines match,
 * so a filter — or an inverted filter showing nearly every line — stays cheap on multi-GB
 * files, where an array would need 8 bytes per shown line (~200 MB).
 *
 * rank/select (row index ↔ line number) scan at most one 2048-bit block after a binary search.
 */

const WORDS_PER_PAGE = 1 << 15; // 1,048,576 bits = 131 KB per page
const BLOCK_WORDS = 64;
const BLOCK_BITS = BLOCK_WORDS * 32;

export function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Bit position of the n-th (0-based) set bit of `word`. */
function nthBit(word: number, n: number): number {
  for (;;) {
    if (n === 0) return 31 - Math.clz32(word & -word);
    word &= word - 1;
    n--;
  }
}

export class LineSet {
  private readonly pages: Uint32Array[] = [];
  /** blockRank[b] = members before block b. */
  private blockRank = new Float64Array(16);
  private blocks = 0;
  private count = 0;
  private last = -1;

  get size(): number {
    return this.count;
  }

  /** Largest member, -1 if empty. */
  get maxLine(): number {
    return this.last;
  }

  get memoryBytes(): number {
    return this.pages.length * WORDS_PER_PAGE * 4 + this.blockRank.byteLength;
  }

  /** Adds a line; lines must come in ascending order (a repeat of the last one is ignored). */
  add(line: number): void {
    if (!Number.isSafeInteger(line) || line < 0) throw new RangeError(`Invalid line ${line}`);
    if (line <= this.last) {
      if (line === this.last) return;
      throw new Error(`Lines must be added in ascending order: ${line} after ${this.last}`);
    }
    const block = Math.floor(line / BLOCK_BITS);
    while (this.blocks <= block) {
      if (this.blocks === this.blockRank.length) {
        const grown = new Float64Array(this.blockRank.length * 2);
        grown.set(this.blockRank);
        this.blockRank = grown;
      }
      this.blockRank[this.blocks++] = this.count;
    }
    const w = Math.floor(line / 32);
    const p = Math.floor(w / WORDS_PER_PAGE);
    while (this.pages.length <= p) this.pages.push(new Uint32Array(WORDS_PER_PAGE));
    const page = this.pages[p] as Uint32Array;
    const i = w % WORDS_PER_PAGE;
    page[i] = (page[i] as number) | (1 << line % 32);
    this.count++;
    this.last = line;
  }

  addAll(lines: ArrayLike<number>): void {
    for (let i = 0; i < lines.length; i++) this.add(lines[i] as number);
  }

  has(line: number): boolean {
    if (line < 0 || line > this.last || !Number.isInteger(line)) return false;
    return ((this.word(Math.floor(line / 32)) >>> line % 32) & 1) === 1;
  }

  /** Members smaller than `line` (= index of the first member >= line). */
  rank(line: number): number {
    if (line <= 0) return 0;
    if (line > this.last) return this.count;
    const block = Math.floor(line / BLOCK_BITS);
    let r = this.blockRank[block] as number;
    const target = Math.floor(line / 32);
    for (let w = block * BLOCK_WORDS; w < target; w++) r += popcount32(this.word(w));
    const bits = line % 32;
    if (bits > 0) r += popcount32(this.word(target) & (0xffffffff >>> (32 - bits)));
    return r;
  }

  /** The k-th member (0-based). */
  select(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k >= this.count) throw new RangeError(`Member ${k} out of range [0, ${this.count})`);
    let lo = 0;
    let hi = this.blocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((this.blockRank[mid] as number) <= k) lo = mid;
      else hi = mid - 1;
    }
    let r = this.blockRank[lo] as number;
    for (let w = lo * BLOCK_WORDS; ; w++) {
      const word = this.word(w);
      const pc = popcount32(word);
      if (r + pc > k) return w * 32 + nthBit(word, k - r);
      r += pc;
    }
  }

  /** Lines in [0, universe) that are not members. */
  complementSize(universe: number): number {
    return Math.max(0, universe - this.rank(universe));
  }

  /** Non-members smaller than `line`. */
  complementRank(line: number): number {
    return Math.max(0, line) - this.rank(line);
  }

  /** The k-th (0-based) line in [0, universe) that is not a member. */
  complementSelect(k: number, universe: number): number {
    if (!Number.isInteger(k) || k < 0 || k >= this.complementSize(universe)) {
      throw new RangeError(`Non-member ${k} out of range [0, ${this.complementSize(universe)})`);
    }
    const zerosToLast = this.last + 1 - this.count;
    if (k >= zerosToLast) return this.last + 1 + (k - zerosToLast);
    let lo = 0;
    let hi = this.blocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (mid * BLOCK_BITS - (this.blockRank[mid] as number) <= k) lo = mid;
      else hi = mid - 1;
    }
    let r = lo * BLOCK_BITS - (this.blockRank[lo] as number);
    for (let w = lo * BLOCK_WORDS; ; w++) {
      const inverted = ~this.word(w);
      const pc = popcount32(inverted);
      if (r + pc > k) return w * 32 + nthBit(inverted, k - r);
      r += pc;
    }
  }

  /** Up to `count` members starting with the k-th, ascending. */
  membersFrom(k: number, count: number): number[] {
    const out: number[] = [];
    if (k < 0 || k >= this.count || count <= 0) return out;
    let line = this.select(k);
    for (;;) {
      out.push(line);
      if (out.length >= count || k + out.length >= this.count) return out;
      line = this.nextMember(line + 1);
    }
  }

  /** Up to `count` non-members of [0, universe) starting with the k-th, ascending. */
  complementFrom(k: number, count: number, universe: number): number[] {
    const out: number[] = [];
    const size = this.complementSize(universe);
    if (k < 0 || k >= size || count <= 0) return out;
    let line = this.complementSelect(k, universe);
    for (;;) {
      out.push(line);
      if (out.length >= count || k + out.length >= size) return out;
      line = this.nextNonMember(line + 1);
    }
  }

  /** Bitset words covering [0, maxLine] (a copy, safe to transfer). */
  toWords(): Uint32Array {
    const n = Math.ceil((this.last + 1) / 32);
    const out = new Uint32Array(n);
    for (let p = 0; p * WORDS_PER_PAGE < n; p++) {
      const page = this.pages[p] as Uint32Array;
      out.set(page.subarray(0, Math.min(WORDS_PER_PAGE, n - p * WORDS_PER_PAGE)), p * WORDS_PER_PAGE);
    }
    return out;
  }

  toArray(): number[] {
    return this.membersFrom(0, this.count);
  }

  private word(w: number): number {
    const page = this.pages[Math.floor(w / WORDS_PER_PAGE)];
    return page ? (page[w % WORDS_PER_PAGE] as number) : 0;
  }

  /** Smallest member >= from; one must exist. */
  private nextMember(from: number): number {
    let w = Math.floor(from / 32);
    let word = this.word(w) & (-1 << from % 32);
    while (word === 0) word = this.word(++w);
    return w * 32 + (31 - Math.clz32(word & -word));
  }

  private nextNonMember(from: number): number {
    if (from > this.last) return from;
    let w = Math.floor(from / 32);
    let word = ~this.word(w) & (-1 << from % 32);
    while (word === 0) word = ~this.word(++w);
    return w * 32 + (31 - Math.clz32(word & -word));
  }
}
