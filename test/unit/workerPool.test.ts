import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LineIndex } from '../../src/core/LineIndex';
import { IndexerError, WorkerPool } from '../../src/workers/workerPool';
import { generateFixture } from '../fixtures/generate';
import { buildIndex, tmpDir } from './helpers';

const dir = tmpDir('workers');
let pool: WorkerPool;
let bigFile: string;

beforeAll(async () => {
  // The worker must be real JS: bundle it the same way esbuild.mjs does.
  await esbuild.build({
    entryPoints: { 'indexer.worker': path.resolve(__dirname, '../../src/workers/indexer.worker.ts') },
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  pool = new WorkerPool(dir);
  bigFile = path.join(dir, 'big.log');
  // > 3 worker chunks (8 MB), with multi-byte text and CRLF.
  generateFixture({ path: bigFile, sizeBytes: 26 * 1024 * 1024, format: 'log', unicode: true, crlf: true });
});

afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkerPool.index', () => {
  it('builds the same index as the in-process scanner, reporting progress', async () => {
    const index = new LineIndex();
    const progress: number[] = [];
    const outcome = await pool.index(bigFile, index, () => progress.push(index.lineCount)).result;

    const data = fs.readFileSync(bigFile);
    const expected = buildIndex(data, 1 << 20);
    expect(outcome).toMatchObject({ status: 'done', fileSize: data.length });
    expect(index.isComplete).toBe(true);
    expect(index.lineCount).toBe(expected.lineCount);
    for (let i = 0; i < expected.lineCount; i += 997) {
      expect(index.lineStart(i)).toBe(expected.lineStart(i));
      expect(index.lineEnd(i)).toBe(expected.lineEnd(i));
    }
    expect(index.lineEnd(index.lineCount - 1)).toBe(data.length);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(expected.lineCount);
    // progress is monotonic
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('indexes an empty file', async () => {
    const p = path.join(dir, 'empty.log');
    fs.writeFileSync(p, '');
    const index = new LineIndex();
    const outcome = await pool.index(p, index, () => undefined).result;
    expect(outcome).toMatchObject({ status: 'done', fileSize: 0 });
    expect(index.lineCount).toBe(0);
  });

  it('can be cancelled', async () => {
    const index = new LineIndex();
    const task = pool.index(bigFile, index, () => undefined);
    task.cancel();
    expect((await task.result).status).toBe('cancelled');
    expect(index.isComplete).toBe(false);
  });

  it('rejects with the errno code for a missing file', async () => {
    const task = pool.index(path.join(dir, 'nope.log'), new LineIndex(), () => undefined);
    await expect(task.result).rejects.toBeInstanceOf(IndexerError);
    await expect(task.result).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
