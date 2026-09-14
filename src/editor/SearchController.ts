import * as vscode from 'vscode';
import type { ChunkReader } from '../core/ChunkReader';
import { SearchResults } from '../core/SearchResults';
import {
  MAX_RESULTS_PER_MESSAGE,
  type HitTarget,
  type HostToWebview,
  type SearchResultItem,
  type SearchStatus,
} from '../shared/protocol';
import { compileQuery, makeSnippet, type SearchQuery } from '../shared/searchQuery';
import type { SearchTask, SearchWorker } from '../workers/workerPool';
import type { BigViewDocument } from './BigViewProvider';

/** State updates to the webview are throttled to this interval (SPEC §3.6). */
const STATE_POST_MS = 100;

export interface SearchState {
  searchId: number;
  query: SearchQuery | undefined;
  status: SearchStatus;
  total: number;
  stored: number;
  bytesSearched: number;
  fileSize: number;
  /** Wall time from the request to the last hit, measured on the host. */
  elapsedMs: number | undefined;
  error: string | undefined;
}

const idle = (searchId: number): SearchState => ({
  searchId,
  query: undefined,
  status: 'idle',
  total: 0,
  stored: 0,
  bytesSearched: 0,
  fileSize: 0,
  elapsedMs: undefined,
  error: undefined,
});

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whole-file search for one editor panel. Owns its worker thread (created lazily). */
export class SearchController implements vscode.Disposable {
  private worker: SearchWorker | undefined;
  private task: SearchTask | undefined;
  private results = new SearchResults();
  private regex: RegExp | undefined;
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
    this.reader = doc.createReader({ blockBytes: 64 * 1024 });
  }

  get state(): SearchState {
    return this.current;
  }

  /** Stored hit line numbers (for tests). */
  hitLines(): number[] {
    return this.results.toArray();
  }

  start(searchId: number, query: SearchQuery): void {
    this.stopTask();
    const results = new SearchResults();
    this.results = results;
    this.regex = undefined;
    this.lastHit = undefined;

    if (query.text === '') {
      this.replace(idle(searchId));
      return;
    }
    try {
      this.regex = compileQuery(query).regex;
    } catch (err) {
      this.replace({ ...idle(searchId), query, status: 'error', error: messageOf(err) });
      return;
    }

    this.startedAt = performance.now();
    this.replace({ ...idle(searchId), query, status: 'running', fileSize: this.doc.fileSize });
    this.worker ??= this.createWorker();
    const task = this.worker.search(this.doc.uri.fsPath, query, {
      onProgress: (lines, bytesSearched, fileSize) => {
        if (this.task !== task) return;
        results.add(lines);
        this.patch({ total: results.total, stored: results.stored, bytesSearched, fileSize }, false);
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
            total: results.total,
            stored: results.stored,
            bytesSearched: outcome.bytesSearched,
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
    this.results = new SearchResults();
    this.regex = undefined;
    this.lastHit = undefined;
    this.current = idle(0);
    this.emitter.fire(this.current);
  }

  /** Result rows with excerpts; undefined if the search is no longer current. */
  async readResults(searchId: number, start: number, count: number): Promise<SearchResultItem[] | undefined> {
    const regex = this.regex;
    if (searchId !== this.current.searchId || !regex) return undefined;
    const results = this.results;
    const first = Math.max(0, Math.floor(start));
    const end = Math.min(first + Math.min(Math.max(0, count), MAX_RESULTS_PER_MESSAGE), results.stored);
    const items: SearchResultItem[] = [];
    for (let i = first; i < end; i++) {
      const line = results.lineAt(i);
      if (line >= this.doc.index.lineCount) await this.doc.indexed;
      const { lines } = await this.reader.readLines(line, 1);
      items.push({ line, ...makeSnippet(lines[0] ?? '', regex) });
    }
    return searchId === this.current.searchId ? items : undefined;
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
    const stored = this.results.stored;
    if (stored === 0) return;
    let index: number;
    if ('index' in target) {
      index = ((Math.floor(target.index) % stored) + stored) % stored;
    } else {
      const lb = this.results.lowerBound(target.fromLine);
      index = target.direction > 0 ? (lb < stored ? lb : 0) : lb > 0 ? lb - 1 : stored - 1;
    }
    const line = this.results.lineAt(index);
    const send = (): void => {
      if (searchId !== this.current.searchId) return;
      this.lastHit = { searchId, index, line };
      this.post({ type: 'hit', searchId, index, line });
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
      stored: s.stored,
      bytesSearched: s.bytesSearched,
      fileSize: s.fileSize,
      elapsedMs: s.elapsedMs,
      error: s.error,
    });
  }
}
