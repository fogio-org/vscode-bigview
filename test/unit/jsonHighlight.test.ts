import { describe, expect, it } from 'vitest';
import { jsonTokens, type JsonTokenKind } from '../../src/formats/jsonHighlight';

const tokens = (text: string, max?: number): Array<[JsonTokenKind, string]> =>
  jsonTokens(text, max).map((t) => [t.kind, text.slice(t.start, t.end)]);

describe('jsonTokens', () => {
  it('classifies keys, strings, numbers and literals', () => {
    expect(tokens('{"a": 1, "b":"x", "c": [true, null, -2.5e3, 0], "d": {"e" : false}}')).toEqual([
      ['key', '"a"'],
      ['number', '1'],
      ['key', '"b"'],
      ['string', '"x"'],
      ['key', '"c"'],
      ['literal', 'true'],
      ['literal', 'null'],
      ['number', '-2.5e3'],
      ['number', '0'],
      ['key', '"d"'],
      ['key', '"e"'],
      ['literal', 'false'],
    ]);
  });

  it('handles escapes, unicode and colons inside strings', () => {
    expect(tokens(String.raw`{"k\"q": "v\\", "url": "http://x:80", "ж": "привет 🔥"}`)).toEqual([
      ['key', String.raw`"k\"q"`],
      ['string', String.raw`"v\\"`],
      ['key', '"url"'],
      ['string', '"http://x:80"'],
      ['key', '"ж"'],
      ['string', '"привет 🔥"'],
    ]);
  });

  it('tokenizes pretty-printed JSON across lines', () => {
    const text = JSON.stringify({ level: 'error', n: 12, ok: true, tags: ['a'] }, null, 2);
    expect(tokens(text)).toEqual([
      ['key', '"level"'],
      ['string', '"error"'],
      ['key', '"n"'],
      ['number', '12'],
      ['key', '"ok"'],
      ['literal', 'true'],
      ['key', '"tags"'],
      ['string', '"a"'],
    ]);
  });

  it('survives truncated and invalid input', () => {
    expect(tokens('{"msg": "unterminated')).toEqual([
      ['key', '"msg"'],
      ['string', '"unterminated'],
    ]);
    expect(tokens('{"a": "x\\')).toEqual([
      ['key', '"a"'],
      ['string', '"x\\'],
    ]);
    expect(tokens('{"a": nullx, "b": truex, "c": abc123, "d": -, "e": 1.}')).toEqual([
      ['key', '"a"'],
      ['key', '"b"'],
      ['key', '"c"'],
      ['key', '"d"'],
      ['key', '"e"'],
      ['number', '1'],
    ]);
    expect(tokens('')).toEqual([]);
    expect(tokens('plain text line')).toEqual([]);
  });

  it('stops after maxTokens', () => {
    const text = JSON.stringify(Array.from({ length: 100 }, (_, i) => i));
    expect(jsonTokens(text, 10)).toHaveLength(10);
    expect(jsonTokens(text)).toHaveLength(100);
  });
});
