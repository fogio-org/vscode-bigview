import { formatBytes, formatCount } from '../src/shared/format';
import type { HitTarget, HostToWebview, SearchResultItem, WebviewToHost } from '../src/shared/protocol';
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
}

interface CachedLine extends RowData {
  /** searchVersion the highlight ranges were computed for. */
  v: number;
}

type SearchStateMessage = Extract<HostToWebview, { type: 'searchState' }>;

/** Lines are requested in aligned blocks; always <= MAX_LINES_PER_MESSAGE. */
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

const lineCache = new Map<number, CachedLine>();
const pendingLineBlocks = new Map<number, number>();
const resultCache = new Map<number, SearchResultItem>();
const pendingResultBlocks = new Map<number, number>();
let reqSeq = 0;
let lineCount = 0;
let restoreLine = saved.topLine;
let viewportTimer = 0;

let searchId = 0;
let searchState: SearchStateMessage | undefined;
let searchRegex: RegExp | undefined;
let searchVersion = 0;
let currentHit = -1;
let currentHitLine = -1;
/** Jump to the first hit once the new search produces one. */
let autoJump = false;

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

function lineRow(line: number): RowData | undefined {
  const entry = lineCache.get(line);
  if (!entry) return undefined;
  if (entry.v !== searchVersion) {
    entry.ranges = searchRegex ? findRanges(entry.text, searchRegex) : undefined;
    entry.v = searchVersion;
  }
  return entry;
}

const list = new VirtualList({
  container: $('viewport'),
  getRow: lineRow,
  ensureRange: (start, end) =>
    requestBlocks(start, end, LINE_BLOCK, lineCount, pendingLineBlocks, (i) => lineCache.has(i), (s, count) =>
      post({ type: 'getLines', reqId: ++reqSeq, start: s, count }),
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
    requestBlocks(start, end, RESULT_BLOCK, searchState?.stored ?? 0, pendingResultBlocks, (i) => resultCache.has(i), (s, count) =>
      post({ type: 'getResults', searchId, reqId: ++reqSeq, start: s, count }),
    ),
  onRowClick: (index) => gotoHit({ index }),
});

const bar = new SearchBar($('search-bar'), saved.query, {
  onQuery: (query) => startSearch(query, true),
  onNext: () => navigate(1),
  onPrevious: () => navigate(-1),
  onEscape: () => list.focus(),
});

function scheduleViewport(): void {
  if (viewportTimer !== 0) return;
  viewportTimer = window.setTimeout(() => {
    viewportTimer = 0;
    post({ type: 'viewport', topLine: list.topLine, visibleLines: list.visibleLines });
  }, VIEWPORT_POST_MS);
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
  list.refresh();
  list.setHighlight(-1);
  results.setCount(0);
  results.setHighlight(-1);
  setResultsVisible(query.text !== '');
  autoJump = jump && query.text !== '';
  saved.query = query;
  saveState();
  post({ type: 'search', searchId, query });
  renderSearchStatus();
}

function gotoHit(target: HitTarget): void {
  post({ type: 'gotoHit', searchId, target });
}

function navigate(direction: 1 | -1): void {
  if (!searchState || searchState.stored === 0) return;
  const top = list.topLine;
  const bottom = top + list.visibleLines;
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
    if (s.stored < s.total) text += ` (first ${formatCount(s.stored)} listed)`;
  }
  bar.setStatus(text, { progress: running ? pct : undefined, canNavigate: s.stored > 0 });
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
    case 'index': {
      lineCount = msg.lineCount;
      list.setCount(msg.lineCount);
      results.setGutterMax(Math.max(1, msg.lineCount));
      const pct = msg.fileSize > 0 ? Math.floor((msg.bytesIndexed / msg.fileSize) * 100) : 100;
      const lines = `${formatCount(msg.lineCount)} lines`;
      statusEl.textContent = msg.done
        ? `${lines} · ${msg.source === 'cache' ? 'index loaded from cache' : 'indexed'}`
        : `Indexing… ${pct}% · ${lines}`;
      progressBarEl.style.width = `${pct}%`;
      progressEl.classList.toggle('done', msg.done);
      if (restoreLine > 0 && (msg.lineCount > restoreLine || msg.done)) {
        list.scrollToLine(restoreLine);
        restoreLine = 0;
      }
      break;
    }
    case 'lines': {
      const truncated = new Set(msg.truncated);
      msg.lines.forEach((text, i) => lineCache.set(msg.start + i, { text, truncated: truncated.has(i), v: -1 }));
      pendingLineBlocks.delete(Math.floor(msg.start / LINE_BLOCK));
      evict(lineCache, MAX_CACHED_LINES, list.topLine, LINE_BLOCK * 3);
      list.invalidate();
      break;
    }
    case 'reveal':
      restoreLine = 0;
      list.revealLine(msg.line);
      list.focus();
      break;
    case 'error':
      errorEl.textContent = msg.message;
      errorEl.hidden = false;
      break;
    case 'searchState':
      if (msg.searchId !== searchId) break;
      searchState = msg;
      results.setCount(msg.stored);
      results.invalidate();
      if (autoJump && msg.stored > 0) {
        autoJump = false;
        gotoHit({ fromLine: list.topLine, direction: 1 });
      }
      if (msg.status !== 'running') autoJump = false;
      renderSearchStatus();
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
      list.revealLine(msg.line, true);
      results.setHighlight(msg.index);
      results.ensureVisible(msg.index);
      renderSearchStatus();
      break;
    case 'command':
      if (msg.command === 'find') bar.focus();
      else navigate(msg.command === 'findNext' ? 1 : -1);
      break;
    case 'setQuery':
      bar.setValue(msg.query);
      startSearch(msg.query, true);
      break;
  }
});

post({ type: 'ready' });
if (saved.query?.text) startSearch(saved.query, false);
