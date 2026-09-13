import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, indexStateLabel, statusBarText, type StatusInfo } from '../../src/shared/format';
import { parseLineNumber } from '../../src/shared/lineNumber';

describe('parseLineNumber', () => {
  it('accepts plain and grouped numbers within range', () => {
    expect(parseLineNumber('1', 10)).toBe(1);
    expect(parseLineNumber(' 14000000 ', 25_000_000)).toBe(14_000_000);
    expect(parseLineNumber('14 000 000', 25_000_000)).toBe(14_000_000);
    expect(parseLineNumber('14,000,000', 25_000_000)).toBe(14_000_000);
    expect(parseLineNumber('14_000_000', 25_000_000)).toBe(14_000_000);
  });

  it('rejects out of range and garbage', () => {
    for (const bad of ['', '0', '11', '-3', '1.5', 'abc', '1e3', '99999999999999999999']) {
      expect(parseLineNumber(bad, 10)).toBeUndefined();
    }
  });
});

describe('format', () => {
  const base: StatusInfo = { fileSize: 5 * 1024 ** 3, lineCount: 25_000_000, bytesIndexed: 5 * 1024 ** 3, state: 'ready', source: 'scan' };

  it('formats sizes and counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatCount(25_000_000)).toBe('25,000,000');
  });

  it('describes the index state', () => {
    expect(indexStateLabel(base)).toBe('Indexed');
    expect(indexStateLabel({ ...base, source: 'cache' })).toBe('Index cached');
    expect(indexStateLabel({ ...base, state: 'indexing', bytesIndexed: base.fileSize * 0.456 })).toBe('Indexing 45%');
    expect(indexStateLabel({ ...base, state: 'failed' })).toBe('Index failed');
    expect(indexStateLabel({ ...base, state: 'indexing', fileSize: 0, bytesIndexed: 0 })).toBe('Indexing 100%');
  });

  it('status bar text has size, lines and state', () => {
    expect(statusBarText(base)).toBe('5.0 GB · 25,000,000 lines · $(check) Indexed');
    expect(statusBarText({ ...base, source: 'cache' })).toContain('$(database) Index cached');
    expect(statusBarText({ ...base, state: 'indexing', bytesIndexed: 0 })).toContain('$(sync~spin) Indexing 0%');
  });
});
