/**
 * File format: chosen by extension, content sniffing (SPEC §5 formats.ts) or the user.
 */
import { detectDelimiter, parseDsvLine } from '../formats/dsvFormat';
import { isJsonObjectLine } from '../formats/jsonlFormat';
import { logLineShare } from '../formats/logFormat';

export type FormatKind = 'text' | 'log' | 'jsonl' | 'dsv';

export interface FormatChoice {
  kind: FormatKind;
  /** DSV only. */
  delimiter?: string;
}

export interface FormatInfo extends FormatChoice {
  source: 'extension' | 'content' | 'user';
  /** DSV only: column names from the first line. */
  header?: string[];
}

export function formatFromExtension(fileName: string): FormatChoice | undefined {
  const ext = /\.([^./\\]+)$/.exec(fileName.toLowerCase())?.[1];
  switch (ext) {
    case 'log':
      return { kind: 'log' };
    case 'jsonl':
    case 'ndjson':
      return { kind: 'jsonl' };
    case 'csv':
      return { kind: 'dsv', delimiter: ',' };
    case 'tsv':
    case 'tab':
      return { kind: 'dsv', delimiter: '\t' };
    default:
      return undefined;
  }
}

const JSON_SHARE = 0.8;
const LOG_SHARE = 0.5;

/**
 * `sample` are the first lines of the file. JSON Lines content wins over a `.log` extension (many
 * logs are JSON); otherwise the extension decides, then content: JSON, log, DSV, plain text.
 */
export function detectFormat(fileName: string, sample: readonly string[], override?: FormatChoice): FormatInfo {
  const lines = sample.filter((l) => l.trim() !== '').slice(0, 50);
  const finish = (choice: FormatChoice, source: FormatInfo['source']): FormatInfo => {
    if (choice.kind !== 'dsv') return { kind: choice.kind, source };
    const delimiter = choice.delimiter ?? detectDelimiter(lines) ?? ',';
    return { kind: 'dsv', delimiter, source, header: sample.length > 0 ? parseDsvLine(sample[0] as string, delimiter) : [] };
  };
  if (override) return finish(override, 'user');

  const byExtension = formatFromExtension(fileName);
  if (byExtension && byExtension.kind !== 'log') return finish(byExtension, 'extension');
  const jsonShare = lines.length ? lines.filter(isJsonObjectLine).length / lines.length : 0;
  if (jsonShare >= JSON_SHARE) return finish({ kind: 'jsonl' }, 'content');
  if (byExtension) return finish(byExtension, 'extension');
  if (logLineShare(lines) >= LOG_SHARE) return finish({ kind: 'log' }, 'content');
  const delimiter = detectDelimiter(lines);
  if (delimiter) return finish({ kind: 'dsv', delimiter }, 'content');
  return finish({ kind: 'text' }, 'content');
}

const DELIMITER_NAMES: Record<string, string> = { ',': 'CSV', '\t': 'TSV', ';': 'DSV (;)', '|': 'DSV (|)' };

export function formatLabel(format: FormatChoice | undefined): string {
  switch (format?.kind) {
    case 'log':
      return 'Log';
    case 'jsonl':
      return 'JSON Lines';
    case 'dsv':
      return DELIMITER_NAMES[format.delimiter ?? ','] ?? `DSV (${format.delimiter})`;
    default:
      return 'Plain text';
  }
}
