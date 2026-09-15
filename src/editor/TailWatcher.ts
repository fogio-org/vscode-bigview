/**
 * Watches one file for tail -f (SPEC §6 M6): fs.watch for quick reaction plus a stat poll, because
 * fs.watch is unreliable across platforms and stops following a path when the file is renamed
 * (log rotation). Reports every change of size, inode or existence; deciding what the change
 * means is left to the document, which compares it with its index.
 */
import * as fs from 'node:fs';

export interface FileSnapshot {
  size: number;
  ino: number;
  mtimeMs: number;
}

export async function snapshotOf(filePath: string): Promise<FileSnapshot | undefined> {
  try {
    const st = await fs.promises.stat(filePath);
    return { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

const sameSnapshot = (a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.size === b.size && a.ino === b.ino && a.mtimeMs === b.mtimeMs);

/** Coalesces bursts of fs.watch events. */
const DEBOUNCE_MS = 30;

export class TailWatcher {
  private watcher: fs.FSWatcher | undefined;
  private readonly poll: NodeJS.Timeout;
  private debounce: NodeJS.Timeout | undefined;
  private last: FileSnapshot | undefined;
  private checking = false;
  private again = false;
  private disposed = false;

  constructor(
    private readonly filePath: string,
    private readonly onChange: (snapshot: FileSnapshot | undefined) => void,
    pollMs = 1000,
  ) {
    try {
      const st = fs.statSync(filePath);
      this.last = { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs };
    } catch {
      this.last = undefined;
    }
    this.watch();
    this.poll = setInterval(() => void this.check(), pollMs);
    this.poll.unref();
  }

  /** Compares the file with the last snapshot now. */
  async check(): Promise<void> {
    if (this.disposed) return;
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      const snap = await snapshotOf(this.filePath);
      if (this.disposed) return;
      if (!sameSnapshot(snap, this.last)) {
        this.last = snap;
        this.onChange(snap);
      }
      if (snap && !this.watcher) this.watch();
    } finally {
      this.checking = false;
      if (this.again) {
        this.again = false;
        void this.check();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    this.unwatch();
  }

  private watch(): void {
    if (this.disposed) return;
    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, (event) => {
        // A rename means the path may now be a different file: watch it afresh.
        if (event === 'rename') this.unwatch();
        this.schedule();
      });
      this.watcher.on('error', () => {
        this.unwatch();
        this.schedule();
      });
    } catch {
      this.watcher = undefined; // the file is missing; polling notices when it comes back
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private schedule(): void {
    if (this.disposed || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.check();
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }
}
