/** Search query model shared by the extension host, the search worker and the webview. */

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const EMPTY_QUERY: SearchQuery = { text: '', caseSensitive: false, wholeWord: false, regex: false };

/**
 * Log lines whose timestamp is within [from, to]; lines without a timestamp (e.g. stack traces)
 * belong to the timestamp above them. Either bound may be empty.
 */
export interface TimeRangeQuery {
  kind: 'time';
  from: string;
  to: string;
}

/** JSON Lines field predicate: `path=value` or `path~regex`. */
export interface FieldQuery {
  kind: 'field';
  expression: string;
}

/** Everything the search worker can match lines by (SPEC §2: regex plus preset predicates). */
export type Query = SearchQuery | TimeRangeQuery | FieldQuery;

export function isTextQuery(q: Query): q is SearchQuery {
  return !('kind' in q);
}

export function isEmptyQuery(q: Query): boolean {
  if (isTextQuery(q)) return q.text === '';
  if (q.kind === 'time') return q.from.trim() === '' && q.to.trim() === '';
  return q.expression.trim() === '';
}

/** [start, end) in UTF-16 code units. */
export type Range = readonly [start: number, end: number];

export class QueryError extends Error {}

export interface CompiledQuery {
  /** Matches within a single line; no `g`/`y` flag. */
  regex: RegExp;
  /**
   * True when scanning many lines at once with this regex cannot miss a matching line.
   * Only lookarounds can see across a line break and make the result context-dependent.
   */
  lineLocal: boolean;
}

// Characters that must be escaped; the set is also valid with the `u` flag.
const SYNTAX_CHARS = /[\\^$.*+?()[\]{}|/]/g;

export function escapeRegExp(text: string): string {
  return text.replace(SYNTAX_CHARS, '\\$&');
}

/** The raw text when the query can be matched with a plain byte search (fast path). */
export function literalNeedle(q: SearchQuery): string | undefined {
  return !q.regex && q.caseSensitive && !q.wholeWord ? q.text : undefined;
}

export function hasLookaround(source: string): boolean {
  return /\(\?<?[=!]/.test(source);
}

export function compileQuery(q: SearchQuery): CompiledQuery {
  if (q.text === '') throw new QueryError('Empty query');
  if (/[\r\n]/.test(q.text)) throw new QueryError('Search text cannot contain line breaks');

  const body = q.regex ? q.text : escapeRegExp(q.text);
  const flags = q.caseSensitive ? '' : 'i';
  const lineLocal = !q.regex || !hasLookaround(q.text);
  // Unicode-aware word boundaries need the `u` flag; user regexes that are invalid in
  // unicode mode (e.g. `\-`) fall back to classic syntax with ASCII word boundaries.
  const attempts = [
    { source: q.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, flags: `${flags}u` },
  ];
  if (q.regex) attempts.push({ source: q.wholeWord ? `(?<!\\w)(?:${body})(?!\\w)` : body, flags });

  let lastError: unknown;
  for (const a of attempts) {
    try {
      return { regex: new RegExp(a.source, a.flags), lineLocal };
    } catch (err) {
      lastError = err;
    }
  }
  throw new QueryError(lastError instanceof Error ? lastError.message : String(lastError));
}

const globalCache = new WeakMap<RegExp, RegExp>();

function toGlobal(regex: RegExp): RegExp {
  let g = globalCache.get(regex);
  if (!g) {
    g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    globalCache.set(regex, g);
  }
  return g;
}

/** Non-empty match ranges of `regex` in `text`, ascending, at most `max`. */
export function findRanges(text: string, regex: RegExp, max = 100): Range[] {
  const re = toGlobal(regex);
  const out: Range[] = [];
  re.lastIndex = 0;
  while (out.length < max) {
    const m = re.exec(text);
    if (!m) break;
    const end = m.index + m[0].length;
    if (end > m.index) {
      out.push([m.index, end]);
      re.lastIndex = end;
    } else {
      if (m.index >= text.length) break;
      // Empty match: step over one code point.
      const code = text.charCodeAt(m.index);
      re.lastIndex = m.index + (re.unicode && code >= 0xd800 && code <= 0xdbff ? 2 : 1);
    }
  }
  re.lastIndex = 0;
  return out;
}

export interface Snippet {
  text: string;
  ranges: Range[];
  cutStart: boolean;
  cutEnd: boolean;
}

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** A short excerpt of `line` around its first match, for the results list. */
export function makeSnippet(line: string, regex: RegExp | undefined, maxChars = 300, context = 40): Snippet {
  const ranges = regex ? findRanges(line, regex, 50) : [];
  let start = 0;
  const first = ranges[0];
  if (first && first[0] > context) start = first[0] - context;
  if (start > 0 && isLowSurrogate(line.charCodeAt(start))) start--;
  let end = Math.min(line.length, start + maxChars);
  if (end < line.length && end > start && isHighSurrogate(line.charCodeAt(end - 1))) end--;
  return {
    text: line.slice(start, end),
    ranges: ranges.filter(([s]) => s < end).map(([s, e]) => [s - start, Math.min(e, end) - start] as const),
    cutStart: start > 0,
    cutEnd: end < line.length,
  };
}
