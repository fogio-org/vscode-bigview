import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseDsvLine } from '../../src/formats/dsvFormat';
import { detectFormat, formatFromExtension, formatLabel } from '../../src/shared/formats';

describe('parseDsvLine', () => {
  it('splits plain and quoted fields', () => {
    expect(parseDsvLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
    expect(parseDsvLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
    expect(parseDsvLine('"say ""hi""",x', ',')).toEqual(['say "hi"', 'x']);
    expect(parseDsvLine('a,,', ',')).toEqual(['a', '', '']);
    expect(parseDsvLine('', ',')).toEqual(['']);
    expect(parseDsvLine('"unterminated, still one', ',')).toEqual(['unterminated, still one']);
    expect(parseDsvLine('"q"tail,x', ',')).toEqual(['qtail', 'x']);
    expect(parseDsvLine('ab"c,d', ',')).toEqual(['ab"c', 'd']);
    expect(parseDsvLine('a\tb\t"c\td"', '\t')).toEqual(['a', 'b', 'c\td']);
  });
});

describe('detectDelimiter', () => {
  it('picks the delimiter with consistent column counts', () => {
    expect(detectDelimiter(['id,name,city', '1,"Doe, J",Paris', '2,Smith,Rome'])).toBe(',');
    expect(detectDelimiter(['id\tname', '1\ta,b', '2\tc'])).toBe('\t');
    expect(detectDelimiter(['a;b;c', '1;2,5;3', '4;5;6'])).toBe(';');
    expect(detectDelimiter(['a|b', '1|2'])).toBe('|');
  });

  it('returns undefined without a consistent delimiter', () => {
    expect(detectDelimiter(['just some text', 'more, text here', 'and, more, commas, here'])).toBeUndefined();
    expect(detectDelimiter(['single column', 'values'])).toBeUndefined();
    expect(detectDelimiter([])).toBeUndefined();
  });
});

describe('detectFormat', () => {
  const log = ['2026-01-01T00:00:00Z INFO started', '2026-01-01T00:00:01Z WARN slow', '  at stack frame', '2026-01-01T00:00:02Z ERROR boom'];
  const jsonl = ['{"level":"info","msg":"a"}', '{"level":"error","msg":"b"}', '{"level":"info","msg":"c"}'];
  const csv = ['id,ts,level', '1,2026,INFO', '2,2026,ERROR'];

  it('uses the extension', () => {
    expect(formatFromExtension('/x/app.LOG')).toEqual({ kind: 'log' });
    expect(formatFromExtension('a.ndjson')).toEqual({ kind: 'jsonl' });
    expect(formatFromExtension('a.tsv')).toEqual({ kind: 'dsv', delimiter: '\t' });
    expect(formatFromExtension('a.txt')).toBeUndefined();
    expect(detectFormat('app.log', log)).toEqual({ kind: 'log', source: 'extension' });
    expect(detectFormat('data.jsonl', ['not json'])).toEqual({ kind: 'jsonl', source: 'extension' });
    expect(detectFormat('data.csv', csv)).toEqual({ kind: 'dsv', delimiter: ',', source: 'extension', header: ['id', 'ts', 'level'] });
  });

  it('JSON content wins over a .log extension', () => {
    expect(detectFormat('service.log', jsonl)).toEqual({ kind: 'jsonl', source: 'content' });
  });

  it('sniffs unknown extensions: JSON, log, DSV, text', () => {
    expect(detectFormat('dump.txt', jsonl).kind).toBe('jsonl');
    expect(detectFormat('out', log).kind).toBe('log');
    expect(detectFormat('export.txt', ['a;b;c', '1;2;3', '4;5;6'])).toMatchObject({ kind: 'dsv', delimiter: ';', header: ['a', 'b', 'c'] });
    expect(detectFormat('notes.md', ['# Title', 'Some prose here.', ''])).toEqual({ kind: 'text', source: 'content' });
    expect(detectFormat('empty.txt', [])).toEqual({ kind: 'text', source: 'content' });
  });

  it('a user choice overrides detection', () => {
    expect(detectFormat('data.csv', csv, { kind: 'text' })).toEqual({ kind: 'text', source: 'user' });
    expect(detectFormat('data.csv', csv, { kind: 'dsv', delimiter: '\t' })).toEqual({
      kind: 'dsv',
      delimiter: '\t',
      source: 'user',
      header: ['id,ts,level'],
    });
    expect(detectFormat('app.log', ['a|b', '1|2'], { kind: 'dsv' })).toMatchObject({ delimiter: '|', header: ['a', 'b'] });
  });

  it('labels', () => {
    expect(formatLabel({ kind: 'dsv', delimiter: ',' })).toBe('CSV');
    expect(formatLabel({ kind: 'dsv', delimiter: '\t' })).toBe('TSV');
    expect(formatLabel({ kind: 'dsv', delimiter: ';' })).toBe('DSV (;)');
    expect(formatLabel({ kind: 'jsonl' })).toBe('JSON Lines');
    expect(formatLabel(undefined)).toBe('Plain text');
  });
});
