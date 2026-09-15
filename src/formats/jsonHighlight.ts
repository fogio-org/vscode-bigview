/**
 * Lenient JSON tokenizer for syntax highlighting. Works on a single JSON Lines row or on
 * pretty-printed JSON, and never throws: invalid or truncated input (a line cut at the display
 * limit, an unterminated string) still gets tokens up to where it makes sense.
 */

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal';

export interface JsonToken {
  start: number;
  end: number;
  kind: JsonTokenKind;
}

/** Tokens per text; the rest of a very long line stays plain. */
export const MAX_JSON_TOKENS = 4096;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /(?:true|false|null)(?![\w$])/y;

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isWordChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24;

export function jsonTokens(text: string, maxTokens = MAX_JSON_TOKENS): JsonToken[] {
  const out: JsonToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n && out.length < maxTokens) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x5c) j += 2;
        else if (d === 0x22) {
          j++;
          break;
        } else j++;
      }
      j = Math.min(j, n);
      let k = j;
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      out.push({ start: i, end: j, kind: k < n && text.charCodeAt(k) === 0x3a ? 'key' : 'string' });
      i = j;
    } else if ((c === 0x2d || (c >= 0x30 && c <= 0x39)) && (i === 0 || !isWordChar(text.charCodeAt(i - 1)))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m && m[0].length > 0 && m[0] !== '-') {
        out.push({ start: i, end: i + m[0].length, kind: 'number' });
        i += m[0].length;
      } else {
        i++;
      }
    } else if ((c === 0x74 || c === 0x66 || c === 0x6e) && (i === 0 || !isWordChar(text.charCodeAt(i - 1)))) {
      LITERAL.lastIndex = i;
      const m = LITERAL.exec(text);
      if (m) {
        out.push({ start: i, end: i + m[0].length, kind: 'literal' });
        i += m[0].length;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out;
}
