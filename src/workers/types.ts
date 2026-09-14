/** Messages between the extension host and worker threads. */
import type { SearchQuery } from '../shared/searchQuery';

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

export interface SearchWorkerData {
  /**
   * Int32 holding the id of the search that may run. The host stores a new id (or 0) to cancel
   * the running search; the worker compares it between chunks.
   */
  generation: SharedArrayBuffer;
}

export interface SearchRequest {
  type: 'search';
  id: number;
  filePath: string;
  query: SearchQuery;
  chunkBytes?: number;
  overlapBytes?: number;
  progressBytes?: number;
}

export type SearchMessage =
  | {
      type: 'progress';
      id: number;
      /** Matching line numbers since the previous message (transferred). */
      lines: Float64Array;
      bytesSearched: number;
      fileSize: number;
    }
  | { type: 'done'; id: number; lines: Float64Array; bytesSearched: number; fileSize: number; elapsedMs: number }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string; code?: string };
