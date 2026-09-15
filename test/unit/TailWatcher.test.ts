import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { snapshotOf, TailWatcher, type FileSnapshot } from '../../src/editor/TailWatcher';
import { tmpDir } from './helpers';

const dir = tmpDir('tail');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function waitFor<T>(probe: () => T | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('TailWatcher', () => {
  it('reports growth, truncation, replacement, deletion and recreation', async () => {
    const file = path.join(dir, 'app.log');
    fs.writeFileSync(file, 'one\n');
    const events: Array<FileSnapshot | undefined> = [];
    const watcher = new TailWatcher(file, (s) => events.push(s), 100);
    const last = (): FileSnapshot | undefined => events[events.length - 1];
    try {
      const ino = fs.statSync(file).ino;

      fs.appendFileSync(file, 'two\nthree\n');
      await waitFor(() => last()?.size === 14, 'growth');

      fs.truncateSync(file, 4);
      await waitFor(() => last()?.size === 4, 'truncation');
      expect(last()?.ino).toBe(ino);

      fs.renameSync(file, `${file}.1`);
      fs.writeFileSync(file, 'rotated\n');
      await waitFor(() => last()?.ino !== undefined && last()?.ino !== ino && last()?.size === 8, 'replacement');

      fs.unlinkSync(file);
      await waitFor(() => events.length > 0 && last() === undefined, 'deletion');

      fs.writeFileSync(file, 'back again\n');
      await waitFor(() => last()?.size === 11, 'recreation');

      // still watching the new file
      fs.appendFileSync(file, 'more\n');
      await waitFor(() => last()?.size === 16, 'growth after recreation');
    } finally {
      watcher.dispose();
    }
  });

  it('stays quiet without changes and after dispose', async () => {
    const file = path.join(dir, 'quiet.log');
    fs.writeFileSync(file, 'x\n');
    const events: unknown[] = [];
    const watcher = new TailWatcher(file, (s) => events.push(s), 30);
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([]);
    watcher.dispose();
    fs.appendFileSync(file, 'y\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([]);
  });

  it('snapshotOf returns undefined for missing files', async () => {
    expect(await snapshotOf(path.join(dir, 'nope'))).toBeUndefined();
  });
});
