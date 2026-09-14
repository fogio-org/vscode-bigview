import * as vscode from 'vscode';
import type { ChunkReader, LinesResult } from '../core/ChunkReader';
import { LineSet } from '../core/LineSet';
import {
  MAX_LINES_PER_MESSAGE,
  MAX_RESULTS_PER_MESSAGE,
  type FilterMode,
  type HitTarget,
  type HostToWebview,
  type SearchResultItem,
  type SearchStatus,
  type WebviewToHost,
} from '../shared/protocol';
import { validateQuery } from '../formats/predicates';
import { isEmptyQuery, makeSnippet, type Query } from '../shared/searchQuery';
import type { SearchTask, SearchWorker } from '../workers/workerPool';
import type { BigViewDocument } from './BigViewProvider';

/** State updates to the webview are throttled to this interval (SPEC §3.6). */
const STATE_POST_MS = 100;
/** Filtered rows and result excerpts are scattered: read small blocks. */
const SCATTERED_READ_BLOCK_BYTES = 64 * 1024;

export interface SearchState {
  searchId: number;
  query: Query | undefined;
  status: SearchStatus;
  /** Matching lines found so far. */
  total: number;
  /** Lines fully searched (all lines when done). */
  linesSearched: number;
  bytesSearched: number;
  fileSize: number;
  /** Wall time from the request to the last hit, measured on the host. */
  elapsedMs: number | undefined;
  error: string | undefined;
}

export interface ViewLines extends LinesResult {
  /** File line number of each returned row. */
  lineNumbers: number[];
}

export interface ExportSelection {
  mode: 'matches' | 'nonMatches';
  count: number;
  /** Copy of the hit bitset. */
  words: Uint32Array;
  lineCount: number;
}

const idle = (searchId: number): SearchState => ({
  searchId,
  query: undefined,
  status: 'idle',
  total: 0,
  linesSearched: 0,
  bytesSearched: 0,
  fileSize: 0,
  elapsedMs: undefined,
  error: undefined,
});

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Whole-file search and filter view for one editor panel. Owns its worker thread (created
 * lazily). Hits live in a LineSet, which maps rows of the filtered views (SPEC §6 M4) to file
 * lines and back.
 */
export class SearchController implements vscode.Disposable {
  private worker: SearchWorker | undefined;
  private task: SearchTask | undefined;
  private hits = new LineSet();
  private regex: RegExp | undefined;
  private filterMode: FilterMode = 'all';
  private startedAt = 0;
  private postTimer: NodeJS.Timeout | undefined;
  private current = idle(0);
  private readonly reader: ChunkReader;
  private readonly emitter = new vscode.EventEmitter<SearchState>();
  readonly onDidChange = this.emitter.event;
  /** Last navigation target (for tests). */
  lastHit: { searchId: number; index: number; line: number } | undefined;

  constructor(
    private readonly doc: BigViewDocument,
    private readonly createWorker: () => SearchWorker,
    private readonly post: (msg: HostToWebview) => void,
  ) {
    this.reader = doc.createReader({ blockBytes: SCATTERED_READ_BLOCK_BYTES });
  }

  get state(): SearchState {
    return this.current;
  }

  get mode(): FilterMode {
    return this.filterMode;
  }

  /** Hit line numbers (for tests). */
  hitLines(): number[] {
    return this.hits.toArray();
  }

  start(searchId: number, query: Query, mode: FilterMode = 'all'): void {
    this.stopTask();
    const hits = new LineSet();
    this.hits = hits;
    this.regex = undefined;
    this.lastHit = undefined;
    const empty = isEmptyQuery(query);
    this.filterMode = empty ? 'all' : mode;

    if (empty) {
      this.replace(idle(searchId));
      return;
    }
    try {
      this.regex = validateQuery(query);
    } catch (err) {
      this.replace({ ...idle(searchId), query, status: 'error', error: messageOf(err) });
      return;
    }

    this.startedAt = performance.now();
    this.replace({ ...idle(searchId), query, status: 'running', fileSize: this.doc.fileSize });
    this.worker ??= this.createWorker();
    const task = this.worker.search(this.doc.uri.fsPath, query, {
      onProgress: (lines, bytesSearched, fileSize, linesSearched) => {
        if (this.task !== task) return;
        hits.addAll(lines);
        this.patch({ total: hits.size, bytesSearched, fileSize, linesSearched }, false);
      },
    });
    this.task = task;
    task.result.then(
      (outcome) => {
        if (this.task !== task) return;
        this.task = undefined;
        if (outcome.status !== 'done') return;
        this.patch(
          {
            status: 'done',
            total: hits.size,
            bytesSearched: outcome.bytesSearched,
            linesSearched: outcome.lineCount,
            fileSize: outcome.fileSize,
            elapsedMs: performance.now() - this.startedAt,
          },
          true,
        );
      },
      (err: unknown) => {
        if (this.task !== task) return;
        this.task = undefined;
        this.patch({ status: 'error', error: messageOf(err) }, true);
      },
    );
  }

