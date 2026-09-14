/**
 * Whole-file line search (SPEC §3.8). Pure and synchronous: it runs inside the search worker
 * and directly in unit tests.
 *
 * The file is read in chunks of `chunkBytes`. Each chunk is cut after its last `\n`; the
 * partial line at the end is re-read as the start of the next chunk, so no line and no
 * multi-byte character is ever split. A line longer than a chunk is searched in windows that
 * overlap by `overlapBytes`: a match longer than the overlap that straddles a window edge can
 * be missed, and `^`/`$` also match at window edges.
 *
 * Case-sensitive literal queries are matched on raw bytes with Buffer.indexOf. Everything else
 * decodes the chunk (in pieces) and tests lines: regexes (see RegexMatcher), the log time range
 * and the JSON field filter (SPEC §6 M5).
 *
 * A hit is a line: each matching line is reported once, in ascending order.
 */
import { matchFieldLine, type FieldFilter } from '../formats/jsonlFormat';
import { parseTimestamp } from '../formats/logFormat';
import { compileFieldQuery, compileTimeRange, type TimeRange } from '../formats/predicates';
import { compileQuery, isTextQuery, literalNeedle, type Query } from '../shared/searchQuery';

export const SEARCH_CHUNK_BYTES = 8 * 1024 * 1024;
export const SEARCH_OVERLAP_BYTES = 4 * 1024;
export const SEARCH_PROGRESS_BYTES = 64 * 1024 * 1024;
/**
 * Decoding matchers get a chunk in line-aligned pieces of about this size. Decoding a whole
 * 8 MB chunk into one string made V8 keep several such strings alive between collections
 * (+160 MB peak RSS on a 1 GB file).
 */
export const SEARCH_DECODE_BYTES = 1024 * 1024;

/** Reads up to `length` bytes at file `position` into `buf` at `offset`; returns bytes read. */
export type ReadFn = (buf: Buffer, offset: number, length: number, position: number) => number;

export interface SearchSink {
  /** A matching line (0-based). Ascending, at most once per line. */
  hit(line: number): void;
  /** Called each time another `progressBytes` have been searched. */
  progress(bytesSearched: number, linesSearched: number): void;
  /** Checked between chunks; every hit below `linesSearched` has been reported. */
  isCancelled(bytesSearched: number, linesSearched: number): boolean;
}

export interface SearchOptions {
  chunkBytes?: number;
  overlapBytes?: number;
  progressBytes?: number;
  decodeBytes?: number;
}

export interface SearchSummary {
  status: 'done' | 'cancelled';
  bytesSearched: number;
  /** Lines seen so far (all lines when done). */
  lineCount: number;
}

export interface LineMatcher {
  /** Whether scanning decodes bytes into strings (regions are then kept small). */
  readonly decodes: boolean;
  /**
   * Scans `region`, which holds whole lines (each ends with `\n`, except possibly the last one
   * at EOF). Calls `hit` for matching lines and returns the number of lines in the region.
   * Regions arrive in file order, so matchers may carry state from line to line.
   */
  scanLines(region: Buffer, firstLine: number, atFileStart: boolean, hit: (line: number) => void): number;
  /** Whether a piece of a single line (no `\n`) matches. */
  testFragment(fragment: Buffer, atLineEnd: boolean): boolean;
}

export function createMatcher(query: Query): LineMatcher {
  if (!isTextQuery(query)) {
    return query.kind === 'time' ? new TimeRangeMatcher(compileTimeRange(query)) : new FieldMatcher(compileFieldQuery(query));
  }
  const compiled = compileQuery(query); // validates every query, including literals
  const needle = literalNeedle(query);
  return needle !== undefined ? new ByteMatcher(Buffer.from(needle, 'utf8')) : new RegexMatcher(compiled.regex, compiled.lineLocal);
}

class ByteMatcher implements LineMatcher {
  readonly decodes = false;

  constructor(private readonly needle: Buffer) {}

  scanLines(region: Buffer, firstLine: number, _atFileStart: boolean, hit: (line: number) => void): number {
    let line = firstLine;
    let cursor = 0; // start of `line`
    for (;;) {
      const m = region.indexOf(this.needle, cursor);
      if (m === -1) break;
      let nl = region.indexOf(10, cursor);
      while (nl !== -1 && nl < m) {
        line++;
        nl = region.indexOf(10, nl + 1);
      }
      hit(line);
      if (nl === -1) return line + 1 - firstLine; // match on the unterminated last line
      line++;
      cursor = nl + 1;
    }
    for (let nl = region.indexOf(10, cursor); nl !== -1; nl = region.indexOf(10, nl + 1)) {
      line++;
      cursor = nl + 1;
    }
    if (cursor < region.length) line++;
    return line - firstLine;
  }

