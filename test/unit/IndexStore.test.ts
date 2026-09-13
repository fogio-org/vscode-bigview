import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { HEADER_BYTES, INDEX_MAGIC, IndexStore, restoreLineIndex, type StoredIndex } from '../../src/core/IndexStore';
import { buildIndex, enc, naiveText, tmpDir } from './helpers';

const dir = tmpDir('store');
const cacheDir = path.join(dir, 'cache');
const pool = new FileHandlePool({ idleMs: 50 });
afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

const FILE = '/data/logs/app.log';
const stamp = { size: 1000, mtimeMs: 1_726_000_000_123.456 };
const sample = (): StoredIndex => ({
  fileSize: stamp.size,
  mtimeMs: stamp.mtimeMs,
  stride: 3,
  anchors: Float64Array.from([0, 120, 240, 999]),
});
const DAY = 24 * 60 * 60 * 1000;

describe('IndexStore', () => {
  it('round-trips the SPEC binary format', async () => {
    const store = new IndexStore(cacheDir);
    await store.save(FILE, sample());
    const file = store.pathFor(FILE);
    const raw = fs.readFileSync(file);
    expect(raw.length).toBe(HEADER_BYTES + 4 * 8);
    expect(raw.readUInt32LE(0)).toBe(INDEX_MAGIC);
    expect(raw.subarray(0, 4).toString('latin1')).toBe('1VGB'); // 0x42475631 little-endian
    expect(raw.readUInt32LE(4)).toBe(1);
    expect(raw.readDoubleLE(8)).toBe(stamp.size);
    expect(raw.readDoubleLE(16)).toBe(stamp.mtimeMs);
    expect(raw.readUInt32LE(24)).toBe(3);
    expect(raw.readUInt32LE(28)).toBe(4);
    expect(raw.readDoubleLE(32 + 8 * 3)).toBe(999);

    const loaded = await store.load(FILE, stamp);
    expect(loaded).toMatchObject({ fileSize: stamp.size, mtimeMs: stamp.mtimeMs, stride: 3 });
    expect(Array.from(loaded?.anchors ?? [])).toEqual([0, 120, 240, 999]);
    expect(fs.readdirSync(cacheDir)).toEqual([path.basename(file)]); // no temp files left
  });

  it('names sidecars by sha256 of the absolute path', () => {
    const store = new IndexStore(cacheDir);
    expect(path.basename(store.pathFor(FILE))).toMatch(/^[0-9a-f]{64}\.idx$/);
    expect(store.pathFor(FILE)).toBe(store.pathFor(FILE));
    expect(store.pathFor(FILE)).not.toBe(store.pathFor(`${FILE}.1`));
  });

  it('returns undefined when there is no sidecar', async () => {
    expect(await new IndexStore(cacheDir).load(FILE, stamp)).toBeUndefined();
  });

  const invalidations: Array<[string, (file: string) => void, typeof stamp]> = [
    ['file size changed', () => undefined, { ...stamp, size: 1001 }],
    ['mtime changed', () => undefined, { ...stamp, mtimeMs: stamp.mtimeMs + 1 }],
    ['corrupt magic', (f) => patch(f, 0, Buffer.from('XXXX')), stamp],
    ['unknown version', (f) => patchU32(f, 4, 2), stamp],
    ['truncated file', (f) => fs.truncateSync(f, HEADER_BYTES + 3 * 8), stamp],
    ['header only', (f) => fs.truncateSync(f, HEADER_BYTES), stamp],
    ['shorter than header', (f) => fs.truncateSync(f, 10), stamp],
    ['count larger than MAX_ANCHORS', (f) => patchU32(f, 28, 4_000_001), stamp],
    ['zero stride', (f) => patchU32(f, 24, 0), stamp],
    ['non-ascending anchors', (f) => patchF64(f, 32 + 16, 50), stamp],
    ['first anchor not zero', (f) => patchF64(f, 32, 1), stamp],
    ['anchor beyond EOF', (f) => patchF64(f, 32 + 24, 1000), stamp],
  ];
  for (const [name, corrupt, loadStamp] of invalidations) {
    it(`rejects and deletes the sidecar: ${name}`, async () => {
      const store = new IndexStore(cacheDir);
      await store.save(FILE, sample());
      corrupt(store.pathFor(FILE));
      expect(await store.load(FILE, loadStamp)).toBeUndefined();
      expect(fs.existsSync(store.pathFor(FILE))).toBe(false);
    });
  }

  it('accepts an empty index only for an empty file', async () => {
    const store = new IndexStore(cacheDir);
    const empty = { fileSize: 0, mtimeMs: 5, stride: 1, anchors: new Float64Array(0) };
    await store.save(FILE, empty);
    expect((await store.load(FILE, { size: 0, mtimeMs: 5 }))?.anchors.length).toBe(0);
    await store.save(FILE, { ...empty, fileSize: 10 });
    expect(await store.load(FILE, { size: 10, mtimeMs: 5 })).toBeUndefined();
  });

  it('overwrites an existing sidecar atomically', async () => {
    const store = new IndexStore(cacheDir);
    await store.save(FILE, sample());
    await store.save(FILE, { ...sample(), stride: 5 });
    expect((await store.load(FILE, stamp))?.stride).toBe(5);
    expect(fs.readdirSync(cacheDir).length).toBe(1);
  });

  it('a hit refreshes the sidecar mtime (LRU clock)', async () => {
    const store = new IndexStore(cacheDir);
    await store.save(FILE, sample());
    const old = new Date(Date.now() - 10 * DAY);
    fs.utimesSync(store.pathFor(FILE), old, old);
    await store.load(FILE, stamp);
    expect(Date.now() - fs.statSync(store.pathFor(FILE)).mtimeMs).toBeLessThan(60_000);
  });

  it('cleanup removes stale sidecars and least recently used ones over the size cap', async () => {
    const entrySize = HEADER_BYTES + 4 * 8;
    const store = new IndexStore(cacheDir, { maxAgeMs: 30 * DAY, maxTotalBytes: entrySize * 2 });
    const now = Date.now();
    const age = async (name: string, days: number): Promise<string> => {
      await store.save(name, sample());
      const t = new Date(now - days * DAY);
      fs.utimesSync(store.pathFor(name), t, t);
      return store.pathFor(name);
    };
    const stale = await age('/stale', 40);
    const oldest = await age('/oldest', 3);
    const recent = await age('/recent', 1);
    const newest = await age('/newest', 0.5);
    const tmp = path.join(cacheDir, 'x.idx.123.tmp');
    fs.writeFileSync(tmp, 'partial');
    fs.utimesSync(tmp, new Date(now - DAY), new Date(now - DAY));

    const res = await store.cleanup(now);
    expect(res.deleted).toBe(3);
    expect(res.totalBytes).toBe(entrySize * 2);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it('cleanup of a missing directory is a no-op', async () => {
    expect(await new IndexStore(path.join(dir, 'nope')).cleanup()).toEqual({ deleted: 0, totalBytes: 0 });
  });
});

describe('restoreLineIndex', () => {
  function setup(text: string, stride: number): { file: string; data: Uint8Array; st: fs.Stats; store: IndexStore } {
    const file = path.join(dir, `restore-${stride}-${text.length}.log`);
    const data = enc(text);
    fs.writeFileSync(file, data);
    return { file, data, st: fs.statSync(file), store: new IndexStore(cacheDir) };
  }

  for (const [text, stride] of [
    ['a\nbb\nccc\ndddd\n', 2],
    ['a\nbb\nccc\ndddd', 2],
    ['a\nbb\nccc\ndddd\ne\nf\n', 3],
    ['single', 4],
    ['', 1],
  ] as const) {
    it(`recovers line count and content (stride ${stride}, ${JSON.stringify(text.slice(-2))})`, async () => {
      const { file, data, st, store } = setup(text, stride);
      const built = buildIndex(data, { stride });
      await store.save(file, { fileSize: st.size, mtimeMs: st.mtimeMs, stride, anchors: built.toFloat64Array() });
      const restored = await restoreLineIndex(store, pool, file, st);
      expect(restored?.isComplete).toBe(true);
      expect(restored?.lineCount).toBe(naiveText(data).length);
      expect(Array.from(restored?.toFloat64Array() ?? [])).toEqual(Array.from(built.toFloat64Array()));
    });
  }

  it('discards a sidecar whose tail does not match the file', async () => {
    const { file, data, store } = setup('a\nb\nc\nd\ne\nf\n', 2);
    const built = buildIndex(data, { stride: 2 });
    // Different content of the same size: 4 lines after the last anchor (offset 8) instead of 2.
    const replaced = 'a\nb\nc\nd\n\n\n\n\n'.slice(0, data.length);
    expect(replaced.length).toBe(data.length);
    fs.writeFileSync(file, replaced);
    const fresh = fs.statSync(file);
    // Sidecar stamped with the current size/mtime, so only the tail check can reject it.
    await store.save(file, { fileSize: fresh.size, mtimeMs: fresh.mtimeMs, stride: 2, anchors: built.toFloat64Array() });
    expect(await store.load(file, fresh)).toBeDefined();
    expect(await restoreLineIndex(store, pool, file, fresh)).toBeUndefined();
    expect(fs.existsSync(store.pathFor(file))).toBe(false);
  });
});

function patch(file: string, offset: number, bytes: Buffer): void {
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, bytes, 0, bytes.length, offset);
  fs.closeSync(fd);
}
function patchU32(file: string, offset: number, v: number): void {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  patch(file, offset, b);
}
function patchF64(file: string, offset: number, v: number): void {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  patch(file, offset, b);
}
