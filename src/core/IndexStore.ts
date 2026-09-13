/**
 * On-disk sidecar cache of line indexes (SPEC §3.4).
 *
 * Path: <dir>/<sha256(absPath)>.idx. Format, little-endian:
 *   magic u32 "BGV1" | version u32 | fileSize f64 | mtimeMs f64 | stride u32 | count u32 | offsets f64[count]
 * Invalidated by fileSize/mtimeMs mismatch; corrupt files are deleted.
 * The sidecar's own mtime is bumped on every hit and drives LRU cleanup.
 */
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { countLinesToEnd } from './ChunkReader';
import type { FileHandlePool } from './FileHandlePool';
import { LineIndex, MAX_ANCHORS } from './LineIndex';

export const INDEX_MAGIC = 0x42475631;
export const INDEX_VERSION = 1;
export const HEADER_BYTES = 32;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

export interface StoredIndex {
  fileSize: number;
  mtimeMs: number;
  stride: number;
  anchors: Float64Array;
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface IndexStoreOptions {
  /** Delete sidecars not used for this long. Default 30 days. */
  maxAgeMs?: number;
  /** Keep the cache under this size (least recently used go first). Default 500 MB. */
  maxTotalBytes?: number;
}

export interface CleanupResult {
  deleted: number;
  totalBytes: number;
}

const BIG_ENDIAN = os.endianness() === 'BE';

export class IndexStore {
  private readonly maxAgeMs: number;
  private readonly maxTotalBytes: number;

  constructor(
    readonly dir: string,
    opts: IndexStoreOptions = {},
  ) {
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 500 * 1024 * 1024;
  }

  pathFor(filePath: string): string {
    return path.join(this.dir, `${crypto.createHash('sha256').update(filePath).digest('hex')}.idx`);
  }

  /** Returns the cached index if it matches `stamp`; invalid sidecars are removed. */
  async load(filePath: string, stamp: FileStamp): Promise<StoredIndex | undefined> {
    const p = this.pathFor(filePath);
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(p, 'r');
    } catch {
      return undefined;
    }
    let stored: StoredIndex | undefined;
    try {
      stored = await readSidecar(fh, stamp);
    } catch {
      stored = undefined;
    } finally {
      await fh.close();
    }
    if (!stored) {
      await this.remove(filePath);
      return undefined;
    }
    const now = new Date();
    await fsp.utimes(p, now, now).catch(() => undefined);
    return stored;
  }

  /** Atomically writes the sidecar (temp file + rename). */
  async save(filePath: string, index: StoredIndex): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const p = this.pathFor(filePath);
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(INDEX_MAGIC, 0);
    header.writeUInt32LE(INDEX_VERSION, 4);
    header.writeDoubleLE(index.fileSize, 8);
    header.writeDoubleLE(index.mtimeMs, 16);
    header.writeUInt32LE(index.stride, 24);
    header.writeUInt32LE(index.anchors.length, 28);
    const body = Buffer.from(index.anchors.buffer, index.anchors.byteOffset, index.anchors.byteLength);
    try {
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.write(header, 0, header.length, 0);
        await fh.write(BIG_ENDIAN ? swap64(body) : body, 0, body.length, HEADER_BYTES);
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, p);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async remove(filePath: string): Promise<void> {
    await fsp.unlink(this.pathFor(filePath)).catch(() => undefined);
  }

  /** Deletes sidecars unused for maxAgeMs, then least recently used ones above maxTotalBytes. */
  async cleanup(now = Date.now()): Promise<CleanupResult> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return { deleted: 0, totalBytes: 0 };
    }
    let deleted = 0;
    const live: Array<{ file: string; size: number; used: number }> = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const st = await fsp.stat(file).catch(() => undefined);
      if (!st?.isFile()) continue;
      const maxAge = name.endsWith('.tmp') ? TMP_MAX_AGE_MS : this.maxAgeMs;
      if (now - st.mtimeMs > maxAge) {
        if (await unlinkOk(file)) deleted++;
      } else if (name.endsWith('.idx')) {
        live.push({ file, size: st.size, used: st.mtimeMs });
      }
    }
    live.sort((a, b) => b.used - a.used);
    let total = 0;
    for (const entry of live) {
      if (total + entry.size > this.maxTotalBytes) {
        if (await unlinkOk(entry.file)) deleted++;
      } else {
        total += entry.size;
      }
    }
    return { deleted, totalBytes: total };
  }
}

/**
 * Loads a cached index and rebuilds a complete LineIndex from it. The sidecar has no line
 * count, so it is recovered by counting lines after the last anchor (at most `stride` lines);
 * an inconsistent tail means the sidecar does not describe this file and it is discarded.
 */
export async function restoreLineIndex(
  store: IndexStore,
  pool: FileHandlePool,
  filePath: string,
  stamp: FileStamp,
): Promise<LineIndex | undefined> {
  const stored = await store.load(filePath, stamp).catch(() => undefined);
  if (!stored) return undefined;
  const { anchors, stride, fileSize } = stored;
  let lineCount = 0;
  if (anchors.length > 0) {
    const tail = await countLinesToEnd(pool, filePath, anchors[anchors.length - 1] as number, fileSize).catch(() => -1);
    if (tail < 1 || tail > stride) {
      await store.remove(filePath);
      return undefined;
    }
    lineCount = (anchors.length - 1) * stride + tail;
  }
  return LineIndex.fromAnchors(anchors, stride, lineCount, fileSize);
}

async function readSidecar(fh: fsp.FileHandle, stamp: FileStamp): Promise<StoredIndex | undefined> {
  const { size } = await fh.stat();
  if (size < HEADER_BYTES) return undefined;
  const header = Buffer.alloc(HEADER_BYTES);
  if ((await readFully(fh, header, 0)) < HEADER_BYTES) return undefined;

  const fileSize = header.readDoubleLE(8);
  const mtimeMs = header.readDoubleLE(16);
  const stride = header.readUInt32LE(24);
  const count = header.readUInt32LE(28);
  if (
    header.readUInt32LE(0) !== INDEX_MAGIC ||
    header.readUInt32LE(4) !== INDEX_VERSION ||
    fileSize !== stamp.size ||
    mtimeMs !== stamp.mtimeMs ||
    stride < 1 ||
    count > MAX_ANCHORS ||
    size !== HEADER_BYTES + count * 8
  ) {
    return undefined;
  }

  const anchors = new Float64Array(count);
  const body = Buffer.from(anchors.buffer);
  if ((await readFully(fh, body, HEADER_BYTES)) < body.length) return undefined;
  if (BIG_ENDIAN) swap64(body);

  if (count === 0) return fileSize === 0 ? { fileSize, mtimeMs, stride, anchors } : undefined;
  if (anchors[0] !== 0 || (anchors[count - 1] as number) >= fileSize) return undefined;
  for (let i = 1; i < count; i++) {
    const a = anchors[i] as number;
    if (!(a > (anchors[i - 1] as number)) || !Number.isInteger(a)) return undefined;
  }
  return { fileSize, mtimeMs, stride, anchors };
}

async function readFully(fh: fsp.FileHandle, buf: Buffer, position: number): Promise<number> {
  let total = 0;
  while (total < buf.length) {
    const { bytesRead } = await fh.read(buf, total, buf.length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

/** In-place byte swap of 8-byte words (big-endian hosts only). */
function swap64(buf: Buffer): Buffer {
  return buf.swap64();
}

async function unlinkOk(file: string): Promise<boolean> {
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}