  testFragment(fragment: Buffer): boolean {
    return fragment.indexOf(this.needle) !== -1;
  }
}

/** Decodes regions and tests each line with `test`. */
abstract class PerLineMatcher implements LineMatcher {
  readonly decodes = true;
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });

  protected abstract test(line: string): boolean;

  scanLines(region: Buffer, firstLine: number, atFileStart: boolean, hit: (line: number) => void): number {
    if (region.length === 0) return 0;
    const s = this.decodeRegion(region, atFileStart);
    if (s.length === 0) {
      // A single empty line (e.g. only a BOM or `\r` before EOF).
      if (this.test('')) hit(firstLine);
      return 1;
    }
    return this.scan(s, firstLine, hit);
  }

  testFragment(fragment: Buffer, atLineEnd: boolean): boolean {
    let s = this.decoder.decode(fragment);
    if (atLineEnd && s.endsWith('\r')) s = s.slice(0, -1);
    return this.test(s);
  }

  /** Decoded region with the BOM removed and `\r\n` turned into `\n`. */
  protected decodeRegion(region: Buffer, atFileStart: boolean): string {
    let s = this.decoder.decode(region);
    if (atFileStart && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    if (s.includes('\r')) {
      s = s.replace(/\r\n/g, '\n');
      if (s.endsWith('\r')) s = s.slice(0, -1);
    }
    return s;
  }

  protected scan(s: string, firstLine: number, hit: (line: number) => void): number {
    let line = firstLine;
    for (let ls = 0; ls < s.length; line++) {
      let le = s.indexOf('\n', ls);
      if (le === -1) le = s.length;
      if (this.test(s.slice(ls, le))) hit(line);
      ls = le + 1;
    }
    return line - firstLine;
  }
}

/**
 * Line-local patterns run as one global multiline scan: the leftmost match jumps straight to
 * the next candidate line. A match that ends past its line (e.g. `a\s+b` across `\n`) is
 * re-checked against that line alone. Patterns with lookarounds can depend on text beyond the
 * line, so they are tested line by line.
 */
class RegexMatcher extends PerLineMatcher {
  private readonly global: RegExp;

  constructor(
    private readonly line: RegExp,
    private readonly lineLocal: boolean,
  ) {
    super();
    this.global = new RegExp(line.source, `${line.flags}gm`);
  }

  protected test(text: string): boolean {
    return this.line.test(text);
  }

  protected override scan(s: string, firstLine: number, hit: (line: number) => void): number {
    if (!this.lineLocal) return super.scan(s, firstLine, hit);
    const re = this.global;
    const n = s.length;
    let line = firstLine;
    let ls = 0; // start of `line`
    while (ls < n) {
      re.lastIndex = ls;
      const m = re.exec(s);
      if (!m) break;
      let le = s.indexOf('\n', ls);
      while (le !== -1 && le < m.index) {
        line++;
        ls = le + 1;
        le = s.indexOf('\n', ls);
      }
      if (ls >= n) break; // empty match after the final `\n`: not a line
      if (le === -1) le = n;
      if (m.index + m[0].length <= le || this.line.test(s.slice(ls, le))) hit(line);
      line++;
      ls = le + 1;
    }
    for (let le = ls < n ? s.indexOf('\n', ls) : -1; le !== -1; le = s.indexOf('\n', le + 1)) {
      line++;
      ls = le + 1;
    }
    if (ls < n) line++;
    return line - firstLine;
  }
}

/** Lines without a timestamp inherit the last one seen above them. */
class TimeRangeMatcher extends PerLineMatcher {
  private last: number | undefined;
  private readonly year = new Date().getUTCFullYear();

  constructor(private readonly range: TimeRange) {
    super();
  }

  protected test(line: string): boolean {
    const ts = parseTimestamp(line, this.year);
    if (ts) this.last = ts.ms;
    const t = this.last;
    return t !== undefined && (this.range.from === undefined || t >= this.range.from) && (this.range.to === undefined || t <= this.range.to);
  }
}

