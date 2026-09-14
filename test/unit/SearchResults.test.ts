import { describe, expect, it } from 'vitest';
import { SearchResults } from '../../src/core/SearchResults';

describe('SearchResults', () => {
  it('stores hits across pages and finds them by line', () => {
    const r = new SearchResults();
    const lines = Array.from({ length: 200_000 }, (_, i) => i * 3 + 1);
    r.add(Float64Array.from(lines.slice(0, 70_000)));
    r.add(lines.slice(70_000));
    expect(r.total).toBe(200_000);
    expect(r.stored).toBe(200_000);
    expect(r.lineAt(0)).toBe(1);
    expect(r.lineAt(65_536)).toBe(65_536 * 3 + 1);
    expect(r.lineAt(199_999)).toBe(599_998);
    expect(r.lowerBound(0)).toBe(0);
    expect(r.lowerBound(1)).toBe(0);
    expect(r.lowerBound(2)).toBe(1);
    expect(r.lowerBound(599_998)).toBe(199_999);
    expect(r.lowerBound(599_999)).toBe(200_000);
  });

  it('counts every hit but stores only up to capacity', () => {
    const r = new SearchResults(5);
    r.add([1, 2, 3]);
    r.add([4, 5, 6, 7]);
    r.add([8]);
    expect(r.total).toBe(8);
    expect(r.stored).toBe(5);
    expect(r.toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(r.lowerBound(100)).toBe(5);
  });

  it('rejects out-of-range indexes', () => {
    const r = new SearchResults();
    r.add([10]);
    expect(() => r.lineAt(1)).toThrow(RangeError);
    expect(() => r.lineAt(-1)).toThrow(RangeError);
    expect(() => r.lineAt(0.5)).toThrow(RangeError);
  });
});
