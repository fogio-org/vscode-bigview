import { describe, expect, it } from 'vitest';
import { SEARCH_CHUNK_BYTES, searchFile, type SearchOptions } from '../../src/core/search';
import { compileQuery, EMPTY_QUERY, QueryError, type SearchQuery } from '../../src/shared/searchQuery';
import { EDGE_CASES, enc, naiveText } from './helpers';

const q = (text: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ ...EMPTY_QUERY, caseSensitive: true, text, ...o });

/** Per-line reference: a line matches iff the compiled regex matches its decoded text. */
function reference(data: Uint8Array, query: SearchQuery): number[] {
  const re = compileQuery(query).regex;
  return naiveText(data).flatMap((t, i) => (re.test(t) ? [i] : []));
}

interface Run {
  hits: number[];
  status: string;
  lineCount: number;
  bytesSearched: number;
  progress: number[];
}

function run(data: Uint8Array, query: SearchQuery, opts: SearchOptions = {}, cancelAfterChecks = Infinity): Run {
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hits: number[] = [];
  const progress: number[] = [];
  let checks = 0;
  const summary = searchFile(
    (buf, offset, length, position) => (position >= src.length ? 0 : src.copy(buf, offset, position, Math.min(position + length, src.length))),
    src.length,
    query,
    {
      hit: (line) => hits.push(line),
      progress: (bytes) => progress.push(bytes),
      isCancelled: () => checks++ >= cancelAfterChecks,
    },
    opts,
  );
  return { hits, progress, ...summary };
}

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

const TOKENS = ['foo', 'Foo', 'FOO', 'bar', 'привет', 'ПРИВЕТ', '🚀', 'x', '_foo', 'foo_', 'fo', 'o', 'a+b', '(x)', 'retry', 'é', ' ', '\t', ''];

/** Random lines of at most ~110 bytes, mixed `\n` / `\r\n`, optional final newline. */
function corpus(seed: number, lines: number): Uint8Array {
  const r = mulberry32(seed);
  const pick = (): string => TOKENS[Math.floor(r() * TOKENS.length)] as string;
  let text = '';
  for (let i = 0; i < lines; i++) {
    const parts = Array.from({ length: Math.floor(r() * 8) }, pick);
    text += parts.join(r() < 0.5 ? ' ' : '') + (r() < 0.3 ? '\r\n' : '\n');
  }
  if (r() < 0.5) text = text.replace(/\r?\n$/, '');
  return enc(text);
}

const QUERIES: SearchQuery[] = [
  q('foo'),
  q('foo', { caseSensitive: false }),
  q('foo', { wholeWord: true }),
  q('FOO', { wholeWord: true, caseSensitive: false }),
  q('привет', { caseSensitive: false }),
  q('🚀'),
  q('a+b'),
  q('(x)', { wholeWord: true }),
  q('o o'),
  q('^foo', { regex: true }),
  q('foo$', { regex: true }),
  q('o\\s+b', { regex: true }),
  q('x*', { regex: true }),
  q('(?<=_)foo', { regex: true }),
  q('foo(?!_)', { regex: true }),
  q('[^ ]{6,}', { regex: true }),
  q('привет|🚀', { regex: true, caseSensitive: false }),
  q('\\bbar\\b', { regex: true }),
  q('^$', { regex: true }),
  q('[\\s\\S]{30}', { regex: true }),
  q('retry\\s*$', { regex: true }),
];

const label = (query: SearchQuery): string =>
  `${JSON.stringify(query.text)}${query.regex ? ' regex' : ''}${query.caseSensitive ? '' : ' ci'}${query.wholeWord ? ' word' : ''}`;

