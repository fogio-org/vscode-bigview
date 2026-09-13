/**
 * Builds the sparse line index in a worker thread (SPEC §3.2, §3.3).
 * Streams anchors to the host so the first page can render immediately.
 */
import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { estimateLineCount, LineStartScanner, MAX_ANCHORS, strideForEstimate } from '../core/LineIndex';
import type { IndexerMessage, IndexerWorkerData } from './types';

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
/** Flush earlier than the interval once this many anchors are buffered (bounds worker memory). */
const MAX_PENDING_ANCHORS = 1 << 18;

function post(msg: IndexerMessage): void {
  const transfer = 'anchors' in msg ? [msg.anchors.buffer as ArrayBuffer] : [];
  parentPort?.postMessage(msg, transfer);
}

function run(data: IndexerWorkerData): void {
  const started = performance.now();
  const cancel = new Int32Array(data.cancel);
  const maxAnchors = data.maxAnchors ?? MAX_ANCHORS;
  let fd: number | undefined;
  try {
    fd = fs.openSync(data.filePath, 'r');
    // Index what exists at open time; growth is handled by tail (M6).
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(data.chunkSize ?? DEFAULT_CHUNK, fileSize)));
    const scanner = new LineStartScanner({ maxAnchors, initialCapacity: 1 << 16 });
    let pos = 0;
    let lastByte = -1;
    let lastPost = -Infinity;

    while (pos < fileSize) {
      if (Atomics.load(cancel, 0) !== 0) {
        post({ type: 'cancelled' });
        return;
      }
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, fileSize - pos), pos);
      if (n === 0) break; // file shrank underneath us
      const chunk = buf.subarray(0, n);
      if (pos === 0) scanner.setStride(strideForEstimate(estimateLineCount(chunk, fileSize), maxAnchors));
      scanner.scan(chunk);
      pos += n;
      lastByte = chunk[n - 1] as number;
      const now = performance.now();
      if (pos < fileSize && (now - lastPost >= PROGRESS_INTERVAL_MS || scanner.pending >= MAX_PENDING_ANCHORS)) {
        const anchors = scanner.take();
        post({ type: 'progress', anchors, stride: scanner.stride, linesStarted: scanner.linesStarted, bytesIndexed: pos, fileSize });
        lastPost = now;
      }
    }
    const anchors = scanner.take();
    post({
      type: 'done',
      anchors,
      stride: scanner.stride,
      linesStarted: scanner.linesStarted,
      // A trailing newline "starts" a line at EOF that does not exist.
      lineCount: lastByte === 0x0a ? scanner.linesStarted - 1 : scanner.linesStarted,
      fileSize: pos,
      mtimeMs: stat.mtimeMs,
      elapsedMs: performance.now() - started,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    post({ type: 'error', message: e.message ?? String(err), code: e.code });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

run(workerData as IndexerWorkerData);
