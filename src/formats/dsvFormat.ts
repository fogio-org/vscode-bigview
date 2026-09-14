/**
 * Delimiter-separated values (CSV, TSV, …): quote-aware field splitting and delimiter detection.
 *
 * Each physical line is one row: quoted fields spanning several lines are not joined (the line
 * index is newline-based).
 */

export const DSV_DELIMITERS = [',', '\t', ';', '|'] as const;

/** Splits one line; `"a,b"` is one field and `""` inside quotes is a literal quote. */
export function parseDsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    let value = '';
    if (i < n && line[i] === '"') {
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q === -1) {
          value += line.slice(i);
          i = n;
          break;
        }
        value += line.slice(i, q);
        if (line[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
    }
    const d = line.indexOf(delimiter, i);
    if (d === -1) {
      out.push(value + line.slice(i));
      return out;
    }
    out.push(value + line.slice(i, d));
    i = d + delimiter.length;
  }
}

/**
 * The delimiter that splits the sample into the same number (>= 2) of fields on at least 80% of
 * the non-empty lines; ties go to more columns.
 */
export function detectDelimiter(lines: readonly string[]): string | undefined {
  const sample = lines.filter((l) => l.trim() !== '').slice(0, 50);
  if (sample.length === 0) return undefined;
  let best: { delimiter: string; score: number; columns: number } | undefined;
  for (const delimiter of DSV_DELIMITERS) {
    const counts = sample.map((l) => parseDsvLine(l, delimiter).length);
    const columns = counts[0] as number;
    if (columns < 2) continue;
    const score = counts.filter((c) => c === columns).length / counts.length;
    if (score < 0.8) continue;
    if (!best || score > best.score || (score === best.score && columns > best.columns)) best = { delimiter, score, columns };
  }
  return best?.delimiter;
}
