import { describe, expect, it } from 'vitest';
import {
  fieldValueText,
  flattenJson,
  formatPath,
  getPath,
  isJsonObjectLine,
  matchFieldFilter,
  matchFieldLine,
  parseFieldFilter,
  parseJsonLine,
  parsePath,
  type JsonValue,
} from '../../src/formats/jsonlFormat';
import { QueryError } from '../../src/shared/searchQuery';

const doc = { level: 'error', status: 200, ok: true, none: null, user: { id: 42, tags: ['a', 'b'], 'odd.key': 'x' }, empty: {}, list: [] } as JsonValue;

describe('paths', () => {
  it('parses dotted, indexed and quoted paths', () => {
    expect(parsePath('user.id')).toEqual(['user', 'id']);
    expect(parsePath('user.tags[1]')).toEqual(['user', 'tags', 1]);
    expect(parsePath('user["odd.key"]')).toEqual(['user', 'odd.key']);
    expect(parsePath(' a[0].b ')).toEqual(['a', 0, 'b']);
    expect(parsePath('tags.0')).toEqual(['tags', '0']);
    for (const bad of ['', 'a.', 'a[', 'a[x]', '.a', 'a..b']) expect(() => parsePath(bad)).toThrow(QueryError);
  });

  it('formats paths back', () => {
    expect(formatPath(['user', 'tags', 1])).toBe('user.tags[1]');
    expect(formatPath(['user', 'odd.key'])).toBe('user["odd.key"]');
    expect(formatPath([0, 'x'])).toBe('[0].x');
    for (const p of ['user.tags[1]', 'user["odd.key"]', 'a.b-c']) expect(formatPath(parsePath(p))).toBe(p);
  });

  it('reads values by path', () => {
    expect(getPath(doc, ['user', 'id'])).toBe(42);
    expect(getPath(doc, ['user', 'tags', 1])).toBe('b');
    expect(getPath(doc, ['user', 'tags', '0'])).toBe('a');
    expect(getPath(doc, ['none'])).toBeNull();
    expect(getPath(doc, ['user', 'missing'])).toBeUndefined();
    expect(getPath(doc, ['level', 'x'])).toBeUndefined();
    expect(getPath(doc, ['toString'])).toBeUndefined();
  });
});

describe('JSON lines', () => {
  it('parses and recognizes object lines', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonLine('{oops').ok).toBe(false);
    expect(isJsonObjectLine(' {"a":1} ')).toBe(true);
    expect(isJsonObjectLine('[1,2]')).toBe(false);
    expect(isJsonObjectLine('{not json}')).toBe(false);
  });

  it('flattens to leaf fields', () => {
    expect(flattenJson(doc)).toEqual([
      { path: 'level', value: 'error' },
      { path: 'status', value: 200 },
      { path: 'ok', value: true },
      { path: 'none', value: null },
      { path: 'user.id', value: 42 },
      { path: 'user.tags[0]', value: 'a' },
      { path: 'user.tags[1]', value: 'b' },
      { path: 'user["odd.key"]', value: 'x' },
      { path: 'empty', value: {} },
      { path: 'list', value: [] },
    ]);
    expect(flattenJson(doc, 3)).toHaveLength(3);
    expect(fieldValueText({ a: [1] })).toBe('{"a":[1]}');
  });
});

describe('field filter', () => {
  it('parses = and ~ with quoting and regex flags', () => {
    expect(parseFieldFilter('level=error')).toMatchObject({ path: ['level'], op: '=', expected: 'error', prefilter: 'error' });
    expect(parseFieldFilter('msg = "a = b"')).toMatchObject({ op: '=', expected: 'a = b' });
    expect(parseFieldFilter('user["a=b"]=1')).toMatchObject({ path: ['user', 'a=b'], expected: '1' });
    const re = parseFieldFilter('msg~/^TIME/i');
    expect(re.op).toBe('~');
    expect(re.regex?.flags).toBe('i');
    expect(re.prefilter).toBe('"msg"');
    expect(parseFieldFilter('user.tags[0]~^a').prefilter).toBe('"tags"');
    for (const bad of ['level', '=x', 'a[=1', 'x~(']) expect(() => parseFieldFilter(bad)).toThrow(QueryError);
  });

  it('only prefilters when the raw line must contain the text', () => {
    expect(parseFieldFilter('status=200').prefilter).toBeUndefined(); // 2e2, 200.0 …
    expect(parseFieldFilter('msg=café').prefilter).toBeUndefined(); // may be written as é
    expect(parseFieldFilter('msg=say "hi"').prefilter).toBeUndefined();
    expect(parseFieldFilter('obj={"a":1}').prefilter).toBeUndefined();
    expect(parseFieldFilter('ok=true').prefilter).toBe('true');
  });

  it('matches values as text', () => {
    const match = (expr: string): boolean => matchFieldFilter(doc, parseFieldFilter(expr));
    expect(match('level=error')).toBe(true);
    expect(match('level=Error')).toBe(false);
    expect(match('status=200')).toBe(true);
    expect(match('ok=true')).toBe(true);
    expect(match('none=null')).toBe(true);
    expect(match('user.id~^4\\d$')).toBe(true);
    expect(match('user.tags[1]=b')).toBe(true);
    expect(match('user["odd.key"]=x')).toBe(true);
    expect(match('missing=x')).toBe(false);
    expect(match('level~/ERR/i')).toBe(true);
  });

  it('prefilter never causes false negatives', () => {
    const escaped = '{"msg":"caf\\u00e9","level":"error","n":2e2}';
    expect(matchFieldLine(escaped, parseFieldFilter('msg=café'))).toBe(true);
    expect(matchFieldLine(escaped, parseFieldFilter('n=200'))).toBe(true);
    expect(matchFieldLine(escaped, parseFieldFilter('level=error'))).toBe(true);
    expect(matchFieldLine('{"level":"info"} error', parseFieldFilter('level=error'))).toBe(false);
    expect(matchFieldLine('not json level=error', parseFieldFilter('level=error'))).toBe(false);
  });
});
