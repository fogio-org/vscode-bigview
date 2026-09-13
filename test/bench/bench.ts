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
import * as path from 'node:path';
import { ChunkReader } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { LineIndex } from '../../src/core/LineIndex';
import { WorkerPool } from '../../src/workers/workerPool';
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
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20);

  const pool = new FileHandlePool();
  const workers = new WorkerPool(path.join(root, 'dist'));
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

  const jumps: number[] = [];
  for (let i = 0; i < 500; i++) {
    const line = Math.floor(Math.random() * index.lineCount);
    const s = performance.now();
    await reader.readLines(line, 100);
    jumps.push(performance.now() - s);
  }
  jumps.sort((a, b) => a - b);
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const p99 = jumps[Math.floor(jumps.length * 0.99)] ?? 0;
  const rows: Row[] = [
    { metric: 'First page (before index ready)', value: ms(firstPageMs), limit: '< 300 ms', ok: (firstPageMs ?? Infinity) < 300 },
    { metric: 'Index build', value: ms(indexMs), limit: big ? '< 60 s' : '< 12 s', ok: indexMs < (big ? 60_000 : 12_000) },
    { metric: 'Scroll 60 fps', value: 'manual', limit: '60 fps', ok: undefined },
    { metric: 'Literal search, whole file', value: 'n/a (M3)', limit: big ? '< 30 s' : '< 6 s', ok: undefined },
    { metric: 'Peak RSS', value: `${Math.round(peakRss / MB)} MB`, limit: big ? '< 400 MB' : '< 250 MB', ok: peakRss < (big ? 400 : 250) * MB },
    { metric: 'Go to line (p99 of 500, 100 lines)', value: ms(p99), limit: '< 50 ms', ok: p99 < 50 },
  ];

  console.log(
    `\nFile: ${(gen.bytes / MB).toFixed(0)} MB, ${gen.lines.toLocaleString()} lines, ` +
      `index ${(index.memoryBytes / MB).toFixed(0)} MB, baseline RSS ${Math.round(baselineRss / MB)} MB\n`,
  );
  const w = [36, 14, 10];
  console.log(`${'Metric'.padEnd(w[0]!)}${'Value'.padEnd(w[1]!)}${'Limit'.padEnd(w[2]!)}Result`);
  for (const r of rows) {
    const verdict = r.ok === undefined ? '-' : r.ok ? 'PASS' : 'FAIL';
    console.log(`${r.metric.padEnd(w[0]!)}${r.value.padEnd(w[1]!)}${r.limit.padEnd(w[2]!)}${verdict}`);
  }

  pool.dispose();
  workers.dispose();
  if (rows.some((r) => r.ok === false)) process.exitCode = 1;
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
