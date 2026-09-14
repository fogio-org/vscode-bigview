/**
 * Peak RSS of whole-file search, per query kind (the search worker runs in this process).
 *
 *   npm run build && tsx test/bench/searchMemory.ts [file] [old/young MB limits, e.g. 64/8 or none]
 */
import * as path from 'node:path';
import type { ResourceLimits } from 'node:worker_threads';
import type { SearchQuery } from '../../src/shared/searchQuery';
import { WorkerPool } from '../../src/workers/workerPool';

const MB = 1024 * 1024;

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const file = process.argv[2] ?? path.join(root, 'test', '.tmp', 'bench-1g.log');
  const limitsArg = process.argv[3];
  let resourceLimits: ResourceLimits | undefined;
  if (limitsArg === 'none') {
    resourceLimits = {};
  } else if (limitsArg) {
    const [old, young] = limitsArg.split('/').map(Number);
    resourceLimits = { maxOldGenerationSizeMb: old, maxYoungGenerationSizeMb: young };
  }
  const workers = new WorkerPool(path.join(root, 'dist'));
  const queries: Array<[string, SearchQuery]> = [
    ['literal', { text: 'NEEDLE_MARKER', caseSensitive: true, wholeWord: false, regex: false }],
    ['literal ci', { text: 'needle_marker', caseSensitive: false, wholeWord: false, regex: false }],
    ['regex ci', { text: 'error \\[worker-1[0-5]\\] .*timeout', caseSensitive: false, wholeWord: false, regex: true }],
    ['regex lookbehind', { text: '(?<=WARN  \\[)worker-7', caseSensitive: true, wholeWord: false, regex: true }],
  ];
  console.log(`limits ${limitsArg ?? 'default'}, baseline RSS ${Math.round(process.memoryUsage().rss / MB)} MB`);
  for (const [name, query] of queries) {
    const worker = workers.createSearchWorker(resourceLimits ? { resourceLimits } : {});
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
    let hits = 0;
    const t = performance.now();
    const outcome = await worker.search(file, query, { onProgress: (lines) => (hits += lines.length) }).result.catch((err: unknown) => String(err));
    clearInterval(timer);
    const status = typeof outcome === 'string' ? outcome : outcome.status;
    console.log(
      `${name.padEnd(18)} ${String(hits).padStart(8)} hits  ${(performance.now() - t).toFixed(0).padStart(6)} ms  peak RSS ${Math.round(peak / MB)} MB  ${status}`,
    );
    worker.dispose();
    await new Promise((r) => setTimeout(r, 500));
  }
  workers.dispose();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
