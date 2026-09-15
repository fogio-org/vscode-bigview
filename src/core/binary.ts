/** Binary file detection (SPEC §3.7): a NUL byte in the first 4 MB. */

export const BINARY_SAMPLE_BYTES = 4 * 1024 * 1024;

export function looksBinary(head: Uint8Array): boolean {
  return head.includes(0);
}