describe('searchFile matches a per-line reference', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`random corpus #${seed}`, () => {
      const data = corpus(seed, 400);
      const lines = naiveText(data).length;
      for (const chunkBytes of [128, 200, 1000, SEARCH_CHUNK_BYTES]) {
        for (const decodeBytes of [1, 50, undefined]) {
          for (const query of QUERIES) {
            const r = run(data, query, { chunkBytes, overlapBytes: 8, decodeBytes });
            expect(r.hits, `${label(query)} chunk ${chunkBytes} decode ${decodeBytes}`).toEqual(reference(data, query));
            expect(r.lineCount).toBe(lines);
            expect(r.status).toBe('done');
            expect(r.bytesSearched).toBe(data.length);
          }
        }
      }
    });
  }

  for (const [name, text] of Object.entries(EDGE_CASES)) {
    it(`edge case: ${name}`, () => {
      const data = enc(text);
      const queries = [q('first'), q('^first', { regex: true }), q('^$', { regex: true }), q('three$', { regex: true }), q('B', { caseSensitive: false }), q('emoji', { wholeWord: true }), q('.*', { regex: true })];
      for (const chunkBytes of [16, 17, SEARCH_CHUNK_BYTES]) {
        for (const query of queries) {
          const r = run(data, query, { chunkBytes, overlapBytes: 4 });
          expect(r.hits, `${label(query)} chunk ${chunkBytes}`).toEqual(reference(data, query));
          expect(r.lineCount).toBe(naiveText(data).length);
        }
      }
    });
  }

  it('an empty file has no lines and no hits', () => {
    expect(run(new Uint8Array(0), q('x'))).toMatchObject({ hits: [], lineCount: 0, status: 'done' });
  });

  it('rejects invalid queries', () => {
    expect(() => run(enc('abc'), q('(', { regex: true }))).toThrow(QueryError);
  });
});

describe('lines longer than a chunk', () => {
  const opts = { chunkBytes: 64, overlapBytes: 16 };

  it('finds a needle anywhere in the line, including across window edges', () => {
    for (let pos = 0; pos <= 1000; pos += 7) {
      const giant = `${'a'.repeat(pos)}NEEDLE${'a'.repeat(1000 - pos)}`;
      const data = enc(`x\n${giant}\r\nNEEDLE\ny\n${'b'.repeat(500)}`);
      for (const query of [q('NEEDLE'), q('needle', { caseSensitive: false }), q('NEE.LE', { regex: true })]) {
        const r = run(data, query, opts);
        expect(r.hits, `${label(query)} at ${pos}`).toEqual([1, 2]);
        expect(r.lineCount).toBe(5);
      }
    }
  });

  it('keeps line numbers right after a long non-matching line', () => {
    const data = enc(`${'z'.repeat(5000)}\nhit\n${'z'.repeat(3000)}\nhit`);
    expect(run(data, q('hit'), opts)).toMatchObject({ hits: [1, 3], lineCount: 4 });
    expect(run(data, q('^hit$', { regex: true }), opts)).toMatchObject({ hits: [1, 3], lineCount: 4 });
  });

  it('handles a long last line without a newline, and a BOM at file start', () => {
    const data = enc(`\uFEFFNEEDLE${'q'.repeat(300)}\nshort\n${'w'.repeat(300)}NEEDLE`);
    expect(run(data, q('^NEEDLE', { regex: true }), opts)).toMatchObject({ hits: [0], lineCount: 3 });
    expect(run(data, q('NEEDLE$', { regex: true }), opts)).toMatchObject({ hits: [2], lineCount: 3 });
    expect(run(data, q('NEEDLE'), opts)).toMatchObject({ hits: [0, 2], lineCount: 3 });
  });

  it('reports each long matching line once', () => {
    const data = enc(`${'NEEDLE '.repeat(200)}\n${'NEEDLE '.repeat(200)}`);
    expect(run(data, q('NEEDLE'), opts).hits).toEqual([0, 1]);
    expect(run(data, q('x*', { regex: true }), opts).hits).toEqual([0, 1]);
  });
});

