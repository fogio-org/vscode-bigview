/**
 * Typed messages between the webview and the extension host (SPEC §3.6).
 * Never send large payloads in one message.
 */
import type { IndexSource } from './format';

/** Hard cap on lines in a single `lines` message. */
export const MAX_LINES_PER_MESSAGE = 500;

export type HostToWebview =
  | { type: 'init'; fileName: string; fileSize: number }
  | {
      type: 'index';
      /** Lines available for reading right now (grows while indexing). */
      lineCount: number;
      bytesIndexed: number;
      fileSize: number;
      done: boolean;
      source: IndexSource;
    }
  | {
      type: 'lines';
      reqId: number;
      start: number;
      lines: string[];
      /** Positions (relative to `start`) of lines truncated for display. */
      truncated: number[];
    }
  | { type: 'reveal'; /** 0-based */ line: number }
  | { type: 'error'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'getLines'; reqId: number; start: number; count: number }
  | { type: 'viewport'; topLine: number; visibleLines: number };
