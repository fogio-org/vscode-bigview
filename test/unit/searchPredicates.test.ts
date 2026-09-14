import { describe, expect, it } from 'vitest';
import { SEARCH_CHUNK_BYTES, searchFile, type SearchOptions } from '../../src/core/search';
import { parseFieldFilter } from '../../src/formats/jsonlFormat';
import { compileTimeRange, validateQuery } from '../../src/formats/predicates';
import { QueryError, type Query } from '../../src/shared/searchQuery';
import { enc, naiveText } from './helpers';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(data: Uint8Array, query: Query, opts: SearchOptions = {}): number[] {
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hits: number[] = [];
  const summary = searchFile(
    (buf, offset, length, position) => (position >= src.length ? 0 : src.copy(buf, offset, position, Math.min(position + length, src.length))),
    src.length,
    query,
    { hit: (l) => hits.push(l), progress: () => undefined, isCancelled: () => false },
    opts,
  );
  expect(summary.lineCount).toBe(naiveText(data).length);
  return hits;
}

const CHUNKINGS: SearchOptions[] = [{}, { chunkBytes: 256, overlapBytes: 16, decodeBytes: 40 }, { chunkBytes: 1000, decodeBytes: 1 }];
const BASE = Date.parse('2026-01-01T00:00:00Z');

describe('time range search', () => {
  // Log with timestamps every 7 s, some multi-line entries (stack traces) and CRLF.
  const r = mulberry32(5);
  const entries: Array<{ ms: number; lines: string[] }> = [];
  for (let i = 0; i < 400; i++) {
    const ms = BASE + i * 7000;
    const lines = [`${new Date(ms).toISOString()} ${r() < 0.2 ? 'ERROR' : 'INFO '} request ${i}`];
    if (r() < 0.25) lines.push('  at frame one', '  at frame two');
    entries.push({ ms, lines });
  }
  const text = `preamble without timestamp\n${entries.flatMap((e) => e.lines).join('\r\n')}\n`;
  const data = enc(text);
  // reference: every line inherits the entry timestamp; the preamble has none
  const lineTimes: Array<number | undefined> = [undefined, ...entries.flatMap((e) => e.lines.map(() => e.ms))];

  const expectRange = (from: number | undefined, to: number | undefined): number[] =>
    lineTimes.flatMap((t, i) => (t !== undefined && (from === undefined || t >= from) && (to === undefined || t <= to) ? [i] : []));

  const cases: Array<[string, string, number | undefined, number | undefined]> = [
    ['2026-01-01T00:10:00Z', '2026-01-01T00:20:00Z', BASE + 600_000, BASE + 1_200_999],
    ['', '2026-01-01 00:01', undefined, BASE + 119_999],
    ['2026-01-01T00:45:00.000Z', '', BASE + 2_700_000, undefined],
    ['2026-01-01', '2026-01-01', BASE, BASE + 86_399_999],
    ['2026-01-01T00:00:07Z', '2026-01-01T00:00:07Z', BASE + 7000, BASE + 7999],
  ];
  for (const [from, to, fromMs, toMs] of cases) {
    it(`selects [${from || '…'}, ${to || '…'}] including continuation lines`, () => {
      const expected = expectRange(fromMs, toMs);
      expect(expected.length).toBeGreaterThan(0);
      for (const opts of CHUNKINGS) expect(run(data, { kind: 'time', from, to }, opts)).toEqual(expected);
    });
  }

  it('matches nothing outside the log and validates bounds', () => {
    expect(run(data, { kind: 'time', from: '2030-01-01', to: '' })).toEqual([]);
    expect(() => compileTimeRange({ kind: 'time', from: '', to: '' })).toThrow(QueryError);
    expect(() => compileTimeRange({ kind: 'time', from: '2026-01-02', to: '2026-01-01' })).toThrow(/after/);
    expect(() => validateQuery({ kind: 'time', from: 'soon', to: '' })).toThrow(QueryError);
    expect(validateQuery({ kind: 'time', from: '2026-01-01', to: '' })).toBeUndefined();
  });
});

describe('JSON field search', () => {
  const r = mulberry32(11);
  const levels = ['info', 'info', 'warn', 'error'];
  const objects = Array.from({ length: 600 }, (_, i) => ({
    level: levels[Math.floor(r() * levels.length)],
    status: [200, 404, 500][i % 3],
    msg: r() < 0.1 ? `café NEEDLE ${i}` : `request ${i}`,
    user: { id: i, tags: r() < 0.5 ? ['a'] : ['b', 'c'] },
  }));
  const lines = objects.map((o, i) => {
    let s = JSON.stringify(o);
    if (i % 5 === 0) s = s.replace('é', '\\u00e9'); // escaped spelling on some lines
    if (i % 7 === 0) s = s.replace('"status":200', '"status":2e2');
    return s;
  });
  lines.splice(100, 0, 'not json at all level=error', '');
  const data = enc(`${lines.join('\n')}\n`);
  const parsed = naiveText(data).map((t) => {
    try {
      return JSON.parse(t) as (typeof objects)[number];
    } catch {
      return undefined;
    }
  });
  const reference = (expr: string): number[] => {
    const f = parseFieldFilter(expr);
    return parsed.flatMap((o, i) => {
      if (!o) return [];
      const v = f.path.reduce<unknown>((cur, seg) => (cur as Record<string, unknown> | undefined)?.[seg as string], o);
      if (v === undefined) return [];
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      return (f.op === '=' ? text === f.expected : (f.regex as RegExp).test(text)) ? [i] : [];
    });
  };

  for (const expr of ['level=error', 'status=200', 'msg~NEEDLE', 'msg~/^CAFÉ/i', 'msg=café NEEDLE 7', 'user.tags[1]=c', 'user.id~^1\\d$', 'missing=1']) {
    it(`matches ${expr}`, () => {
      const expected = reference(expr);
      for (const opts of CHUNKINGS) expect(run(data, { kind: 'field', expression: expr }, opts)).toEqual(expected);
      if (expr !== 'missing=1' && expr !== 'msg=café NEEDLE 7') expect(expected.length).toBeGreaterThan(0);
    });
  }

  it('rejects invalid expressions', () => {
    expect(() => validateQuery({ kind: 'field', expression: 'level' })).toThrow(QueryError);
    expect(() => run(data, { kind: 'field', expression: 'a~(' })).toThrow(QueryError);
  });

  it('uses the default 8 MB chunks too', () => {
    expect(SEARCH_CHUNK_BYTES).toBeGreaterThan(data.length);
    expect(run(data, { kind: 'field', expression: 'level=warn' })).toEqual(reference('level=warn'));
  });
});
