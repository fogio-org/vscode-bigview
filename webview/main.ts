import { formatBytes, formatCount } from '../src/shared/format';
import type { FilterMode, HitTarget, HostToWebview, SearchResultItem, WebviewToHost } from '../src/shared/protocol';
import { compileQuery, findRanges, type SearchQuery } from '../src/shared/searchQuery';
import { SearchBar } from './SearchBar';
import './styles.css';
import { VirtualList, type RowData } from './VirtualList';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface SavedState {
  topLine: number;
  query?: SearchQuery;
  resultsHeight?: number;
  filterMode?: FilterMode;
}

interface CachedLine extends RowData {
  /** File line shown in the row. */
  lineNumber: number;
  /** searchVersion the highlight ranges were computed for. */
  v: number;
}

type SearchStateMessage = Extract<HostToWebview, { type: 'searchState' }>;
type IndexMessage = Extract<HostToWebview, { type: 'index' }>;

/** Rows are requested in aligned blocks; always <= MAX_LINES_PER_MESSAGE. */
const LINE_BLOCK = 200;
/** Results are requested in aligned blocks; always <= MAX_RESULTS_PER_MESSAGE. */
const RESULT_BLOCK = 100;
const MAX_CACHED_LINES = 20_000;
const MAX_CACHED_RESULTS = 5_000;
const REQUEST_RETRY_MS = 10_000;
const VIEWPORT_POST_MS = 100;
const MIN_RESULTS_PX = 60;

const vscode = acquireVsCodeApi();
const saved: SavedState = { topLine: 0, ...(vscode.getState() as Partial<SavedState> | undefined) };

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const appEl = $('app');
const fileNameEl = $('file-name');
const fileInfoEl = $('file-info');
const statusEl = $('index-status');
const progressEl = $('progress');
const progressBarEl = $('progress-bar');
const errorEl = $('error');
const splitterEl = $('results-splitter');
const resultsEl = $('results');

/** Main list rows by row index (file lines, or filtered rows). */
const lineCache = new Map<number, CachedLine>();
const pendingLineBlocks = new Map<number, number>();
const resultCache = new Map<number, SearchResultItem>();
const pendingResultBlocks = new Map<number, number>();
let reqSeq = 0;
let lineCount = 0;
let indexInfo: IndexMessage | undefined;
let viewportTimer = 0;

let searchId = 0;
let searchState: SearchStateMessage | undefined;
let searchRegex: RegExp | undefined;
let searchVersion = 0;
let currentHit = -1;
let currentHitLine = -1;
/** Jump to the first hit once the new search produces one. */
let autoJump = false;

/** What the main list shows. Rows of a filtered view come from the host with their line numbers. */
let viewMode: FilterMode = saved.query?.text ? (saved.filterMode ?? 'all') : 'all';
/** Changes whenever the rows change meaning; responses for older views are dropped. */
let viewId = 1;
let viewCount = 0;
/** Requested filter mode awaiting the host's filterState. */
let pendingFilter: FilterMode | undefined;
let restoreLine = viewMode === 'all' ? saved.topLine : 0;

const rowCount = (): number => (viewMode === 'all' ? lineCount : viewCount);

function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

function saveState(): void {
  vscode.setState(saved);
}

function requestBlocks(
  start: number,
  end: number,
  block: number,
  limit: number,
  pending: Map<number, number>,
  has: (i: number) => boolean,
  send: (start: number, count: number) => void,
): void {
  const now = performance.now();
  for (let b = Math.floor(start / block); b <= Math.floor((end - 1) / block); b++) {
    const to = Math.min((b + 1) * block, limit);
    let loaded = true;
    for (let i = b * block; i < to; i++) {
      if (!has(i)) {
        loaded = false;
        break;
      }
    }
    if (loaded) continue;
    const sent = pending.get(b);
    if (sent !== undefined && now - sent < REQUEST_RETRY_MS) continue;
    pending.set(b, now);
    send(b * block, block);
  }
}

function evict<T>(cache: Map<number, T>, max: number, center: number, radius: number): void {
  if (cache.size <= max) return;
  for (const key of cache.keys()) {
    if (cache.size <= max * 0.75) break;
    if (key < center - radius || key > center + radius) cache.delete(key);
  }
}

