import * as path from 'node:path';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { LineIndex } from '../core/LineIndex';
import type { SearchQuery } from '../shared/searchQuery';
import type { IndexerMessage, IndexerWorkerData, SearchMessage, SearchRequest, SearchWorkerData } from './types';

export type IndexOutcome =
  | { status: 'done'; fileSize: number; mtimeMs: number; elapsedMs: number }
  | { status: 'cancelled' };

export interface IndexerTask {
  readonly result: Promise<IndexOutcome>;
  cancel(): void;
}

export interface IndexerOptions {
  chunkSize?: number;
  maxAnchors?: number;
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
  private readonly searchWorkers = new Set<SearchWorker>();

  constructor(private readonly distDir: string) {}

  /**
   * Indexes `filePath` in a worker, appending anchors to `index` as they arrive.
   * `onProgress` is called after every update with the file size seen by the worker.
   */
  index(filePath: string, index: LineIndex, onProgress: (fileSize: number) => void, opts: IndexerOptions = {}): IndexerTask {
    const cancelBuf = new SharedArrayBuffer(4);
    const cancelFlag = new Int32Array(cancelBuf);
    const workerData: IndexerWorkerData = { filePath, cancel: cancelBuf, ...opts };
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
        try {
          switch (msg.type) {
            case 'progress':
              index.append(msg.anchors, msg);
              onProgress(msg.fileSize);
              break;
            case 'done':
              index.append(msg.anchors, { stride: msg.stride, linesStarted: msg.linesStarted, bytesIndexed: msg.fileSize });
              index.complete(msg.fileSize, msg.lineCount);
              finish(() => resolve({ status: 'done', fileSize: msg.fileSize, mtimeMs: msg.mtimeMs, elapsedMs: msg.elapsedMs }));
              onProgress(msg.fileSize);
              break;
            case 'cancelled':
              finish(() => resolve({ status: 'cancelled' }));
              break;
            case 'error':
              finish(() => reject(new IndexerError(msg.message, msg.code)));
              break;
          }
        } catch (err) {
          finish(() => reject(err));
          void worker.terminate();
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

  createSearchWorker(opts: SearchWorkerOptions = {}): SearchWorker {
    const worker = new SearchWorker(path.join(this.distDir, 'search.worker.js'), opts, () => this.searchWorkers.delete(worker));
    this.searchWorkers.add(worker);
    return worker;
  }

  dispose(): void {
    for (const task of [...this.active]) task.cancel();
    for (const worker of [...this.searchWorkers]) worker.dispose();
  }
}

export type SearchOutcome =
  | { status: 'done'; bytesSearched: number; fileSize: number; elapsedMs: number }
  | { status: 'cancelled' };

export interface SearchCallbacks {
  /** New matching lines (ascending) and progress. Also called with the final batch. */
  onProgress(lines: Float64Array, bytesSearched: number, fileSize: number): void;
}

export interface SearchTask {
  readonly id: number;
  readonly result: Promise<SearchOutcome>;
  cancel(): void;
}

export interface SearchWorkerOptions {
  /** A cancelled search must acknowledge within this time, or the worker is replaced. */
  hangMs?: number;
  /** Terminate the idle worker thread after this long. */
  idleMs?: number;
  chunkBytes?: number;
  overlapBytes?: number;
  progressBytes?: number;
  /** V8 heap limits of the worker thread; defaults to SEARCH_WORKER_LIMITS. */
  resourceLimits?: ResourceLimits;
}

/**
 * Without a limit V8 lets the worker heap grow lazily: a regex search over 1 GB peaked at
 * +155 MB RSS of collectable strings. Measured on 1 GB: 64/8 MB → +90 MB, 32/4 MB → +55 MB
 * (~5% slower). Decoded pieces are ~1 MB; a long-line window decodes to at most 16 MB.
 */
export const SEARCH_WORKER_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 };

export class SearchError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

interface RunningSearch {
  request: SearchRequest;
  callbacks: SearchCallbacks;
  resolve(outcome: SearchOutcome): void;
  reject(err: unknown): void;
}

/**
 * One long-lived search worker thread. A new search cancels the running one through the shared
 * generation id, which the worker checks between chunks (SPEC §7.8: no terminate per
 * keystroke). Only a search that does not acknowledge the cancel in time (e.g. a regex stuck
 * in catastrophic backtracking) gets the thread terminated and replaced.
 */
export class SearchWorker {
  private worker: Worker | undefined;
  private readonly generation = new Int32Array(new SharedArrayBuffer(4));
  private nextId = 1;
  private current: RunningSearch | undefined;
  private readonly unacked = new Map<number, NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | undefined;
  private restartCount = 0;
  private disposed = false;
  private readonly hangMs: number;
  private readonly idleMs: number;

