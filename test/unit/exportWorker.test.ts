import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LineSet } from '../../src/core/LineSet';
import { ExportError, WorkerPool } from '../../src/workers/workerPool';
import { generateFixture } from '../fixtures/generate';
import { naiveLines, tmpDir } from './helpers';

const dir = tmpDir('export-worker');
let pool: WorkerPool;
let source: string;
let data: Buffer;
let lines: Array<[number, number]>;

beforeAll(async () => {
  await esbuild.build({
    entryPoints: { 'export.worker': path.resolve(__dirname, '../../src/workers/export.worker.ts') },
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  pool = new WorkerPool(dir);
  source = path.join(dir, 'source.log');
  generateFixture({ path: source, sizeBytes: 12 * 1024 * 1024, format: 'log', unicode: true, crlf: true, trailingNewline: false });
  data = fs.readFileSync(source);
  lines = naiveLines(data);
});

afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function selection(): LineSet {
  const set = new LineSet();
  for (let l = 0; l < lines.length; l++) if (l % 3 === 0 || l === lines.length - 1) set.add(l);
  return set;
}

const expected = (pick: (line: number) => boolean): Buffer =>
  Buffer.concat(lines.flatMap(([s, e], i) => (pick(i) ? [data.subarray(s, e)] : [])));

describe('WorkerPool.exportLines', () => {
  it('writes the selected lines and the inverted selection exactly', async () => {
    const set = selection();
    for (const invert of [false, true]) {
      const target = path.join(dir, `out-${invert}.log`);
      let progressCalls = 0;
      const outcome = await pool.exportLines(
        { source, target, words: set.toWords(), invert, lineCount: lines.length, chunkBytes: 1 << 20, progressBytes: 2 << 20 },
        () => progressCalls++,
      ).result;
      const want = expected((l) => set.has(l) !== invert);
      expect(outcome).toMatchObject({ status: 'done', bytesWritten: want.length });
      expect(fs.readFileSync(target).equals(want)).toBe(true);
      expect(progressCalls).toBeGreaterThan(3);
    }
  });

  it('transfers the bitset instead of copying it', () => {
    const words = selection().toWords();
    const task = pool.exportLines({ source, target: path.join(dir, 'transfer.log'), words, invert: false, lineCount: lines.length }, () => undefined);
    expect(words.byteLength).toBe(0);
    return task.result;
  });

  it('a cancelled export leaves no file behind', async () => {
    const target = path.join(dir, 'cancelled.log');
    const task = pool.exportLines({ source, target, words: selection().toWords(), invert: false, lineCount: lines.length, chunkBytes: 4096 }, () => undefined);
    task.cancel();
    expect(await task.result).toEqual({ status: 'cancelled' });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('reports errors for a missing source or target directory', async () => {
    const missingSource = pool.exportLines(
      { source: path.join(dir, 'nope.log'), target: path.join(dir, 'x.log'), words: new Uint32Array(1), invert: false, lineCount: 1 },
      () => undefined,
    );
    await expect(missingSource.result).rejects.toBeInstanceOf(ExportError);
    await expect(missingSource.result).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(path.join(dir, 'x.log'))).toBe(false);

    const badTarget = pool.exportLines(
      { source, target: path.join(dir, 'no-such-dir', 'x.log'), words: new Uint32Array(1), invert: false, lineCount: 1 },
      () => undefined,
    );
    await expect(badTarget.result).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
