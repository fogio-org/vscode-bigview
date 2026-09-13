/**
 * Licensing gate (SPEC §3.9). Everything is free in the MVP; call sites mark future gates.
 */

/** Files above this size are a future Pro gate. */
export const FREE_FILE_SIZE_LIMIT = 200 * 1024 * 1024;

export function isPro(): boolean {
  return true;
}
