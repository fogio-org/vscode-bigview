import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LineIndex } from '../core/LineIndex';
import type { IndexerMessage, IndexerWorkerData } from './types';

export type IndexOutcome =
  | { status: 'done'; fileSize: number; elapsedMs: number }
  | { status: 'cancelled' };

export interface IndexerTask {
  readonly result: Promise<IndexOutcome>;
  cancel(): void;
}

export class IndexerError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Grace period for a cooperative cancel before the worker is terminated. */
const CANCEL_GRACE_MS = 2000;

/** Spawns and tracks worker threads. */
export class WorkerPool {
  private readonly active = new Set<IndexerTask>();

  constructor(private readonly distDir: string) {}

  /**
   * Indexes `filePath` in a worker, appending line starts to `index` as they arrive.
   * `onProgress` is called after every update with the file size seen by the worker.
   */
  index(filePath: string, index: LineIndex, onProgress: (fileSize: number) => void): IndexerTask {
    const cancelBuf = new SharedArrayBuffer(4);
    const cancelFlag = new Int32Array(cancelBuf);
    const workerData: IndexerWorkerData = { filePath, cancel: cancelBuf };
    const worker = new Worker(path.join(this.distDir, 'indexer.worker.js'), { workerData });

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const result = new Promise<IndexOutcome>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        this.active.delete(task);
        fn();
      };

      worker.on('message', (msg: IndexerMessage) => {
        if (settled) return;
        switch (msg.type) {
          case 'progress':
            index.append(msg.starts, msg.bytesIndexed);
            onProgress(msg.fileSize);
            break;
          case 'done':
            index.append(msg.starts, msg.fileSize);
            index.complete(msg.fileSize);
            finish(() => resolve({ status: 'done', fileSize: msg.fileSize, elapsedMs: msg.elapsedMs }));
            onProgress(msg.fileSize);
            break;
          case 'cancelled':
            finish(() => resolve({ status: 'cancelled' }));
            break;
          case 'error':
            finish(() => reject(new IndexerError(msg.message, msg.code)));
            break;
        }
      });
      worker.on('error', (err) => finish(() => reject(err)));
      worker.on('exit', (code) =>
        finish(() =>
          Atomics.load(cancelFlag, 0) !== 0
            ? resolve({ status: 'cancelled' })
            : reject(new IndexerError(`Indexer exited unexpectedly (code ${code})`)),
        ),
      );
    });

    const task: IndexerTask = {
      result,
      cancel: () => {
        if (settled) return;
        Atomics.store(cancelFlag, 0, 1);
        killTimer = setTimeout(() => void worker.terminate(), CANCEL_GRACE_MS);
        killTimer.unref();
      },
    };
    this.active.add(task);
    return task;
  }

  dispose(): void {
    for (const task of [...this.active]) task.cancel();
  }
}
