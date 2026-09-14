/**
 * Performance bench (SPEC §8). Runs the core pipeline outside VS Code against generated
 * files and compares with the SPEC §1 thresholds. Metrics of not-yet-implemented
 * milestones are reported as "n/a".
 *
 *   npm run bench                 # 1 GB
 *   npm run bench -- --size 5g
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChunkReader } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { IndexStore, restoreLineIndex } from '../../src/core/IndexStore';
import { LineIndex } from '../../src/core/LineIndex';
import type { SearchQuery } from '../../src/shared/searchQuery';
import { WorkerPool, type SearchWorker } from '../../src/workers/workerPool';
import { parseSize, type GenerateResult } from '../fixtures/generate';

const MB = 1024 * 1024;
const GB = 1024 * MB;

interface Row {
  metric: string;
  value: string;
  limit: string;
  ok: boolean | undefined;
}

async function main(): Promise<void> {
  const sizeArg = process.argv.includes('--size') ? process.argv[process.argv.indexOf('--size') + 1] : undefined;
  const size = parseSize(sizeArg ?? '1g');
  const big = size > 2 * GB;
  const root = path.resolve(__dirname, '../..');
  const file = path.join(root, 'test', '.tmp', `bench-${sizeArg ?? '1g'}.log`);
  const gen = ensureFixture(root, file, size);

  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let phasePeak = baselineRss;
  const phases: Array<[string, number, number]> = [];
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rss);
    phasePeak = Math.max(phasePeak, rss);
  }, 10);
  /** Records the peak RSS of the phase that just ended and the RSS left after it. */
  const endPhase = (name: string): void => {
    const rss = process.memoryUsage().rss;
    phases.push([name, Math.max(phasePeak, rss), rss]);
    phasePeak = rss;
  };

  const pool = new FileHandlePool();
  const workers = new WorkerPool(path.join(root, 'dist'));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigview-bench-'));
  const store = new IndexStore(storeDir);

  // 1. Cold: scan with the worker.
  const index = new LineIndex();
  const reader = new ChunkReader(pool, file, index);
  const t0 = performance.now();
  let firstPageMs: number | undefined;
  let firstPage: Promise<void> | undefined;
  const task = workers.index(file, index, () => {
    if (!firstPage && index.lineCount >= 100) {
      firstPage = reader.readLines(0, 100).then(() => {
        firstPageMs = performance.now() - t0;
      });
    }
  });
  const outcome = await task.result;
  const indexMs = performance.now() - t0;
  await firstPage;
  if (outcome.status !== 'done') throw new Error('indexing did not finish');
  endPhase('index build');

  const gotoMs = await measureGoto(reader, index.lineCount);
  endPhase('go to line');

  // 2. Persist and reload from the sidecar.
  await store.save(file, { fileSize: outcome.fileSize, mtimeMs: outcome.mtimeMs, stride: index.stride, anchors: index.toFloat64Array() });
  const sidecarBytes = fs.statSync(store.pathFor(file)).size;
  const st = fs.statSync(file);
  const tc = performance.now();
  const restored = await restoreLineIndex(store, pool, file, st);
  const cacheMs = performance.now() - tc;
  if (!restored || restored.lineCount !== index.lineCount) throw new Error('cache restore mismatch');
  const cachedGotoMs = await measureGoto(new ChunkReader(pool, file, restored), restored.lineCount);
  endPhase('cache save/load');

  // 3. Whole-file search in the search worker.
  const searcher = workers.createSearchWorker();
  const literal = await timeSearch(searcher, file, { text: 'NEEDLE_MARKER', caseSensitive: true, wholeWord: false, regex: false });
  endPhase('literal search');
  const regex = await timeSearch(searcher, file, { text: 'error \\[worker-1[0-5]\\] .*timeout', caseSensitive: false, wholeWord: false, regex: true });
  endPhase('regex search');
  searcher.dispose();

  clearInterval(sampler);
  console.log('\nPhase                 peak RSS   RSS after');
  for (const [name, peak, after] of phases) {
    console.log(`${name.padEnd(20)} ${`${Math.round(peak / MB)} MB`.padStart(9)} ${`${Math.round(after / MB)} MB`.padStart(11)}`);
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const rows: Row[] = [
    { metric: 'First page (before index ready)', value: ms(firstPageMs), limit: '< 300 ms', ok: (firstPageMs ?? Infinity) < 300 },
    { metric: 'Index build', value: ms(indexMs), limit: big ? '< 60 s' : '< 12 s', ok: indexMs < (big ? 60_000 : 12_000) },
    { metric: 'Index load from disk cache', value: ms(cacheMs), limit: 'instant', ok: undefined },
    { metric: 'Scroll 60 fps', value: 'manual', limit: '60 fps', ok: undefined },
    { metric: 'Literal search, whole file', value: ms(literal.ms), limit: big ? '< 30 s' : '< 6 s', ok: literal.ms < (big ? 30_000 : 6_000) },
    { metric: `Regex search, ci (${regex.hits} hits)`, value: ms(regex.ms), limit: 'info', ok: undefined },
    { metric: 'Peak RSS', value: `${Math.round(peakRss / MB)} MB`, limit: big ? '< 400 MB' : '< 250 MB', ok: peakRss < (big ? 400 : 250) * MB },
    { metric: 'Go to line, scanned (p99, 100 lines)', value: ms(gotoMs), limit: '< 50 ms', ok: gotoMs < 50 },
    { metric: 'Go to line, cached (p99, 100 lines)', value: ms(cachedGotoMs), limit: '< 50 ms', ok: cachedGotoMs < 50 },
  ];

  console.log(
    `\nFile: ${(gen.bytes / MB).toFixed(0)} MB, ${gen.lines.toLocaleString('en-US')} lines, stride ${index.stride}, ` +
      `${index.anchorCount.toLocaleString('en-US')} anchors (${(index.memoryBytes / MB).toFixed(0)} MB pages), ` +
      `sidecar ${(sidecarBytes / MB).toFixed(1)} MB, baseline RSS ${Math.round(baselineRss / MB)} MB\n`,
  );
  const w = [40, 14, 10];
  console.log(`${'Metric'.padEnd(w[0]!)}${'Value'.padEnd(w[1]!)}${'Limit'.padEnd(w[2]!)}Result`);
  for (const r of rows) {
    const verdict = r.ok === undefined ? '-' : r.ok ? 'PASS' : 'FAIL';
    console.log(`${r.metric.padEnd(w[0]!)}${r.value.padEnd(w[1]!)}${r.limit.padEnd(w[2]!)}${verdict}`);
  }

  pool.dispose();
  workers.dispose();
  fs.rmSync(storeDir, { recursive: true, force: true });
  if (rows.some((r) => r.ok === false)) process.exitCode = 1;
}