describe('8 MB chunk boundaries (SPEC §7.3)', () => {
  const MB8 = SEARCH_CHUNK_BYTES;
  const FILLER = `${'f'.repeat(99)}\n`;

  /** Filler lines, then a line in which `payload` starts exactly at byte `offset`. */
  function fileWith(offset: number, payload: string, suffix = ' tail\n'): { data: Buffer; line: number } {
    const fillerLines = Math.floor((offset - 1000) / 100);
    const target = 'p'.repeat(offset - fillerLines * 100) + payload + suffix;
    const data = Buffer.concat([Buffer.from(FILLER.repeat(fillerLines)), Buffer.from(target), Buffer.from('after 1\nafter 2\n')]);
    expect(data.indexOf(Buffer.from(payload))).toBe(offset);
    return { data, line: fillerLines };
  }

  it('finds a marker straddling or touching the boundary', () => {
    for (const delta of [-13, -12, -7, -1, 0, 1]) {
      const { data, line } = fileWith(MB8 + delta, 'NEEDLE_MARKER');
      for (const query of [q('NEEDLE_MARKER'), q('needle_marker', { caseSensitive: false }), q('NEEDLE_MARK(ER)', { regex: true })]) {
        const r = run(data, query);
        expect(r.hits, `${label(query)} delta ${delta}`).toEqual([line]);
        expect(r.lineCount).toBe(line + 3);
      }
    }
  });

  it('finds a marker on a line that starts exactly at the boundary', () => {
    const head = Buffer.from(FILLER.repeat(Math.floor(MB8 / 100) - 1));
    const pad = `${'r'.repeat(MB8 - head.length - 1)}\n`;
    const data = Buffer.concat([head, Buffer.from(pad), Buffer.from('NEEDLE_MARKER first\nlast\n')]);
    expect(data.indexOf('NEEDLE_MARKER')).toBe(MB8);
    const line = head.length / 100 + 1;
    expect(run(data, q('NEEDLE_MARKER')).hits).toEqual([line]);
    expect(run(data, q('^NEEDLE', { regex: true })).hits).toEqual([line]);
  });

  it('decodes Cyrillic and emoji split by the boundary', () => {
    const payload = 'привет🚀'; // 16 bytes
    for (let delta = -16; delta <= 0; delta++) {
      const { data, line } = fileWith(MB8 + delta, payload);
      for (const query of [q(payload), q('ПРИВЕТ🚀', { caseSensitive: false }), q('т🚀 tail$', { regex: true }), q('ВЕТ🚀 TAIL', { caseSensitive: false })]) {
        expect(run(data, query).hits, `${label(query)} delta ${delta}`).toEqual([line]);
      }
    }
  });

  it('handles \\r\\n split by the boundary', () => {
    const { data, line } = fileWith(MB8 - 6, 'retry\r', '\n');
    expect(data[MB8 - 1]).toBe(0x0d);
    expect(data[MB8]).toBe(0x0a);
    expect(run(data, q('retry$', { regex: true })).hits).toEqual([line]);
    expect(run(data, q('^after 1$', { regex: true })).hits).toEqual([line + 1]);
  });
});

describe('progress and cancellation', () => {
  it('reports progress every progressBytes', () => {
    const data = enc('abcdefghi\n'.repeat(100));
    const r = run(data, q('zzz'), { chunkBytes: 64, progressBytes: 100 });
    expect(r.progress.length).toBe(10);
    r.progress.forEach((bytes, i) => {
      expect(bytes).toBeGreaterThanOrEqual((i + 1) * 100);
      expect(bytes).toBeLessThan((i + 2) * 100);
    });
  });

  it('stops between chunks when cancelled', () => {
    const data = enc('NEEDLE\n'.repeat(1000));
    const r = run(data, q('NEEDLE'), { chunkBytes: 70 }, 2);
    expect(r.status).toBe('cancelled');
    expect(r.hits).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(r.bytesSearched).toBe(140);
  });

  it('can be cancelled inside a long line', () => {
    const data = enc(`${'a'.repeat(10_000)}\nNEEDLE`);
    const r = run(data, q('NEEDLE'), { chunkBytes: 64, overlapBytes: 8 }, 5);
    expect(r.status).toBe('cancelled');
    expect(r.hits).toEqual([]);
  });
});
