/**
 * Parses a 1-based line number typed by the user ("14000000", "14 000 000", "14,000,000").
 * Returns undefined unless it is an integer in [1, max].
 */
export function parseLineNumber(input: string, max: number): number | undefined {
  const cleaned = input.trim().replace(/[\s,_']/g, '');
  if (!/^\d+$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : undefined;
}