async function timeSearch(worker: SearchWorker, file: string, query: SearchQuery): Promise<{ ms: number; hits: number }> {
  let hits = 0;
  const t = performance.now();
  const outcome = await worker.search(file, query, { onProgress: (lines) => (hits += lines.length) }).result;
  if (outcome.status !== 'done') throw new Error('search did not finish');
  return { ms: performance.now() - t, hits };
}

async function measureGoto(reader: ChunkReader, lineCount: number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < 500; i++) {
    const line = Math.floor(Math.random() * lineCount);
    const s = performance.now();
    await reader.readLines(line, 100);
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length * 0.99)] ?? 0;
}

/**
 * Reuses a previously generated fixture; otherwise generates it in a child process so the
 * generator's heap does not pollute this process's RSS measurement.
 */
function ensureFixture(root: string, file: string, size: number): GenerateResult {
  const meta = `${file}.json`;
  if (fs.existsSync(file) && fs.existsSync(meta)) {
    const saved = JSON.parse(fs.readFileSync(meta, 'utf8')) as GenerateResult;
    if (saved.bytes === fs.statSync(file).size && saved.bytes >= size) return saved;
  }
  console.log(`Generating ${file} ...`);
  const out = execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'test/fixtures/generate.ts'),
      '--size', String(size), '--format', 'log', '--avg-line', '200', '--seed', '99', '--out', file],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(out.trim().split('\n').pop() as string) as GenerateResult;
  fs.writeFileSync(meta, JSON.stringify(result));
  return result;
}

function ms(v: number | undefined): string {
  return v === undefined ? '—' : v < 1000 ? `${v.toFixed(1)} ms` : `${(v / 1000).toFixed(2)} s`;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
