/**
 * Builds the line index in a worker thread (SPEC §3.2, §3.3).
 * Streams newly found line starts to the host so the first page can render immediately.
 */
import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { LineStartScanner } from '../core/LineIndex';
import type { IndexerMessage, IndexerWorkerData } from './types';

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
/** Flush earlier than the interval once this many starts are buffered (bounds worker memory). */
const MAX_PENDING_STARTS = 1 << 18;

function post(msg: IndexerMessage): void {
  const transfer = 'starts' in msg ? [msg.starts.buffer as ArrayBuffer] : [];
  parentPort?.postMessage(msg, transfer);
}

function run(data: IndexerWorkerData): void {
  const started = performance.now();
  const cancel = new Int32Array(data.cancel);
  let fd: number | undefined;
  try {
    fd = fs.openSync(data.filePath, 'r');
    // Index what exists at open time; growth is handled by tail (M6).
    const fileSize = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(data.chunkSize ?? DEFAULT_CHUNK, fileSize)));
    const scanner = new LineStartScanner(1 << 18);
    let pos = 0;
    let lastPost = -Infinity;

    while (pos < fileSize) {
      if (Atomics.load(cancel, 0) !== 0) {
        post({ type: 'cancelled' });
        return;
      }
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, fileSize - pos), pos);
      if (n === 0) break; // file shrank underneath us
      scanner.scan(buf.subarray(0, n));
      pos += n;
      const now = performance.now();
      if (pos < fileSize && (now - lastPost >= PROGRESS_INTERVAL_MS || scanner.pending >= MAX_PENDING_STARTS)) {
        post({ type: 'progress', starts: scanner.take(), bytesIndexed: pos, fileSize });
        lastPost = now;
      }
    }
    post({ type: 'done', starts: scanner.take(), fileSize: pos, elapsedMs: performance.now() - started });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    post({ type: 'error', message: e.message ?? String(err), code: e.code });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

run(workerData as IndexerWorkerData);
