/** Pure scrollbar geometry, shared by both axes of the virtual scrollbar. */

export const MIN_THUMB_PX = 20;

export interface ThumbGeometry {
  /** Thumb length along the track, px. */
  size: number;
  /** Thumb start offset from the track start, px. */
  offset: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function thumbSize(content: number, viewport: number, track: number): number {
  return clamp((track * viewport) / content, Math.min(MIN_THUMB_PX, track), track);
}

/**
 * Thumb geometry for `content` px of content shown through `viewport` px, scrolled to
 * `position`, on a track `track` px long. Undefined when nothing to scroll.
 */
export function thumbGeometry(content: number, viewport: number, position: number, track: number): ThumbGeometry | undefined {
  const max = content - viewport;
  if (max <= 0 || track <= 0) return undefined;
  const size = thumbSize(content, viewport, track);
  const offset = ((track - size) * clamp(position, 0, max)) / max;
  return { size, offset };
}

/** Inverse of thumbGeometry: scroll position for a thumb placed at `offset`. */
export function positionForThumbOffset(content: number, viewport: number, offset: number, track: number): number {
  const max = content - viewport;
  if (max <= 0 || track <= 0) return 0;
  const free = track - thumbSize(content, viewport, track);
  if (free <= 0) return 0;
  return clamp(offset / free, 0, 1) * max;
}