class FieldMatcher extends PerLineMatcher {
  constructor(private readonly filter: FieldFilter) {
    super();
  }

  protected test(line: string): boolean {
    return matchFieldLine(line, this.filter);
  }
}

export function searchFile(
  read: ReadFn,
  fileSize: number,
  query: Query,
  sink: SearchSink,
  opts: SearchOptions = {},
): SearchSummary {
  const matcher = createMatcher(query);
  const chunkBytes = Math.max(16, Math.floor(opts.chunkBytes ?? SEARCH_CHUNK_BYTES));
  const overlap = Math.max(1, Math.min(Math.floor(opts.overlapBytes ?? SEARCH_OVERLAP_BYTES), chunkBytes >> 1));
  const progressBytes = Math.max(1, opts.progressBytes ?? SEARCH_PROGRESS_BYTES);
  const pieceBytes = matcher.decodes ? Math.max(1, opts.decodeBytes ?? SEARCH_DECODE_BYTES) : Infinity;
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, fileSize)));
  const emit = (line: number): void => sink.hit(line);

  let nextProgress = progressBytes;
  const report = (pos: number, lines: number): void => {
    if (pos < nextProgress) return;
    sink.progress(pos, lines);
    nextProgress = (Math.floor(pos / progressBytes) + 1) * progressBytes;
  };

  let start = 0;
  let line = 0;
  while (start < fileSize) {
    if (sink.isCancelled(start, line)) return { status: 'cancelled', bytesSearched: start, lineCount: line };
    const want = Math.min(buf.length, fileSize - start);
    const n = readFully(read, buf, want, start);
    if (n === 0) break; // file shrank underneath us
    const eof = n < want || start + n >= fileSize;
    const view = buf.subarray(0, n);

    let end = n;
    if (!eof) {
      const lastNl = view.lastIndexOf(10);
      if (lastNl === -1) {
        const next = searchLongLine(read, buf, n, start, fileSize, line, matcher, overlap, sink, report);
        if (next === undefined) return { status: 'cancelled', bytesSearched: start, lineCount: line };
        line++;
        start = next;
        report(start, line);
        continue;
      }
      end = lastNl + 1;
    }
    for (let from = 0; from < end; ) {
      let to = end;
      if (end - from > pieceBytes) {
        const nl = view.indexOf(10, from + pieceBytes - 1);
        to = nl === -1 || nl + 1 > end ? end : nl + 1;
      }
      line += matcher.scanLines(view.subarray(from, to), line, start === 0 && from === 0, emit);
      from = to;
    }
    start += end;
    report(start, line);
  }
  return { status: 'done', bytesSearched: start, lineCount: line };
}

/**
 * Searches one line that does not fit into a chunk. `buf` already holds its first `n` bytes.
 * Returns the offset after the line, or undefined when cancelled.
 */
function searchLongLine(
  read: ReadFn,
  buf: Buffer,
  n: number,
  lineStart: number,
  fileSize: number,
  line: number,
  matcher: LineMatcher,
  overlap: number,
  sink: SearchSink,
  report: (pos: number, lines: number) => void,
): number | undefined {
  let winStart = lineStart;
  let requested = n;
  let matched = false;
  for (;;) {
    const win = buf.subarray(0, n);
    const nl = win.indexOf(10);
    const end = nl === -1 ? n : nl;
    const last = nl !== -1 || n < requested || winStart + n >= fileSize;
    if (!matched) {
      const skip = winStart === 0 && hasBom(win) ? Math.min(3, end) : 0;
      matched = matcher.testFragment(win.subarray(skip, end), last);
    }
    if (last) {
      if (matched) sink.hit(line);
      return nl !== -1 ? winStart + nl + 1 : winStart + n;
    }
    if (sink.isCancelled(winStart, line)) return undefined;
    // Overlap windows only while a match is still possible; afterwards just look for `\n`.
    const next = winStart + n - (matched ? 0 : overlap);
    requested = Math.min(buf.length, fileSize - next);
    n = readFully(read, buf, requested, next);
    winStart = next;
    report(winStart, line);
  }
}

function hasBom(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

export function readFully(read: ReadFn, buf: Buffer, length: number, position: number): number {
  let total = 0;
  while (total < length) {
    const r = read(buf, total, length - total, position + total);
    if (r <= 0) break;
    total += r;
  }
  return total;
}
