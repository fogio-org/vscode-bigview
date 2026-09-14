import { describe, expect, it } from 'vitest';
import {
  compileQuery,
  EMPTY_QUERY,
  escapeRegExp,
  findRanges,
  literalNeedle,
  makeSnippet,
  QueryError,
  type SearchQuery,
} from '../../src/shared/searchQuery';

const q = (text: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ ...EMPTY_QUERY, caseSensitive: true, text, ...o });

describe('compileQuery', () => {
  it('escapes literal text, including under the unicode flag', () => {
    const special = 'a+b(c)[d]{2}|^$.*?\\/-x';
    const { regex } = compileQuery(q(special));
    expect(regex.unicode).toBe(true);
    expect(regex.test(`xx ${special} yy`)).toBe(true);
    expect(regex.test('aab(c)')).toBe(false);
    expect(new RegExp(escapeRegExp(special), 'u').test(special)).toBe(true);
  });

  it('respects case sensitivity', () => {
    expect(compileQuery(q('Foo')).regex.test('foo')).toBe(false);
    expect(compileQuery(q('Foo', { caseSensitive: false })).regex.test('FOO')).toBe(true);
    expect(compileQuery(q('привет', { caseSensitive: false })).regex.test('ПРИВЕТ')).toBe(true);
  });

  it('whole word boundaries are unicode-aware', () => {
    const re = compileQuery(q('привет', { wholeWord: true })).regex;
    expect(re.test('скажи привет миру')).toBe(true);
    expect(re.test('привет')).toBe(true);
    expect(re.test('(привет)')).toBe(true);
    expect(re.test('приветствую')).toBe(false);
    expect(re.test('_привет')).toBe(false);
    expect(re.test('при привет2')).toBe(false);
  });

  it('whole word applies to a regex as a group', () => {
    const re = compileQuery(q('ba[rz]|qux', { regex: true, wholeWord: true })).regex;
    expect(re.test('foo baz.')).toBe(true);
    expect(re.test('bazooka')).toBe(false);
    expect(re.test('xqux')).toBe(false);
  });

  it('falls back to classic regex syntax when invalid in unicode mode', () => {
    const re = compileQuery(q('a\\-b', { regex: true })).regex;
    expect(re.unicode).toBe(false);
    expect(re.test('a-b')).toBe(true);
  });

  it('rejects invalid, empty and multi-line queries', () => {
    expect(() => compileQuery(q('(', { regex: true }))).toThrow(QueryError);
    expect(() => compileQuery(q(''))).toThrow(QueryError);
    expect(() => compileQuery(q('a\nb'))).toThrow(QueryError);
    expect(() => compileQuery(q('(', { regex: false }))).not.toThrow();
  });

  it('marks only regexes with lookarounds as not line-local', () => {
    expect(compileQuery(q('(?<=a)b', { regex: true })).lineLocal).toBe(false);
    expect(compileQuery(q('a(?!b)', { regex: true })).lineLocal).toBe(false);
    expect(compileQuery(q('(?<name>a)\\s+b', { regex: true })).lineLocal).toBe(true);
    expect(compileQuery(q('(?<=a)', { regex: false })).lineLocal).toBe(true);
    expect(compileQuery(q('word', { wholeWord: true })).lineLocal).toBe(true);
  });

  it('literalNeedle is only offered for case-sensitive plain text', () => {
    expect(literalNeedle(q('abc'))).toBe('abc');
    expect(literalNeedle(q('abc', { caseSensitive: false }))).toBeUndefined();
    expect(literalNeedle(q('abc', { wholeWord: true }))).toBeUndefined();
    expect(literalNeedle(q('abc', { regex: true }))).toBeUndefined();
  });
});

describe('findRanges', () => {
  it('finds all non-overlapping matches', () => {
    expect(findRanges('foo bar foo', /foo/)).toEqual([
      [0, 3],
      [8, 11],
    ]);
    expect(findRanges('aaaa', /aa/g)).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('skips empty matches without looping forever, stepping over surrogate pairs', () => {
    expect(findRanges('🚀x🚀', /x*/u)).toEqual([[2, 3]]);
    expect(findRanges('', /x*/)).toEqual([]);
    expect(findRanges('abc', /^/)).toEqual([]);
  });

  it('caps the number of ranges', () => {
    expect(findRanges('a'.repeat(1000), /a/, 5)).toHaveLength(5);
  });
});

describe('makeSnippet', () => {
  it('keeps short lines whole', () => {
    expect(makeSnippet('one NEEDLE two', /NEEDLE/)).toEqual({ text: 'one NEEDLE two', ranges: [[4, 10]], cutStart: false, cutEnd: false });
  });

  it('cuts long lines around the first match', () => {
    const line = `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`;
    const s = makeSnippet(line, /NEEDLE/, 300, 40);
    expect(s.cutStart).toBe(true);
    expect(s.cutEnd).toBe(true);
    expect(s.text.length).toBe(300);
    expect(s.ranges).toEqual([[40, 46]]);
    expect(s.text.slice(40, 46)).toBe('NEEDLE');
  });

  it('never splits a surrogate pair', () => {
    const line = `${'🚀'.repeat(100)}NEEDLE${'🚀'.repeat(200)}`;
    for (const context of [39, 40, 41]) {
      for (const max of [100, 101]) {
        const s = makeSnippet(line, /NEEDLE/, max, context);
        expect(() => encodeURIComponent(s.text)).not.toThrow();
        const [start, end] = s.ranges[0] as readonly [number, number];
        expect(s.text.slice(start, end)).toBe('NEEDLE');
      }
    }
  });
});
