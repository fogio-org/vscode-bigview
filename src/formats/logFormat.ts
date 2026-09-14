/**
 * Log lines: level detection (for coloring) and timestamp parsing (for display and the time
 * range filter). Pure functions shared by the search worker, the extension host and the webview.
 *
 * Timestamps without a zone are read as UTC.
 */
import { QueryError } from '../shared/searchQuery';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LevelMatch {
  level: LogLevel;
  /** Range of the level token in the line. */
  start: number;
  end: number;
}

/** Levels are only looked for near the start: a message that mentions "error" is not an error line. */
const LEVEL_WINDOW = 160;
const UPPER_LEVEL_RE = /(?<![\w-])(FATAL|CRITICAL|CRIT|EMERG|ALERT|SEVERE|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|DBG|TRACE|VERBOSE)(?![\w-])/;
/** Lower-case levels only count after a key, e.g. `level=info`, `"level":"error"`. */
const KEYED_LEVEL_RE = /(?:level|lvl|severity|loglevel)["']?\s*[=:]\s*["']?(fatal|critical|crit|error|err|warning|warn|notice|info|debug|trace|verbose)(?![\w-])/i;

const LEVELS: Record<string, LogLevel> = {
  fatal: 'fatal',
  critical: 'fatal',
  crit: 'fatal',
  emerg: 'fatal',
  alert: 'fatal',
  severe: 'error',
  error: 'error',
  err: 'error',
  warning: 'warn',
  warn: 'warn',
  notice: 'info',
  info: 'info',
  debug: 'debug',
  dbg: 'debug',
  trace: 'trace',
  verbose: 'trace',
};

export function detectLevel(line: string): LevelMatch | undefined {
  const head = line.length > LEVEL_WINDOW ? line.slice(0, LEVEL_WINDOW) : line;
  const keyed = KEYED_LEVEL_RE.exec(head);
  const upper = UPPER_LEVEL_RE.exec(head);
  const m = keyed && (!upper || keyed.index <= upper.index) ? keyed : upper;
  if (!m) return undefined;
  const token = m[1] as string;
  const start = m.index + m[0].length - token.length;
  return { level: LEVELS[token.toLowerCase()] as LogLevel, start, end: start + token.length };
}

export interface TimestampMatch {
  /** Epoch milliseconds (UTC). */
  ms: number;
  start: number;
  end: number;
  /** Size of the smallest unit present (60000 for minutes, 1000 for seconds, 1 for ms…). */
  precisionMs: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// 2026-01-01T12:34:56.789Z, 2026-01-01 12:34:56,789 +03:00, [2026-01-01 12:34]
const ISO_RE = /^\[?(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?: ?(Z|[+-]\d{2}(?::?\d{2})?))?\]?/;
// 2026/01/01 12:34:56
const SLASH_RE = /^\[?(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\]?/;
// Sep 15 12:34:56 (syslog, no year)
const SYSLOG_RE = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/;
// 1726400000 or 1726400000.123 or 1726400000123
const EPOCH_RE = /^(?:(\d{10})(?:\.(\d{1,6}))?|(\d{13}))(?![\d.])/;
// 127.0.0.1 - - [10/Oct/2026:13:55:36 -0700] (common log format, near the start)
const CLF_RE = /\[(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\]/;
const CLF_WINDOW = 100;

const EPOCH_MIN_S = 946_684_800; // 2000-01-01
const EPOCH_MAX_S = 4_102_444_800; // 2100-01-01

function build(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: string | undefined,
  frac: string | undefined,
  tz: string | undefined,
): { ms: number; precisionMs: number } | undefined {
  const sec = s === undefined ? 0 : Number(s);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 60) return undefined;
  let ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  let precisionMs = s === undefined ? 60_000 : 1000;
  if (frac) {
    ms += Number(frac.slice(0, 3).padEnd(3, '0'));
    precisionMs = frac.length >= 3 ? 1 : 10 ** (3 - frac.length);
  }
  if (tz && tz !== 'Z') {
    const digits = tz.slice(1).replace(':', '');
    const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0');
    ms -= (tz[0] === '-' ? -1 : 1) * offset * 60_000;
  }
  return { ms, precisionMs };
}

/** A timestamp at the start of the line (or a bracketed common-log-format date near it). */
export function parseTimestamp(line: string, defaultYear = new Date().getUTCFullYear()): TimestampMatch | undefined {
  let m = ISO_RE.exec(line) ?? SLASH_RE.exec(line);
  if (m) {
    const t = build(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), m[6], m[7], m[8]);
    return t && { ...t, start: 0, end: m[0].length };
  }
  m = SYSLOG_RE.exec(line);
  if (m) {
    const month = MONTHS[(m[1] as string).toLowerCase()];
    const t = month && build(defaultYear, month, Number(m[2]), Number(m[3]), Number(m[4]), m[5], m[6], undefined);
    return t ? { ...t, start: 0, end: m[0].length } : undefined;
  }
  m = EPOCH_RE.exec(line);
  if (m) {
    if (m[3]) {
      const ms = Number(m[3]);
      if (ms >= EPOCH_MIN_S * 1000 && ms < EPOCH_MAX_S * 1000) return { ms, start: 0, end: m[0].length, precisionMs: 1 };
    } else {
      const s = Number(m[1]);
      if (s >= EPOCH_MIN_S && s < EPOCH_MAX_S) {
        const frac = m[2];
        const ms = s * 1000 + (frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0);
        return { ms, start: 0, end: m[0].length, precisionMs: frac ? Math.max(1, 10 ** (3 - frac.length)) : 1000 };
      }
    }
  }
  const head = line.length > CLF_WINDOW ? line.slice(0, CLF_WINDOW) : line;
  m = CLF_RE.exec(head);
  if (m) {
    const month = MONTHS[(m[2] as string).toLowerCase()];
    const t = month && build(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), m[6], undefined, m[7]);
    return t ? { ...t, start: m.index, end: m.index + m[0].length } : undefined;
  }
  return undefined;
}

/**
 * Parses a bound of the time range filter. Accepts the timestamp formats above and a plain date.
 * The end bound includes the whole unit given: `to` = "2026-01-01 10:05" means up to 10:05:59.999.
 * Returns undefined for an empty input; throws QueryError when unrecognized.
 */
export function parseTimeInput(input: string, bound: 'from' | 'to', defaultYear?: number): number | undefined {
  const s = input.trim();
  if (s === '') return undefined;
  let ms: number;
  let precisionMs: number;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) {
    const t = build(Number(date[1]), Number(date[2]), Number(date[3]), 0, 0, '0', undefined, undefined);
    if (!t) throw new QueryError(`Unrecognized date: "${s}"`);
    ms = t.ms;
    precisionMs = 86_400_000;
  } else {
    const t = parseTimestamp(s, defaultYear);
    if (!t || t.start !== 0 || t.end !== s.length) {
      throw new QueryError(`Unrecognized time: "${s}" (use e.g. 2026-01-01 10:00:00 or 2026-01-01T10:00:00Z)`);
    }
    ms = t.ms;
    precisionMs = t.precisionMs;
  }
  return bound === 'from' ? ms : ms + precisionMs - 1;
}

/** Share of sample lines that look like log lines (timestamp or level). */
export function logLineShare(lines: readonly string[]): number {
  if (lines.length === 0) return 0;
  return lines.filter((l) => parseTimestamp(l) !== undefined || detectLevel(l) !== undefined).length / lines.length;
}