function lineRow(row: number): RowData | undefined {
  const entry = lineCache.get(row);
  if (!entry) return undefined;
  if (entry.v !== searchVersion) {
    entry.ranges = searchRegex ? findRanges(entry.text, searchRegex) : undefined;
    entry.v = searchVersion;
  }
  return entry;
}

/** File line shown in `row` of the main list, if known. */
function fileLineOfRow(row: number): number | undefined {
  return viewMode === 'all' ? row : lineCache.get(row)?.lineNumber;
}

const list = new VirtualList({
  container: $('viewport'),
  getRow: lineRow,
  gutterText: (row) => {
    const line = fileLineOfRow(row);
    return line === undefined ? '' : String(line + 1);
  },
  ensureRange: (start, end) =>
    requestBlocks(start, end, LINE_BLOCK, rowCount(), pendingLineBlocks, (i) => lineCache.has(i), (s, count) =>
      post({ type: 'getLines', reqId: ++reqSeq, start: s, count, viewId, mode: viewMode, searchId }),
    ),
  onScroll: (topLine) => {
    saved.topLine = topLine;
    saveState();
    scheduleViewport();
  },
});

const results = new VirtualList({
  container: resultsEl,
  className: 'vl-results',
  autoFocus: false,
  getRow: (i) => resultCache.get(i),
  gutterText: (i) => {
    const item = resultCache.get(i);
    return item ? String(item.line + 1) : '';
  },
  ensureRange: (start, end) =>
    requestBlocks(start, end, RESULT_BLOCK, searchState?.total ?? 0, pendingResultBlocks, (i) => resultCache.has(i), (s, count) =>
      post({ type: 'getResults', searchId, reqId: ++reqSeq, start: s, count }),
    ),
  onRowClick: (index) => gotoHit({ index }),
});

const bar = new SearchBar($('search-bar'), saved.query, {
  onQuery: (query) => startSearch(query, true),
  onNext: () => navigate(1),
  onPrevious: () => navigate(-1),
  onEscape: () => list.focus(),
  onFilter: (mode) => requestFilter(mode),
});
bar.setFilter(viewMode, Boolean(saved.query?.text));

/**
 * Reports the viewport to the host: throttled while scrolling, immediately after discrete changes
 * (timers can be throttled to 1 s when the window is in the background).
 */
function scheduleViewport(immediate = false): void {
  if (immediate) {
    window.clearTimeout(viewportTimer);
    viewportTimer = 0;
    postViewport();
    return;
  }
  if (viewportTimer !== 0) return;
  viewportTimer = window.setTimeout(() => {
    viewportTimer = 0;
    postViewport();
  }, VIEWPORT_POST_MS);
}

function postViewport(): void {
  post({ type: 'viewport', topLine: list.topLine, visibleLines: list.visibleLines, rowCount: rowCount(), mode: viewMode });
}

function resetRows(): void {
  lineCache.clear();
  pendingLineBlocks.clear();
  list.refresh();
}

function startSearch(query: SearchQuery, jump: boolean): void {
  searchId++;
  searchState = undefined;
  currentHit = -1;
  currentHitLine = -1;
  resultCache.clear();
  pendingResultBlocks.clear();
  try {
    searchRegex = query.text ? compileQuery(query).regex : undefined;
  } catch {
    searchRegex = undefined; // the host reports the error
  }
  searchVersion++;

  const mode: FilterMode = query.text ? (pendingFilter ?? viewMode) : 'all';
  pendingFilter = undefined;
  if (mode !== 'all' || viewMode !== 'all') {
    // Filtered rows are rebuilt from scratch for the new query (or the full file comes back).
    const anchorLine = mode === 'all' ? (fileLineOfRow(list.topLine) ?? 0) : 0;
    viewId++;
    viewMode = mode;
    viewCount = 0;
    restoreLine = 0;
    resetRows();
    list.setCount(rowCount());
    list.scrollToLine(anchorLine);
  }
  list.refresh();
  list.setHighlight(-1);
  results.setCount(0);
  results.setHighlight(-1);
  setResultsVisible(query.text !== '');
  bar.setFilter(mode, query.text !== '');
  autoJump = jump && query.text !== '';
  saved.query = query;
  saved.filterMode = mode;
  saveState();
  post({ type: 'search', searchId, query, mode });
  renderSearchStatus();
  renderHeader();
  scheduleViewport(true);
}