  /** Forgets the current search (the webview reloaded). */
  reset(): void {
    this.stopTask();
    this.hits = new LineSet();
    this.regex = undefined;
    this.lastHit = undefined;
    this.filterMode = 'all';
    this.current = idle(0);
    this.emitter.fire(this.current);
  }

  /** Resolves once the current search is no longer running. */
  whenSettled(): Promise<SearchState> {
    if (this.current.status !== 'running') return Promise.resolve(this.current);
    return new Promise((resolve) => {
      const sub = this.emitter.event((s) => {
        if (s.status !== 'running') {
          sub.dispose();
          resolve(s);
        }
      });
    });
  }

  // ---- filter view ----

  /** Rows in `mode`. */
  viewCount(mode: FilterMode = this.filterMode): number {
    switch (mode) {
      case 'all':
        return this.doc.index.lineCount;
      case 'matches':
        return this.hits.size;
      case 'nonMatches':
        return this.hits.complementSize(this.current.linesSearched);
    }
  }

  /** File line shown in row `index` of `mode`. */
  lineAtView(index: number, mode: FilterMode = this.filterMode): number {
    switch (mode) {
      case 'all':
        return index;
      case 'matches':
        return this.hits.select(index);
      case 'nonMatches':
        return this.hits.complementSelect(index, this.current.linesSearched);
    }
  }

  /** Row of `line` in `mode`, or of the next row after it if the line is not shown. */
  viewIndexOfLine(line: number, mode: FilterMode = this.filterMode): number {
    const count = this.viewCount(mode);
    if (count === 0) return 0;
    const index =
      mode === 'all'
        ? line
        : mode === 'matches'
          ? this.hits.rank(line)
          : this.hits.complementRank(Math.min(line, this.current.linesSearched));
    return clamp(index, 0, count - 1);
  }

  setFilter(searchId: number, viewId: number, mode: FilterMode, anchorIndex: number): void {
    if (searchId !== this.current.searchId) return;
    const next: FilterMode = this.current.query ? mode : 'all';
    const oldCount = this.viewCount();
    const anchorLine = oldCount > 0 ? this.lineAtView(clamp(Math.floor(anchorIndex), 0, oldCount - 1)) : 0;
    this.filterMode = next;
    this.post({
      type: 'filterState',
      searchId,
      viewId,
      mode: next,
      count: this.viewCount(),
      anchorIndex: this.viewIndexOfLine(anchorLine),
    });
    this.emitter.fire(this.current);
  }

  /** Rows [start, start + count) of a filtered view; undefined if the search is stale. */
  async readView(searchId: number, mode: FilterMode, start: number, count: number): Promise<ViewLines | undefined> {
    if (searchId !== this.current.searchId || mode === 'all') return undefined;
    const first = Math.max(0, Math.floor(start));
    const n = Math.min(Math.max(0, Math.floor(count)), MAX_LINES_PER_MESSAGE, this.viewCount(mode) - first);
    if (n <= 0) return { start: first, lines: [], truncated: [], lineNumbers: [] };
    const lines =
      mode === 'matches' ? this.hits.membersFrom(first, n) : this.hits.complementFrom(first, n, this.current.linesSearched);
    if ((lines[lines.length - 1] as number) >= this.doc.index.lineCount) await this.doc.indexed;
    const res = await this.reader.readLinesAt(lines);
    if (searchId !== this.current.searchId) return undefined;
    return { start: first, lines: res.lines, truncated: res.truncated, lineNumbers: lines.slice(0, res.lines.length) };
  }

