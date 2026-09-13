import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_MARKER, generateFixture, parseSize, type FixtureFormat } from '../fixtures/generate';
import { buildIndex, naiveLines, tmpDir } from './helpers';

const dir = tmpDir('gen');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function countMarkerLines(data: Buffer, marker = DEFAULT_MARKER): number {
  return naiveLines(data).filter(([s, e]) => data.subarray(s, e).includes(marker)).length;
}

describe('generateFixture', () => {
  for (const format of ['log', 'jsonl', 'csv'] as FixtureFormat[]) {
    it(`${format}: exact marker count, reported stats match the file`, () => {
      const p = path.join(dir, `exact.${format}`);
      const res = generateFixture({ path: p, sizeBytes: 300_000, format, markerCount: 137, avgLineLength: 90 });
      const data = fs.readFileSync(p);
      expect(res.bytes).toBe(data.length);
      expect(data.length).toBeGreaterThanOrEqual(300_000);
      expect(res.lines).toBe(naiveLines(data).length);
      expect(res.markerLines).toBe(137);
      expect(countMarkerLines(data)).toBe(137);
      expect(data[data.length - 1]).toBe(0x0a);
    });
  }

  it('places all markers even when the file is tiny', () => {
    const p = path.join(dir, 'tiny.log');
    const res = generateFixture({ path: p, sizeBytes: 50, format: 'log', markerCount: 20 });
    expect(countMarkerLines(fs.readFileSync(p))).toBe(20);
    expect(res.markerLines).toBe(20);
  });

  it('marker ratio is roughly honoured', () => {
    const p = path.join(dir, 'ratio.jsonl');
    const res = generateFixture({ path: p, sizeBytes: 1_000_000, format: 'jsonl', markerRatio: 0.1 });
    expect(countMarkerLines(fs.readFileSync(p))).toBe(res.markerLines);
    expect(res.markerLines / res.lines).toBeGreaterThan(0.07);
    expect(res.markerLines / res.lines).toBeLessThan(0.13);
  });

  it('is deterministic for a given seed', () => {
    const a = path.join(dir, 'seed-a.log');
    const b = path.join(dir, 'seed-b.log');
    generateFixture({ path: a, sizeBytes: 100_000, format: 'log', seed: 42, unicode: true });
    generateFixture({ path: b, sizeBytes: 100_000, format: 'log', seed: 42, unicode: true });
    expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
  });

  it('supports crlf, unicode and no trailing newline', () => {
    const p = path.join(dir, 'crlf.csv');
    const res = generateFixture({
      path: p, sizeBytes: 200_000, format: 'csv', crlf: true, unicode: true, trailingNewline: false,
    });
    const data = fs.readFileSync(p);
    const text = data.toString('utf8');
    expect(text.startsWith('id,ts,level,user,message\r\n')).toBe(true);
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\r\n').length).toBe(res.lines);
    expect(/[^\x00-\x7f]/.test(text)).toBe(true);
    expect(buildIndex(data, 65536).lineCount).toBe(res.lines);
  });

  it('parseSize understands suffixes', () => {
    expect(parseSize('10')).toBe(10);
    expect(parseSize('4k')).toBe(4096);
    expect(parseSize('1.5m')).toBe(1.5 * 1024 * 1024);
    expect(parseSize('1GB')).toBe(1024 ** 3);
    expect(() => parseSize('lots')).toThrow();
  });
});
