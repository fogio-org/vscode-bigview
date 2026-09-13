/** Messages between the extension host and worker threads. */

export interface IndexerWorkerData {
  filePath: string;
  /** Int32 flag; the worker stops between chunks once it becomes non-zero. */
  cancel: SharedArrayBuffer;
  chunkSize?: number;
}

export type IndexerMessage =
  | {
      type: 'progress';
      /** Line starts found since the previous message (transferred, not cloned). */
      starts: Float64Array;
      bytesIndexed: number;
      fileSize: number;
    }
  | { type: 'done'; starts: Float64Array; fileSize: number; elapsedMs: number }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; code?: string };
