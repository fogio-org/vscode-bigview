import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { tmpDir } from './helpers';

const dir = tmpDir('pool');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FileHandlePool', () => {
  it('reads byte ranges and returns short buffers at EOF', async () => {
    const pool = new FileHandlePool();
    const p = file('a.txt', '0123456789');
    expect((await pool.read(p, 2, 3)).toString()).toBe('234');
    expect((await pool.read(p, 8, 10)).toString()).toBe('89');
    expect((await pool.read(p, 20, 5)).length).toBe(0);
    pool.dispose();
  });

  it('reuses a handle for the same file', async () => {
    const pool = new FileHandlePool();
    const p = file('b.txt', 'abc');
    await Promise.all([pool.read(p, 0, 1), pool.read(p, 1, 1), pool.read(p, 2, 1)]);
    expect(pool.openCount).toBe(1);
    pool.dispose();
    expect(pool.openCount).toBe(0);
  });

  it('evicts least recently used idle handles beyond maxOpen', async () => {
    const pool = new FileHandlePool({ maxOpen: 2 });
    const files = ['c1', 'c2', 'c3', 'c4'].map((n) => file(n, n));
    for (const f of files) await pool.read(f, 0, 2);
    expect(pool.openCount).toBe(2);
    pool.dispose();
  });

  it('closes idle handles after the timeout', async () => {
    const pool = new FileHandlePool({ idleMs: 30 });
    const p = file('d.txt', 'data');
    await pool.read(p, 0, 4);
    expect(pool.openCount).toBe(1);
    await sleep(80);
    expect(pool.openCount).toBe(0);
    // Reopens transparently.
    expect((await pool.read(p, 0, 4)).toString()).toBe('data');
    pool.dispose();
  });

  it('a released handle lets the file be deleted', async () => {
    const pool = new FileHandlePool({ idleMs: 10 });
    const p = file('e.txt', 'bye');
    await pool.read(p, 0, 3);
    pool.close(p);
    fs.unlinkSync(p);
    expect(fs.existsSync(p)).toBe(false);
    pool.dispose();
  });

  it('propagates open errors and recovers once the file exists', async () => {
    const pool = new FileHandlePool();
    const p = path.join(dir, 'missing.txt');
    await expect(pool.read(p, 0, 1)).rejects.toThrow(/ENOENT/);
    expect(pool.openCount).toBe(0);
    fs.writeFileSync(p, 'now');
    expect((await pool.read(p, 0, 3)).toString()).toBe('now');
    pool.dispose();
  });
});
