/**
 * JSON Lines: parsing a line, flat field paths, and the field filter (`path=value`,
 * `path~regex`). Pure functions shared by the search worker, the host and the webview.
 */
import { QueryError } from '../shared/searchQuery';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PathSegment = string | number;

export type JsonParse = { ok: true; value: JsonValue } | { ok: false; error: string };

export function parseJsonLine(line: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(line) as JsonValue };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A line holding a JSON object. */
export function isJsonObjectLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  const r = parseJsonLine(t);
  return r.ok && r.value !== null && typeof r.value === 'object' && !Array.isArray(r.value);
}

const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/;

/** `a.b[0]`, with `["odd key"]` for keys that are not plain identifiers. */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (PLAIN_KEY.test(seg)) out += out === '' ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

export function parsePath(path: string): PathSegment[] {
  const s = path.trim();
  if (s === '') throw new QueryError('Missing field name');
  const out: PathSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '[') {
      const close = s.indexOf(']', i);
      if (close === -1) throw new QueryError(`Unclosed [ in "${s}"`);
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) {
        out.push(Number(inner));
      } else if (/^".*"$/.test(inner)) {
        try {
          out.push(JSON.parse(inner) as string);
        } catch {
          throw new QueryError(`Bad quoted key ${inner}`);
        }
      } else {
        throw new QueryError(`Bad path segment [${inner}] (use [0] or ["key"])`);
      }
      i = close + 1;
      if (s[i] === '.') i++;
    } else {
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
      const key = s.slice(i, j);
      if (key === '') throw new QueryError(`Empty field name in "${s}"`);
      out.push(key);
      i = j;
      if (s[i] === '.') {
        i++;
        if (i === s.length) throw new QueryError(`Path ends with "." in "${s}"`);
      }
    }
  }
  return out;
}

export function getPath(value: JsonValue, path: readonly PathSegment[]): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const index = typeof seg === 'number' ? seg : /^\d+$/.test(seg) ? Number(seg) : NaN;
      cur = Number.isInteger(index) ? cur[index] : undefined;
    } else {
      cur = Object.prototype.hasOwnProperty.call(cur, String(seg)) ? cur[String(seg)] : undefined;
    }
  }
  return cur;
}

/** Text a value is compared as: strings raw, everything else as compact JSON. */
export function fieldValueText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface FlatField {
  path: string;
  value: JsonValue;
}

/** Leaf fields (primitives and empty containers) in document order, at most `max`. */
export function flattenJson(value: JsonValue, max = 1000): FlatField[] {
  const out: FlatField[] = [];
  const walk = (v: JsonValue, path: PathSegment[]): void => {
    if (out.length >= max) return;
    if (v !== null && typeof v === 'object') {
      const entries: Array<[PathSegment, JsonValue]> = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      if (entries.length === 0) {
        out.push({ path: formatPath(path), value: v });
        return;
      }
      for (const [k, child] of entries) walk(child, [...path, k]);
    } else {
      out.push({ path: formatPath(path), value: v });
    }
  };
  walk(value, []);
  return out;
}

export interface FieldFilter {
  path: PathSegment[];
  op: '=' | '~';
  expected?: string;
  regex?: RegExp;
  /**
   * Text every matching raw line must contain, checked before JSON.parse. Only set when that is
   * guaranteed (plain ASCII strings without escapes; not numbers, whose spelling may differ).
   */
  prefilter?: string;
}

const SAFE_ASCII = /^[\x20-\x7e]+$/;
const needsNoEscape = (s: string): boolean => SAFE_ASCII.test(s) && !/["\\]/.test(s);

/** `path=value` (exact; quote the value to keep spaces) or `path~regex` (`path~/regex/i` for flags). */
export function parseFieldFilter(expression: string): FieldFilter {
  const s = expression.trim();
  let depth = 0;
  let inQuote = false;
  let opIndex = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\') i++;
      else if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
    } else if (depth === 0 && (c === '=' || c === '~')) {
      opIndex = i;
      break;
    }
  }
  if (opIndex <= 0) throw new QueryError('Use field=value or field~regex');
  const path = parsePath(s.slice(0, opIndex));
  const raw = s.slice(opIndex + 1).trim();

  if (s[opIndex] === '=') {
    let expected = raw;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      try {
        expected = JSON.parse(raw) as string;
      } catch {
        throw new QueryError(`Bad quoted value ${raw}`);
      }
    }
    const prefilter = needsNoEscape(expected) && !/^[-\d[{]/.test(expected) ? expected : undefined;
    return { path, op: '=', expected, prefilter };
  }

  const literal = /^\/(.*)\/([dimsu]*)$/s.exec(raw);
  let regex: RegExp;
  try {
    regex = literal ? new RegExp(literal[1] as string, literal[2]) : new RegExp(raw);
  } catch (err) {
    throw new QueryError(err instanceof Error ? err.message : String(err));
  }
  const lastKey = [...path].reverse().find((seg): seg is string => typeof seg === 'string');
  const prefilter = lastKey !== undefined && needsNoEscape(lastKey) ? `"${lastKey}"` : undefined;
  return { path, op: '~', regex, prefilter };
}

export function matchFieldFilter(value: JsonValue, filter: FieldFilter): boolean {
  const v = getPath(value, filter.path);
  if (v === undefined) return false;
  const text = fieldValueText(v);
  return filter.op === '=' ? text === filter.expected : (filter.regex as RegExp).test(text);
}

/** Tests a raw line against the filter (prefilter, then parse). */
export function matchFieldLine(line: string, filter: FieldFilter): boolean {
  if (filter.prefilter !== undefined && !line.includes(filter.prefilter)) return false;
  const parsed = parseJsonLine(line);
  return parsed.ok && matchFieldFilter(parsed.value, filter);
}
