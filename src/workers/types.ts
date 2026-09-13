/** Messages between the extension host and worker threads. */

export interface IndexerWorkerData {
  filePath: string;
  /** Int32 flag; the worker stops between chunks once it becomes non-zero. */
  cancel: SharedArrayBuffer;
  chunkSize?: number;
  /** Anchor budget (tests use tiny values to exercise stride doubling). */
  maxAnchors?: number;
}

export type IndexerMessage =
  | {
      type: 'progress';
      /** Anchors found since the previous message (transferred, not cloned). */
      anchors: Float64Array;
      stride: number;
      linesStarted: number;
      bytesIndexed: number;
      fileSize: number;
    }
  | {
      type: 'done';
      anchors: Float64Array;
      stride: number;
      linesStarted: number;
      lineCount: number;
      fileSize: number;
      /** mtime at the start of indexing; the host compares it before persisting. */
      mtimeMs: number;
      elapsedMs: number;
    }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; code?: string };
