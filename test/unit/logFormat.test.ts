import { describe, expect, it } from 'vitest';
import { detectLevel, logLineShare, parseTimeInput, parseTimestamp } from '../../src/formats/logFormat';
import { QueryError } from '../../src/shared/searchQuery';

const utc = (s: string): number => Date.parse(s);

describe('detectLevel', () => {
  it('finds upper-case level tokens near the start', () => {
    expect(detectLevel('2026-01-01T00:00:00Z ERROR [w-1] boom')).toEqual({ level: 'error', start: 21, end: 26 });
    expect(detectLevel('[WARN] disk')?.level).toBe('warn');
    expect(detectLevel('I 12:00 INFO started')?.level).toBe('info');
    expect(detectLevel('DEBUG x')?.level).toBe('debug');
    expect(detectLevel('<CRITICAL> x')?.level).toBe('fatal');
    expect(detectLevel('SEVERE: x')?.level).toBe('error');
    expect(detectLevel('TRACE-ID abc')).toBeUndefined(); // part of a word
    expect(detectLevel('INFORMATION only')).toBeUndefined();
  });

  it('accepts lower-case levels only after a level key', () => {
    const line = '{"ts":"2026-01-01","level":"error","msg":"x"}';
    const m = detectLevel(line);
    expect(m?.level).toBe('error');
    expect(line.slice(m?.start, m?.end)).toBe('error');
    expect(detectLevel('time=1 level=debug msg=x')?.level).toBe('debug');
    expect(detectLevel('user info updated')).toBeUndefined();
  });

  it('ignores levels far into the line', () => {
    expect(detectLevel(`${'x'.repeat(200)} ERROR`)).toBeUndefined();
  });
});

describe('parseTimestamp', () => {
  const cases: Array<[string, string, number, number]> = [
    ['2026-01-01T00:00:37.037Z INFO x', '2026-01-01T00:00:37.037Z', 24, 1],
    ['2026-01-01 12:34:56,789 WARN x', '2026-01-01T12:34:56.789Z', 23, 1],
    ['2026-01-01 12:34:56 +03:00 x', '2026-01-01T09:34:56Z', 26, 1000],
    ['2026-01-01T12:34:56-0130 x', '2026-01-01T14:04:56Z', 24, 1000],
    ['[2026-01-01 12:34] x', '2026-01-01T12:34:00Z', 18, 60_000],
    ['2026/01/02 03:04:05.6 x', '2026-01-02T03:04:05.600Z', 21, 100],
    ['1767225600 x', '2026-01-01T00:00:00Z', 10, 1000],
    ['1767225600.5 x', '2026-01-01T00:00:00.500Z', 12, 100],
    ['1767225600123 x', '2026-01-01T00:00:00.123Z', 13, 1],
  ];
  for (const [line, iso, end, precision] of cases) {
    it(`parses ${JSON.stringify(line.slice(0, end))}`, () => {
      expect(parseTimestamp(line)).toEqual({ ms: utc(iso), start: 0, end, precisionMs: precision });
    });
  }

  it('parses syslog dates with the default year', () => {
    expect(parseTimestamp('Sep 15 12:34:56 host sshd[1]: x', 2025)).toMatchObject({ ms: utc('2025-09-15T12:34:56Z'), end: 15 });
    expect(parseTimestamp('Sep  5 01:02:03 host', 2025)?.ms).toBe(utc('2025-09-05T01:02:03Z'));
  });

  it('parses common log format dates near the start', () => {
    const line = '127.0.0.1 - - [10/Oct/2026:13:55:36 -0700] "GET / HTTP/1.1" 200';
    expect(parseTimestamp(line)).toMatchObject({ ms: utc('2026-10-10T20:55:36Z'), start: 14, end: 42 });
  });

  it('rejects implausible or misplaced dates', () => {
    expect(parseTimestamp('x 2026-01-01T00:00:00Z')).toBeUndefined();
    expect(parseTimestamp('2026-13-01T00:00:00Z')).toBeUndefined();
    expect(parseTimestamp('0000000001 ok')).toBeUndefined();
    expect(parseTimestamp('12345678901234 too long')).toBeUndefined();
    expect(parseTimestamp('plain line')).toBeUndefined();
  });
});

describe('parseTimeInput', () => {
  it('makes the end bound inclusive of the unit given', () => {
    expect(parseTimeInput('2026-01-01', 'from')).toBe(utc('2026-01-01T00:00:00Z'));
    expect(parseTimeInput('2026-01-01', 'to')).toBe(utc('2026-01-01T23:59:59.999Z'));
    expect(parseTimeInput('2026-01-01 10:05', 'to')).toBe(utc('2026-01-01T10:05:59.999Z'));
    expect(parseTimeInput('2026-01-01T10:05:07Z', 'to')).toBe(utc('2026-01-01T10:05:07.999Z'));
    expect(parseTimeInput(' 2026-01-01T10:05:07.250Z ', 'to')).toBe(utc('2026-01-01T10:05:07.250Z'));
  });

  it('returns undefined for empty input and throws for garbage', () => {
    expect(parseTimeInput('  ', 'from')).toBeUndefined();
    expect(() => parseTimeInput('yesterday', 'from')).toThrow(QueryError);
    expect(() => parseTimeInput('2026-01-01T10:00Z trailing', 'from')).toThrow(QueryError);
    expect(() => parseTimeInput('2026-02-40', 'from')).toThrow(QueryError);
  });
});

describe('logLineShare', () => {
  it('counts lines with a timestamp or a level', () => {
    expect(logLineShare(['2026-01-01T00:00:00Z x', 'ERROR y', 'plain', 'text'])).toBe(0.5);
    expect(logLineShare([])).toBe(0);
  });
});