function requestFilter(mode: FilterMode): void {
  if (!bar.value.text || !searchState) mode = 'all';
  if (mode === (pendingFilter ?? viewMode)) return;
  pendingFilter = mode;
  viewId++;
  bar.setFilter(mode, Boolean(bar.value.text));
  post({ type: 'setFilter', searchId, viewId, mode, anchorIndex: list.topLine });
}

function applyView(mode: FilterMode, count: number, anchorIndex: number): void {
  pendingFilter = undefined;
  viewMode = mode;
  viewCount = count;
  restoreLine = 0;
  resetRows();
  list.setCount(rowCount());
  list.setHighlight(-1);
  list.scrollToLine(anchorIndex);
  bar.setFilter(mode, Boolean(bar.value.text));
  saved.filterMode = mode;
  saveState();
  renderHeader();
  renderSearchStatus();
  scheduleViewport(true);
}

function gotoHit(target: HitTarget): void {
  post({ type: 'gotoHit', searchId, target });
}

function navigate(direction: 1 | -1): void {
  if (!searchState || searchState.total === 0) return;
  const top = fileLineOfRow(list.topLine) ?? 0;
  const lastRow = Math.max(0, Math.min(rowCount(), list.topLine + list.visibleLines) - 1);
  const bottom = (fileLineOfRow(lastRow) ?? top) + 1;
  if (currentHit >= 0 && currentHitLine >= top && currentHitLine < bottom) {
    gotoHit({ index: currentHit + direction });
  } else {
    // The current hit scrolled away: continue from what is on screen.
    gotoHit(direction > 0 ? { fromLine: top, direction } : { fromLine: bottom, direction });
  }
}

function renderSearchStatus(): void {
  if (!bar.value.text) {
    bar.setStatus('', { canNavigate: false });
    return;
  }
  const s = searchState;
  if (!s) {
    bar.setStatus('Searching…', { progress: 0, canNavigate: false });
    return;
  }
  if (s.status === 'error') {
    bar.setStatus(s.error ?? 'Search failed', { error: s.error ?? 'Search failed', canNavigate: false });
    return;
  }
  const running = s.status === 'running';
  const pct = s.fileSize > 0 ? Math.min(100, Math.floor((s.bytesSearched / s.fileSize) * 100)) : 100;
  let text: string;
  if (s.total === 0) {
    text = running ? `Searching… ${pct}%` : 'No results';
  } else {
    const position = currentHit >= 0 ? `${formatCount(currentHit + 1)} of ` : '';
    text = `${position}${formatCount(s.total)} ${s.total === 1 ? 'result' : 'results'}`;
    if (running) text += ` · ${pct}%`;
  }
  bar.setStatus(text, { progress: running ? pct : undefined, canNavigate: s.total > 0 });
}

function renderHeader(): void {
  const m = indexInfo;
  if (!m) return;
  const pct = m.fileSize > 0 ? Math.floor((m.bytesIndexed / m.fileSize) * 100) : 100;
  const lines = `${formatCount(m.lineCount)} lines`;
  let text = m.done ? `${lines} · ${m.source === 'cache' ? 'index loaded from cache' : 'indexed'}` : `Indexing… ${pct}% · ${lines}`;
  if (viewMode !== 'all') {
    text = `Filter: ${formatCount(viewCount)} ${viewMode === 'matches' ? 'matching' : 'non-matching'} of ${text}`;
  }
  statusEl.textContent = text;
  progressBarEl.style.width = `${pct}%`;
  progressEl.classList.toggle('done', m.done);
}

function setResultsVisible(visible: boolean): void {
  resultsEl.hidden = !visible;
  splitterEl.hidden = !visible;
}

if (saved.resultsHeight) resultsEl.style.height = `${Math.round(saved.resultsHeight)}px`;

splitterEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = resultsEl.getBoundingClientRect().height;
  const maxHeight = Math.max(MIN_RESULTS_PX, appEl.clientHeight - 160);
  splitterEl.setPointerCapture(e.pointerId);
  splitterEl.classList.add('dragging');

  function end(): void {
    splitterEl.removeEventListener('pointermove', move);
    splitterEl.removeEventListener('pointerup', end);
    splitterEl.removeEventListener('lostpointercapture', end);
    splitterEl.classList.remove('dragging');
    saveState();
  }
  function move(ev: PointerEvent): void {
    if ((ev.buttons & 1) === 0) {
      end();
      return;
    }
    const height = Math.max(MIN_RESULTS_PX, Math.min(maxHeight, startHeight + startY - ev.clientY));
    resultsEl.style.height = `${Math.round(height)}px`;
    saved.resultsHeight = height;
  }
  splitterEl.addEventListener('pointermove', move);
  splitterEl.addEventListener('pointerup', end);
  splitterEl.addEventListener('lostpointercapture', end);
});

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      fileNameEl.textContent = msg.fileName;
      fileInfoEl.textContent = formatBytes(msg.fileSize);
      break;
    case 'index':
      indexInfo = msg;
      lineCount = msg.lineCount;
      list.setGutterMax(Math.max(1, msg.lineCount));
      results.setGutterMax(Math.max(1, msg.lineCount));
      if (viewMode === 'all') list.setCount(msg.lineCount);
      renderHeader();
      if (restoreLine > 0 && viewMode === 'all' && (msg.lineCount > restoreLine || msg.done)) {
        list.scrollToLine(restoreLine);
        restoreLine = 0;
      }
      break;
    case 'lines': {
      if (msg.viewId !== viewId) break;
      const truncated = new Set(msg.truncated);
      msg.lines.forEach((text, i) =>
        lineCache.set(msg.start + i, { text, truncated: truncated.has(i), lineNumber: msg.lineNumbers?.[i] ?? msg.start + i, v: -1 }),
      );
      pendingLineBlocks.delete(Math.floor(msg.start / LINE_BLOCK));
      evict(lineCache, MAX_CACHED_LINES, list.topLine, LINE_BLOCK * 3);
      list.invalidate();
      break;
    }
    case 'reveal':
      if (msg.mode !== viewMode || pendingFilter !== undefined) break;
      restoreLine = 0;
      list.revealLine(msg.viewIndex);
      list.focus();
      scheduleViewport(true);
      break;
    case 'error':
      errorEl.textContent = msg.message;
      errorEl.hidden = false;
      break;
    case 'searchState':
      if (msg.searchId !== searchId) break;
      searchState = msg;
      results.setCount(msg.total);
      results.invalidate();
      if (viewMode !== 'all' && msg.mode === viewMode && pendingFilter === undefined && msg.viewCount !== viewCount) {
        viewCount = msg.viewCount;
        list.setCount(viewCount);
        list.invalidate();
        scheduleViewport(true);
      }
      if (autoJump && msg.total > 0) {
        autoJump = false;
        gotoHit({ fromLine: fileLineOfRow(list.topLine) ?? 0, direction: 1 });
      }
      if (msg.status !== 'running') autoJump = false;
      renderSearchStatus();
      renderHeader();
      break;
    case 'results':
      if (msg.searchId !== searchId) break;
      msg.items.forEach((item, k) => resultCache.set(msg.start + k, item));
      pendingResultBlocks.delete(Math.floor(msg.start / RESULT_BLOCK));
      evict(resultCache, MAX_CACHED_RESULTS, results.topLine, RESULT_BLOCK * 10);
      results.invalidate();
      break;
    case 'hit':
      if (msg.searchId !== searchId) break;
      currentHit = msg.index;
      currentHitLine = msg.line;
      restoreLine = 0;
      if (msg.mode === viewMode && pendingFilter === undefined) list.revealLine(msg.viewIndex, true);
      results.setHighlight(msg.index);
      results.ensureVisible(msg.index);
      renderSearchStatus();
      scheduleViewport(true);
      break;
    case 'filterState':
      if (msg.searchId !== searchId || msg.viewId !== viewId) break;
      applyView(msg.mode, msg.count, msg.anchorIndex);
      break;
    case 'command':
      switch (msg.command) {
        case 'find':
          bar.focus();
          break;
        case 'findNext':
          navigate(1);
          break;
        case 'findPrevious':
          navigate(-1);
          break;
        case 'toggleFilter':
          requestFilter((pendingFilter ?? viewMode) === 'all' ? 'matches' : 'all');
          break;
        case 'toggleInvert':
          requestFilter((pendingFilter ?? viewMode) === 'nonMatches' ? 'matches' : 'nonMatches');
          break;
      }
      break;
    case 'setQuery':
      bar.setValue(msg.query);
      startSearch(msg.query, true);
      break;
    case 'setFilterMode':
      requestFilter(msg.mode);
      break;
  }
});

post({ type: 'ready' });
if (saved.query?.text) startSearch(saved.query, false);
