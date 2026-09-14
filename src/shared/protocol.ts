/**
 * Typed messages between the webview and the extension host (SPEC §3.6).
 * Never send large payloads in one message.
 */
import type { IndexSource } from './format';
import type { FormatInfo, FormatKind } from './formats';
import type { Query, Range } from './searchQuery';

/** Hard cap on lines in a single `lines` message. */
export const MAX_LINES_PER_MESSAGE = 500;
/** A single line sent for a detail view (JSON pretty view) is cut at this size. */
export const MAX_DETAIL_BYTES = 1024 * 1024;
/** Hard cap on search results in a single `results` message. */
export const MAX_RESULTS_PER_MESSAGE = 200;

export type SearchStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * Rows of the main list: every line of the file, only the lines matching the search, or only
 * the lines that do not match (inverted filter).
 */
export type FilterMode = 'all' | 'matches' | 'nonMatches';

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
  /** A hit by position (wraps around). */
  | { index: number }
  /** The first hit on/after (direction 1) or before (direction -1) a line (wraps around). */
  | { fromLine: number; direction: 1 | -1 };

export type WebviewCommand = 'find' | 'findNext' | 'findPrevious' | 'toggleFilter' | 'toggleInvert';

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
      /** Echo of the request's viewId; stale views are dropped. */
      viewId: number;
      /** Row index of the first line. */
      start: number;
      lines: string[];
      /** Positions (relative to `start`) of lines truncated for display. */
      truncated: number[];
      /** File line numbers of the rows (filtered views only; otherwise start + i). */
      lineNumbers?: number[];
    }
  | { type: 'reveal'; /** 0-based file line */ line: number; /** Row showing it in `mode`. */ viewIndex: number; mode: FilterMode }
  | { type: 'error'; message: string }
  | {
      /** Sent at most every 100 ms while a search runs, and once when it ends. */
      type: 'searchState';
      searchId: number;
      status: SearchStatus;
      /** Matching lines found so far. */
      total: number;
      /** Lines searched so far (all lines when done). */
      linesSearched: number;
      bytesSearched: number;
      fileSize: number;
      /** Filter mode on the host and the number of rows it produces. */
      mode: FilterMode;
      viewCount: number;
      elapsedMs?: number;
      error?: string;
    }
  | { type: 'results'; searchId: number; reqId: number; start: number; items: SearchResultItem[] }
  | { type: 'hit'; searchId: number; index: number; line: number; /** Row of the line in `mode`. */ viewIndex: number; mode: FilterMode }
  | {
      /** Reply to setFilter: the new view and where to scroll so the same file line stays on top. */
      type: 'filterState';
      searchId: number;
      viewId: number;
      mode: FilterMode;
      count: number;
      anchorIndex: number;
    }
  | { type: 'command'; command: WebviewCommand }
  /** Puts a query into the search bar and runs it, as if typed. */
  | { type: 'setQuery'; query: Query }
  /** The file format (detected or chosen by the user). */
  | { type: 'format'; format: FormatInfo }
  | { type: 'lineText'; reqId: number; line: number; text: string; truncated: boolean; error?: string }
  /** Switches the filter as if the Filter/Invert buttons were used. */
  | { type: 'setFilterMode'; mode: FilterMode };

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'getLines';
      reqId: number;
      /** Row range of the view. */
      start: number;
      count: number;
      viewId: number;
      mode: FilterMode;
      searchId: number;
    }
  | { type: 'viewport'; topLine: number; visibleLines: number; rowCount: number; mode: FilterMode; format: FormatKind }
  /** Starts a search, cancelling the previous one; an empty query clears the search. */
  | { type: 'search'; searchId: number; query: Query; mode: FilterMode }
  /** Full text of one file line (up to MAX_DETAIL_BYTES). */
  | { type: 'getLineText'; reqId: number; line: number }
  | { type: 'getResults'; searchId: number; reqId: number; start: number; count: number }
  | { type: 'gotoHit'; searchId: number; target: HitTarget }
  /** Changes the filter mode; `anchorIndex` is the current top row. */
  | { type: 'setFilter'; searchId: number; viewId: number; mode: FilterMode; anchorIndex: number };
