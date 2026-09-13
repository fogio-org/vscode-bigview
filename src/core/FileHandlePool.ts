import * as fsp from 'node:fs/promises';

interface Entry {
  handle: Promise<fsp.FileHandle>;
  refs: number;
  timer: NodeJS.Timeout | undefined;
}

export interface FileHandlePoolOptions {
  /** Max idle handles kept open. Busy handles are never evicted. */
  maxOpen?: number;
  /** Close a handle after this many ms without use (SPEC §7.5). */
  idleMs?: number;
}

/**
 * Pool of read-only file descriptors with LRU eviction and idle timeout, so files are
 * never held open forever (Windows would refuse to delete them).
 */
export class FileHandlePool {
  private readonly entries = new Map<string, Entry>();
  private readonly maxOpen: number;
  private readonly idleMs: number;

  constructor(opts: FileHandlePoolOptions = {}) {
    this.maxOpen = opts.maxOpen ?? 8;
    this.idleMs = opts.idleMs ?? 10_000;
  }

  get openCount(): number {
    return this.entries.size;
  }

  /** Reads up to `length` bytes at `position`. Result is shorter only at EOF. */
  async read(filePath: string, position: number, length: number): Promise<Buffer> {
    const entry = this.acquire(filePath);
    try {
      const fh = await entry.handle;
      const buf = Buffer.allocUnsafe(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await fh.read(buf, total, length - total, position + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return total === length ? buf : buf.subarray(0, total);
    } catch (err) {
      // A failed open must not poison the pool: drop the entry so the next call retries.
      if (this.entries.get(filePath) === entry) this.entries.delete(filePath);
      throw err;
    } finally {
      this.release(filePath, entry);
    }
  }

  /** Closes the handle for `filePath` (immediately if idle, otherwise after the current reads). */
  close(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    this.entries.delete(filePath);
    if (entry.refs === 0) this.closeEntry(entry);
  }

  dispose(): void {
    for (const p of [...this.entries.keys()]) this.close(p);
  }

  private acquire(filePath: string): Entry {
    let entry = this.entries.get(filePath);
    if (entry) {
      this.entries.delete(filePath); // re-insert to mark as most recently used
    } else {
      entry = { handle: fsp.open(filePath, 'r'), refs: 0, timer: undefined };
      // Avoid unhandled rejection if the entry is evicted before anyone awaits it.
      entry.handle.catch(() => undefined);
    }
    this.entries.set(filePath, entry);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.refs++;
    this.evict();
    return entry;
  }

  private release(filePath: string, entry: Entry): void {
    entry.refs--;
    if (entry.refs > 0) return;
    if (this.entries.get(filePath) !== entry) {
      this.closeEntry(entry); // was closed or dropped while busy
      return;
    }
    entry.timer = setTimeout(() => {
      if (this.entries.get(filePath) === entry && entry.refs === 0) this.close(filePath);
    }, this.idleMs);
    entry.timer.unref();
  }

  private evict(): void {
    if (this.entries.size <= this.maxOpen) return;
    for (const [p, e] of this.entries) {
      if (this.entries.size <= this.maxOpen) break;
      if (e.refs === 0) this.close(p);
    }
  }

  private closeEntry(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.handle.then((h) => h.close()).catch(() => undefined);
  }
}
