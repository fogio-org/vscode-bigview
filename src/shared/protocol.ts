/**
 * Typed messages between the webview and the extension host (SPEC §3.6).
 * Never send large payloads in one message.
 */
import type { IndexSource } from './format';
import type { Range, SearchQuery } from './searchQuery';

/** Hard cap on lines in a single `lines` message. */
export const MAX_LINES_PER_MESSAGE = 500;
/** Hard cap on search results in a single `results` message. */
export const MAX_RESULTS_PER_MESSAGE = 200;

export type SearchStatus = 'idle' | 'running' | 'done' | 'error';

export interface SearchResultItem {
  /** 0-based line number. */
  line: number;
  /** Excerpt of the line around the first match. */
  text: string;
  ranges: Range[];
  cutStart: boolean;
  cutEnd: boolean;
}

export type HitTarget =
  /** A stored hit by position (wraps around). */
  | { index: number }
  /** The first hit on/after (direction 1) or before (direction -1) a line (wraps around). */
  | { fromLine: number; direction: 1 | -1 };

export type WebviewCommand = 'find' | 'findNext' | 'findPrevious';

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
  | { type: 'error'; message: string }
  | {
      /** Sent at most every 100 ms while a search runs, and once when it ends. */
      type: 'searchState';
      searchId: number;
      status: SearchStatus;
      /** All matching lines found so far. */
      total: number;
      /** Matching lines available for listing (capped). */
      stored: number;
      bytesSearched: number;
      fileSize: number;
      elapsedMs?: number;
      error?: string;
    }
  | { type: 'results'; searchId: number; reqId: number; start: number; items: SearchResultItem[] }
  | { type: 'hit'; searchId: number; index: number; line: number }
  | { type: 'command'; command: WebviewCommand }
  /** Puts a query into the search bar and runs it, as if typed. */
  | { type: 'setQuery'; query: SearchQuery };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'getLines'; reqId: number; start: number; count: number }
  | { type: 'viewport'; topLine: number; visibleLines: number }
  /** Starts a search, cancelling the previous one; an empty text clears the search. */
  | { type: 'search'; searchId: number; query: SearchQuery }
  | { type: 'getResults'; searchId: number; reqId: number; start: number; count: number }
  | { type: 'gotoHit'; searchId: number; target: HitTarget };