  constructor(
    private readonly script: string,
    private readonly opts: SearchWorkerOptions = {},
    private readonly onDispose: () => void = () => undefined,
  ) {
    this.hangMs = opts.hangMs ?? 2000;
    this.idleMs = opts.idleMs ?? 60_000;
  }

  /** Times a stuck worker was terminated and replaced. */
  get restarts(): number {
    return this.restartCount;
  }

  get alive(): boolean {
    return this.worker !== undefined;
  }

  search(filePath: string, query: SearchQuery, callbacks: SearchCallbacks): SearchTask {
    if (this.disposed) throw new Error('SearchWorker is disposed');
    this.cancelCurrent();
    const id = this.nextId++;
    Atomics.store(this.generation, 0, id);
    let resolve!: (o: SearchOutcome) => void;
    let reject!: (err: unknown) => void;
    const result = new Promise<SearchOutcome>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const run: RunningSearch = {
      request: {
        type: 'search',
        id,
        filePath,
        query,
        chunkBytes: this.opts.chunkBytes,
        overlapBytes: this.opts.overlapBytes,
        progressBytes: this.opts.progressBytes,
      },
      callbacks,
      resolve,
      reject,
    };
    this.current = run;
    this.clearIdle();
    this.ensureWorker().postMessage(run.request);
    return {
      id,
      result,
      cancel: () => {
        if (this.current === run) this.cancelCurrent();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelCurrent();
    this.disposed = true;
    this.clearIdle();
    this.clearUnacked();
    this.terminate();
    this.onDispose();
  }

  private cancelCurrent(): void {
    const run = this.current;
    if (!run) return;
    this.current = undefined;
    Atomics.store(this.generation, 0, 0);
    run.resolve({ status: 'cancelled' });
    const timer = setTimeout(() => this.restartWorker(), this.hangMs);
    timer.unref();
    this.unacked.set(run.request.id, timer);
    this.scheduleIdle();
  }

  private onMessage(msg: SearchMessage): void {
    if (msg.type !== 'progress') {
      const timer = this.unacked.get(msg.id);
      if (timer) {
        clearTimeout(timer);
        this.unacked.delete(msg.id);
      }
    }
    const run = this.current;
    if (!run || run.request.id !== msg.id) return;
    switch (msg.type) {
      case 'progress':
        run.callbacks.onProgress(msg.lines, msg.bytesSearched, msg.fileSize);
        break;
      case 'done':
        run.callbacks.onProgress(msg.lines, msg.bytesSearched, msg.fileSize);
        this.current = undefined;
        run.resolve({ status: 'done', bytesSearched: msg.bytesSearched, fileSize: msg.fileSize, elapsedMs: msg.elapsedMs });
        this.scheduleIdle();
        break;
      case 'cancelled':
        this.current = undefined;
        run.resolve({ status: 'cancelled' });
        this.scheduleIdle();
        break;
      case 'error':
        this.current = undefined;
        run.reject(new SearchError(msg.message, msg.code));
        this.scheduleIdle();
        break;
    }
  }

  private restartWorker(): void {
    if (this.disposed) return;
    this.restartCount++;
    this.clearUnacked();
    this.terminate();
    if (this.current) this.ensureWorker().postMessage(this.current.request);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerData: SearchWorkerData = { generation: this.generation.buffer as SharedArrayBuffer };
    const w = new Worker(this.script, { workerData, resourceLimits: this.opts.resourceLimits ?? SEARCH_WORKER_LIMITS });
    w.on('message', (msg: SearchMessage) => {
      if (this.worker === w) this.onMessage(msg);
    });
    w.on('error', (err) => this.onCrash(w, err));
    w.on('exit', (code) => this.onCrash(w, new SearchError(`Search worker exited unexpectedly (code ${code})`)));
    this.worker = w;
    return w;
  }

  private onCrash(w: Worker, err: unknown): void {
    if (this.worker !== w) return;
    this.worker = undefined;
    this.clearUnacked();
    const run = this.current;
    this.current = undefined;
    run?.reject(err);
  }

  private terminate(): void {
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.disposed) return;
    this.idleTimer = setTimeout(() => {
      if (!this.current && this.unacked.size === 0) this.terminate();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearUnacked(): void {
    for (const t of this.unacked.values()) clearTimeout(t);
    this.unacked.clear();
  }
}
