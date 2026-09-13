import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChunkReader } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { LineIndex } from '../../src/core/LineIndex';
import { IndexerError, WorkerPool } from '../../src/workers/workerPool';
import { generateFixture } from '../fixtures/generate';
import { buildIndex, naiveText, tmpDir } from './helpers';

const dir = tmpDir('workers');
let pool: WorkerPool;
let bigFile: string;
let smallFile: string;
const files = new FileHandlePool({ idleMs: 50 });

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
  smallFile = path.join(dir, 'small.jsonl');
  generateFixture({ path: smallFile, sizeBytes: 300_000, format: 'jsonl', unicode: true, crlf: true, trailingNewline: false });
});

afterAll(() => {
  pool.dispose();
  files.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function expectSameIndex(actual: LineIndex, data: Uint8Array): void {
  const expected = buildIndex(data, { chunkSize: 1 << 20, stride: actual.stride });
  expect(actual.isComplete).toBe(true);
  expect(actual.lineCount).toBe(expected.lineCount);
  expect(actual.bytesIndexed).toBe(data.length);
  expect(Array.from(actual.toFloat64Array())).toEqual(Array.from(expected.toFloat64Array()));
}

describe('WorkerPool.index', () => {
  it('builds the same index as the in-process scanner, reporting progress', async () => {
    const index = new LineIndex();
    const progress: number[] = [];
    const outcome = await pool.index(bigFile, index, () => progress.push(index.lineCount)).result;

    const data = fs.readFileSync(bigFile);
    expect(outcome).toMatchObject({ status: 'done', fileSize: data.length, mtimeMs: fs.statSync(bigFile).mtimeMs });
    expectSameIndex(index, data);
    expect(index.stride).toBe(1);
    expect(progress.length).toBeGreaterThan(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('doubles the stride when the anchor budget is exceeded', async () => {
    const index = new LineIndex();
    await pool.index(bigFile, index, () => undefined, { maxAnchors: 1000, chunkSize: 1 << 20 }).result;
    const data = fs.readFileSync(bigFile);
    expect(index.anchorCount).toBeLessThanOrEqual(1000);
    expect(index.stride).toBeGreaterThanOrEqual(Math.ceil(index.lineCount / 1000));
    expectSameIndex(index, data);

    // Reads through the sparse index match the file exactly.
    const reader = new ChunkReader(files, bigFile, index);
    const expected = naiveText(data);
    for (const start of [0, index.stride - 1, index.stride * 7 + 3, index.lineCount - 50]) {
      expect((await reader.readLines(start, 50)).lines).toEqual(expected.slice(start, start + 50));
    }
  });

  it('is exact with tiny chunks (boundaries inside CRLF and multi-byte chars)', async () => {
    const index = new LineIndex();
    await pool.index(smallFile, index, () => undefined, { chunkSize: 4093, maxAnchors: 97 }).result;
    expectSameIndex(index, fs.readFileSync(smallFile));
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
