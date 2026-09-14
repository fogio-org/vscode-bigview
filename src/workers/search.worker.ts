/**
 * Search worker (SPEC §3.8). Long-lived: requests are queued on the message port and run one at
 * a time; a request is cancelled when the host changes the shared generation id.
 */
import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { searchFile } from '../core/search';
import type { SearchMessage, SearchRequest, SearchWorkerData } from './types';

/** Hits are sent at least this often while a search is producing them. */
const HIT_FLUSH_MS = 100;
const MAX_PENDING_HITS = 1 << 16;

const generation = new Int32Array((workerData as SearchWorkerData).generation);

function post(msg: SearchMessage): void {
  const transfer = 'lines' in msg ? [msg.lines.buffer as ArrayBuffer] : [];
  parentPort?.postMessage(msg, transfer);
}

function run(req: SearchRequest): void {
  const cancelled = (): boolean => Atomics.load(generation, 0) !== req.id;
  if (cancelled()) {
    post({ type: 'cancelled', id: req.id });
    return;
  }
  const started = performance.now();
  let fd: number | undefined;
  try {
    fd = fs.openSync(req.filePath, 'r');
    const handle = fd;
    const fileSize = fs.fstatSync(fd).size;

    let pending = new Float64Array(1024);
    let count = 0;
    let lastFlush = performance.now();
    const take = (): Float64Array => {
      const out = pending.slice(0, count);
      count = 0;
      return out;
    };
    const flush = (bytesSearched: number): void => {
      post({ type: 'progress', id: req.id, lines: take(), bytesSearched, fileSize });
      lastFlush = performance.now();
    };

    let position = 0;
    const summary = searchFile(
      (buf, offset, length, pos) => fs.readSync(handle, buf, offset, length, pos),
      fileSize,
      req.query,
      {
        hit: (line) => {
          if (count === pending.length) {
            if (count >= MAX_PENDING_HITS) {
              flush(position);
            } else {
              const grown = new Float64Array(pending.length * 2);
              grown.set(pending);
              pending = grown;
            }
          }
          pending[count++] = line;
        },
        progress: (bytes) => {
          position = bytes;
          flush(bytes);
        },
        isCancelled: (bytes) => {
          position = bytes;
          if (count > 0 && performance.now() - lastFlush >= HIT_FLUSH_MS) flush(bytes);
          return cancelled();
        },
      },
      req,
    );

    if (summary.status === 'cancelled') {
      post({ type: 'cancelled', id: req.id });
      return;
    }
    post({
      type: 'done',
      id: req.id,
      lines: take(),
      bytesSearched: summary.bytesSearched,
      fileSize,
      elapsedMs: performance.now() - started,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    post({ type: 'error', id: req.id, message: e.message ?? String(err), code: e.code });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

parentPort?.on('message', (msg: SearchRequest) => run(msg));
