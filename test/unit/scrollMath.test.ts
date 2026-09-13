import { describe, expect, it } from 'vitest';
import { MIN_THUMB_PX, positionForThumbOffset, thumbGeometry } from '../../webview/scrollMath';

describe('scrollMath', () => {
  it('no thumb when content fits', () => {
    expect(thumbGeometry(500, 600, 0, 600)).toBeUndefined();
    expect(thumbGeometry(600, 600, 0, 600)).toBeUndefined();
    expect(positionForThumbOffset(500, 600, 100, 600)).toBe(0);
  });

  it('proportional thumb for small content', () => {
    const g = thumbGeometry(2000, 500, 750, 500);
    expect(g?.size).toBe(125);
    expect(g?.offset).toBeCloseTo(187.5);
  });

  it('thumb never shrinks below the minimum on huge content', () => {
    // 25M lines x 20 px
    const content = 25_000_000 * 20;
    const g = thumbGeometry(content, 650, content / 2, 650);
    expect(g?.size).toBe(MIN_THUMB_PX);
    expect(g?.offset).toBeCloseTo((650 - MIN_THUMB_PX) / 2, 3);
  });

  it('ends map exactly to 0 and max', () => {
    const content = 5_281_569 * 20;
    const g = thumbGeometry(content, 652, content, 652);
    expect(g?.offset).toBe(652 - MIN_THUMB_PX);
    expect(positionForThumbOffset(content, 652, 652 - MIN_THUMB_PX, 652)).toBe(content - 652);
    expect(positionForThumbOffset(content, 652, 10_000, 652)).toBe(content - 652);
    expect(positionForThumbOffset(content, 652, -50, 652)).toBe(0);
  });

  it('positionForThumbOffset inverts thumbGeometry', () => {
    const content = 123_456_789;
    for (const pos of [0, 1, 1000, 50_000_000, content - 700]) {
      const g = thumbGeometry(content, 700, pos, 680);
      expect(positionForThumbOffset(content, 700, g?.offset ?? 0, 680)).toBeCloseTo(pos, 3);
    }
  });

  it('handles a track shorter than the minimum thumb', () => {
    const g = thumbGeometry(10_000, 100, 5000, 10);
    expect(g?.size).toBe(10);
    expect(g?.offset).toBe(0);
    expect(positionForThumbOffset(10_000, 100, 5, 10)).toBe(0);
  });
});
