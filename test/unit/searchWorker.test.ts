import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileQuery, EMPTY_QUERY, type SearchQuery } from '../../src/shared/searchQuery';
import { SearchError, WorkerPool, type SearchTask, type SearchWorker } from '../../src/workers/workerPool';
import { generateFixture } from '../fixtures/generate';
import { naiveText, tmpDir } from './helpers';

const dir = tmpDir('search-worker');
let pool: WorkerPool;
let file: string;
let text: string[];

const q = (t: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ ...EMPTY_QUERY, caseSensitive: true, text: t, ...o });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await esbuild.build({
    entryPoints: { 'search.worker': path.resolve(__dirname, '../../src/workers/search.worker.ts') },
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  pool = new WorkerPool(dir);
  file = path.join(dir, 'big.log');
  generateFixture({ path: file, sizeBytes: 20 * 1024 * 1024, format: 'log', unicode: true, crlf: true, markerCount: 50 });
  text = naiveText(fs.readFileSync(file));
});

afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(worker: SearchWorker, query: SearchQuery, filePath = file): { task: SearchTask; lines: number[]; batches: () => number } {
  const lines: number[] = [];
  let batches = 0;
  const task = worker.search(filePath, query, {
    onProgress: (batch) => {
      batches++;
      for (const line of batch) lines.push(line);
    },
  });
  return { task, lines, batches: () => batches };
}

const reference = (query: SearchQuery): number[] => {
  const re = compileQuery(query).regex;
  return text.flatMap((t, i) => (re.test(t) ? [i] : []));
};

describe('SearchWorker', () => {
  it('finds the same lines as a per-line reference and streams progress', async () => {
    const worker = pool.createSearchWorker({ chunkBytes: 1 << 20, progressBytes: 2 << 20 });
    const queries = [
      q('NEEDLE_MARKER'),
      q('needle_marker', { caseSensitive: false }),
      q('ERROR \\[worker-1[0-5]\\]', { regex: true }),
      q('запрос', { wholeWord: true }),
      q('(?<=WARN  \\[)worker-7', { regex: true }),
    ];
    for (const query of queries) {
      const s = start(worker, query);
      const outcome = await s.task.result;
      expect(outcome).toMatchObject({ status: 'done', bytesSearched: fs.statSync(file).size });
      expect(s.lines).toEqual(reference(query));
      expect(s.batches()).toBeGreaterThan(5);
    }
    expect(reference(queries[0] as SearchQuery)).toHaveLength(50);
    expect(worker.restarts).toBe(0);
    worker.dispose();
  });

  it('a new search cancels the running one on the same thread', async () => {
    const worker = pool.createSearchWorker({ chunkBytes: 256 * 1024 });
    const first = start(worker, q('INFO'));
    await sleep(20);
    const second = start(worker, q('NEEDLE_MARKER'));
    expect(await first.task.result).toEqual({ status: 'cancelled' });
    expect((await second.task.result).status).toBe('done');
    expect(second.lines).toEqual(reference(q('NEEDLE_MARKER')));
    expect(worker.restarts).toBe(0);
    worker.dispose();
  });

  it('task.cancel() cancels', async () => {
    const worker = pool.createSearchWorker({ chunkBytes: 256 * 1024 });
    const s = start(worker, q('INFO'));
    s.task.cancel();
    expect(await s.task.result).toEqual({ status: 'cancelled' });
    const again = start(worker, q('NEEDLE_MARKER'));
    expect((await again.task.result).status).toBe('done');
    worker.dispose();
  });

  it('replaces a thread stuck in catastrophic backtracking', async () => {
    const hangFile = path.join(dir, 'hang.log');
    fs.writeFileSync(hangFile, `${'a'.repeat(34)}!\nNEEDLE\n`);
    const worker = pool.createSearchWorker({ hangMs: 300 });
    const stuck = start(worker, q('^(a+)+$', { regex: true }), hangFile);
    await sleep(150);
    const next = start(worker, q('NEEDLE'), hangFile);
    expect(await stuck.task.result).toEqual({ status: 'cancelled' });
    expect((await next.task.result).status).toBe('done');
    expect(next.lines).toEqual([1]);
    expect(worker.restarts).toBe(1);
    worker.dispose();
  });

  it('searches a 20 MB Cyrillic line within the default heap limit', async () => {
    const longFile = path.join(dir, 'long-line.log');
    fs.writeFileSync(longFile, `${'я'.repeat(10_000_000)}ЯЯЯ\nNEEDLE я\n`);
    const worker = pool.createSearchWorker();
    for (const [query, expected] of [
      [q('needle Я', { caseSensitive: false }), [1]],
      [q('яяя$', { regex: true, caseSensitive: false }), [0]],
      [q('ЯЯЯ'), [0]],
    ] as const) {
      const s = start(worker, query, longFile);
      expect((await s.task.result).status).toBe('done');
      expect(s.lines).toEqual(expected);
    }
    expect(worker.restarts).toBe(0);
    worker.dispose();
  });

  it('reports invalid queries and missing files', async () => {
    const worker = pool.createSearchWorker();
    const invalid = start(worker, q('(', { regex: true }));
    await expect(invalid.task.result).rejects.toBeInstanceOf(SearchError);
    await expect(invalid.task.result).rejects.toThrow(/Invalid regular expression/);
    const missing = start(worker, q('x'), path.join(dir, 'nope.log'));
    await expect(missing.task.result).rejects.toMatchObject({ code: 'ENOENT' });
    const ok = start(worker, q('NEEDLE_MARKER'));
    expect((await ok.task.result).status).toBe('done');
    worker.dispose();
  });

  it('terminates the idle thread and starts a new one on demand', async () => {
    const worker = pool.createSearchWorker({ idleMs: 50 });
    await start(worker, q('NEEDLE_MARKER')).task.result;
    expect(worker.alive).toBe(true);
    await sleep(200);
    expect(worker.alive).toBe(false);
    const s = start(worker, q('NEEDLE_MARKER'));
    expect((await s.task.result).status).toBe('done');
    expect(s.lines).toHaveLength(50);
    worker.dispose();
    expect(() => worker.search(file, q('x'), { onProgress: () => undefined })).toThrow(/disposed/);
  });
});