  sendViewLines(msg: Extract<WebviewToHost, { type: 'getLines' }>): void {
    this.readView(msg.searchId, msg.mode, msg.start, msg.count).then(
      (res) => {
        if (!res) return;
        this.post({
          type: 'lines',
          reqId: msg.reqId,
          viewId: msg.viewId,
          start: res.start,
          lines: res.lines,
          truncated: res.truncated,
          lineNumbers: res.lineNumbers,
        });
      },
      (err: unknown) => this.post({ type: 'error', message: `Read failed: ${messageOf(err)}` }),
    );
  }

  /** The lines an export writes: the filter's selection (matching lines unless inverted). */
  exportSelection(): ExportSelection | undefined {
    if (!this.current.query || this.current.status !== 'done') return undefined;
    const mode = this.filterMode === 'nonMatches' ? 'nonMatches' : 'matches';
    return { mode, count: this.viewCount(mode), words: this.hits.toWords(), lineCount: this.current.linesSearched };
  }

  // ---- results list and navigation ----

  /** Result rows with excerpts; undefined if the search is no longer current. */
  async readResults(searchId: number, start: number, count: number): Promise<SearchResultItem[] | undefined> {
    const regex = this.regex; // undefined for time/field queries: excerpts without highlights
    if (searchId !== this.current.searchId || !this.current.query) return undefined;
    const first = Math.max(0, Math.floor(start));
    const n = Math.min(Math.max(0, count), MAX_RESULTS_PER_MESSAGE, this.hits.size - first);
    if (n <= 0) return [];
    const lines = this.hits.membersFrom(first, n);
    if ((lines[lines.length - 1] as number) >= this.doc.index.lineCount) await this.doc.indexed;
    const res = await this.reader.readLinesAt(lines);
    if (searchId !== this.current.searchId) return undefined;
    return res.lines.map((text, k) => ({ line: lines[k] as number, ...makeSnippet(text, regex) }));
  }

  sendResults(searchId: number, reqId: number, start: number, count: number): void {
    this.readResults(searchId, start, count).then(
      (items) => {
        if (items) this.post({ type: 'results', searchId, reqId, start: Math.max(0, Math.floor(start)), items });
      },
      (err: unknown) => this.post({ type: 'error', message: `Reading search results failed: ${messageOf(err)}` }),
    );
  }

  gotoHit(searchId: number, target: HitTarget): void {
    if (searchId !== this.current.searchId) return;
    const total = this.hits.size;
    if (total === 0) return;
    let index: number;
    if ('index' in target) {
      index = ((Math.floor(target.index) % total) + total) % total;
    } else {
      const lb = this.hits.rank(target.fromLine);
      index = target.direction > 0 ? (lb < total ? lb : 0) : lb > 0 ? lb - 1 : total - 1;
    }
    const line = this.hits.select(index);
    const send = (): void => {
      if (searchId !== this.current.searchId) return;
      this.lastHit = { searchId, index, line };
      this.post({ type: 'hit', searchId, index, line, viewIndex: this.viewIndexOfLine(line), mode: this.filterMode });
      this.emitter.fire(this.current);
    };
    // The line may not be indexed yet if the search outran the indexer.
    if (line < this.doc.index.lineCount) send();
    else void this.doc.indexed.then(send);
  }

  dispose(): void {
    this.stopTask();
    this.worker?.dispose();
    this.emitter.dispose();
  }

  private stopTask(): void {
    this.task?.cancel();
    this.task = undefined;
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = undefined;
  }

  private replace(state: SearchState): void {
    this.current = state;
    this.emitter.fire(state);
    this.postState();
  }

  private patch(p: Partial<SearchState>, immediate: boolean): void {
    this.current = { ...this.current, ...p };
    this.emitter.fire(this.current);
    if (immediate) {
      this.postState();
    } else if (!this.postTimer) {
      this.postTimer = setTimeout(() => {
        this.postTimer = undefined;
        this.postState();
      }, STATE_POST_MS);
    }
  }

  private postState(): void {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = undefined;
    const s = this.current;
    this.post({
      type: 'searchState',
      searchId: s.searchId,
      status: s.status,
      total: s.total,
      linesSearched: s.linesSearched,
      bytesSearched: s.bytesSearched,
      fileSize: s.fileSize,
      mode: this.filterMode,
      viewCount: this.viewCount(),
      elapsedMs: s.elapsedMs,
      error: s.error,
    });
  }
}
