/**
 * Export worker: copies the lines selected by a bitset into a new file (SPEC §6 M4).
 * A cancelled or failed export removes the partial output.
 */
import * as fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { bitsetSelector, copyLines } from '../core/exportLines';
import type { ExportMessage, ExportWorkerData } from './types';

function post(msg: ExportMessage): void {
  parentPort?.postMessage(msg);
}

function run(data: ExportWorkerData): void {
  const started = performance.now();
  const cancel = new Int32Array(data.cancel);
  let input: number | undefined;
  let output: number | undefined;
  let created = false;
  const removeOutput = (): void => {
    if (output !== undefined) fs.closeSync(output);
    output = undefined;
    if (created) fs.rmSync(data.target, { force: true });
  };
  try {
    input = fs.openSync(data.source, 'r');
    const inFd = input;
    const fileSize = fs.fstatSync(inFd).size;
    output = fs.openSync(data.target, 'w');
    created = true;
    const outFd = output;

    const summary = copyLines(
      (buf, offset, length, position) => fs.readSync(inFd, buf, offset, length, position),
      (bytes) => {
        for (let off = 0; off < bytes.length; ) off += fs.writeSync(outFd, bytes, off, bytes.length - off);
      },
      fileSize,
      bitsetSelector(data.words, data.invert, data.lineCount),
      {
        progress: (bytesRead, linesWritten) => post({ type: 'progress', bytesRead, fileSize, linesWritten }),
        isCancelled: () => Atomics.load(cancel, 0) !== 0,
      },
      data,
    );

    if (summary.status === 'cancelled') {
      removeOutput();
      post({ type: 'cancelled' });
      return;
    }
    fs.closeSync(outFd);
    output = undefined;
    post({
      type: 'done',
      linesWritten: summary.linesWritten,
      bytesWritten: summary.bytesWritten,
      elapsedMs: performance.now() - started,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    try {
      removeOutput();
    } catch {
      // keep the original error
    }
    post({ type: 'error', message: e.message ?? String(err), code: e.code });
  } finally {
    if (input !== undefined) fs.closeSync(input);
  }
}

run(workerData as ExportWorkerData);
