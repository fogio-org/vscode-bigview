import { describe, expect, it } from 'vitest';
import { LineSet, popcount32 } from '../../src/core/LineSet';

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

/** Plain assertions: loops over tens of thousands of values are too slow with expect(). */
function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

function randomLines(seed: number, universe: number, density: number): number[] {
  const r = mulberry32(seed);
  const out: number[] = [];
  // Runs of dense and empty regions exercise whole-word and whole-block skips.
  let inRun = false;
  for (let line = 0; line < universe; line++) {
    if (line % 3000 === 0) inRun = r() < 0.5;
    const p = inRun ? Math.min(1, density * 1.8) : density * 0.2;
    if (r() < p) out.push(line);
  }
  return out;
}

function verify(lines: number[], universe: number): void {
  const set = new LineSet();
  set.addAll(lines);
  const members = new Set(lines);
  const non: number[] = [];
  for (let l = 0; l < universe; l++) if (!members.has(l)) non.push(l);

  eq(set.size, lines.length, 'size');
  eq(set.maxLine, lines.length ? lines[lines.length - 1] : -1, 'maxLine');
  let r = 0;
  for (let l = 0; l <= universe + 100; l++) {
    eq(set.rank(l), r, `rank(${l})`);
    eq(set.complementRank(l), l - r, `complementRank(${l})`);
    eq(set.has(l), members.has(l), `has(${l})`);
    if (members.has(l)) r++;
  }
  lines.forEach((line, k) => eq(set.select(k), line, `select(${k})`));
  non.forEach((line, k) => eq(set.complementSelect(k, universe), line, `complementSelect(${k})`));
  eq(set.complementSize(universe), non.length, 'complementSize');

  const rand = mulberry32(lines.length + universe);
  for (let i = 0; i < 20; i++) {
    const k = Math.floor(rand() * (lines.length + 5));
    const n = 1 + Math.floor(rand() * 600);
    expect(set.membersFrom(k, n)).toEqual(lines.slice(k, k + n));
    const j = Math.floor(rand() * (non.length + 5));
    expect(set.complementFrom(j, n, universe)).toEqual(non.slice(j, j + n));
  }

  const words = set.toWords();
  eq(words.length, Math.ceil((set.maxLine + 1) / 32), 'words length');
  for (let l = 0; l < words.length * 32; l++) {
    eq(((words[Math.floor(l / 32)] as number) >>> l % 32) & 1, members.has(l) ? 1 : 0, `bit ${l}`);
  }
  expect(set.toArray()).toEqual(lines);
}

describe('LineSet', () => {
  it('popcount32', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(1)).toBe(1);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x80000000)).toBe(1);
    expect(popcount32(-1)).toBe(32);
    expect(popcount32(0x5555aaaa)).toBe(16);
  });

  for (const density of [0, 0.0005, 0.02, 0.5, 0.97, 1]) {
    it(`rank/select and complement match a reference (density ${density})`, () => {
      verify(randomLines(Math.round(density * 1000) + 7, 20_000, density), 20_000);
    });
  }

  it('handles the universe extending past the last member', () => {
    verify([3, 4, 5, 40, 2047, 2048, 2049], 10_000);
    verify([], 300);
  });

  it('works across bitset pages (2^20 bits)', () => {
    const page = 1 << 20;
    const lines = [0, page - 33, page - 1, page, page + 1, page + 31, 2 * page - 1, 2 * page, 3 * page + 12_345, 5_000_000];
    const set = new LineSet();
    set.addAll(lines);
    lines.forEach((line, k) => {
      expect(set.select(k)).toBe(line);
      expect(set.rank(line)).toBe(k);
      expect(set.rank(line + 1)).toBe(k + 1);
      expect(set.has(line)).toBe(true);
    });
    expect(set.has(page + 2)).toBe(false);
    // non-members around the page boundaries round-trip through complementRank
    for (const probe of [1, page - 34, page - 32, page - 2, page + 2, page + 30, page + 32, 2 * page - 2, 2 * page + 1, 4_999_999, 5_000_001]) {
      expect(set.complementSelect(set.complementRank(probe), 6_000_000)).toBe(probe);
    }
    expect(set.complementFrom(set.complementRank(page - 3), 5, 6_000_000)).toEqual([page - 3, page - 2, page + 2, page + 3, page + 4]);
    expect(set.complementSize(6_000_000)).toBe(6_000_000 - lines.length);
    expect(set.complementSelect(6_000_000 - lines.length - 1, 6_000_000)).toBe(5_999_999);
    expect(set.membersFrom(3, 4)).toEqual([page, page + 1, page + 31, 2 * page - 1]);
    expect(set.toWords().length).toBe(Math.ceil(5_000_001 / 32));
  });

  it('costs one bit per line whatever the density', () => {
    const sparse = new LineSet();
    sparse.add(26_000_000 - 1);
    const dense = new LineSet();
    for (let l = 0; l < 26_000_000; l += 1) dense.add(l);
    for (const set of [sparse, dense]) {
      expect(set.memoryBytes).toBeGreaterThan(3 * 1024 * 1024);
      expect(set.memoryBytes).toBeLessThan(4 * 1024 * 1024);
    }
    expect(dense.select(12_345_678)).toBe(12_345_678);
    expect(dense.complementSize(26_000_000)).toBe(0);
    expect(sparse.complementSelect(25_999_998, 26_000_000)).toBe(25_999_998);
  });

  it('rejects out-of-order and invalid lines, ignores repeats', () => {
    const set = new LineSet();
    set.add(5);
    set.add(5);
    expect(set.size).toBe(1);
    expect(() => set.add(4)).toThrow(/ascending/);
    expect(() => set.add(-1)).toThrow(RangeError);
    expect(() => set.add(1.5)).toThrow(RangeError);
    expect(() => set.select(1)).toThrow(RangeError);
    expect(() => set.complementSelect(10, 10)).toThrow(RangeError);
  });

  it('an empty set: every line of the universe is in the complement', () => {
    const set = new LineSet();
    expect(set.rank(100)).toBe(0);
    expect(set.complementSelect(7, 10)).toBe(7);
    expect(set.complementFrom(8, 5, 10)).toEqual([8, 9]);
    expect(set.membersFrom(0, 5)).toEqual([]);
    expect(set.toWords().length).toBe(0);
  });
});
