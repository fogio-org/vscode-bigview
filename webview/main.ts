import { parseDsvLine } from '../src/formats/dsvFormat';
import { jsonTokens, type JsonTokenKind } from '../src/formats/jsonHighlight';
import { fieldValueText, flattenJson, parseJsonLine, type JsonValue } from '../src/formats/jsonlFormat';
import { detectLevel, parseTimestamp } from '../src/formats/logFormat';
import { formatBytes, formatCount } from '../src/shared/format';
import { formatLabel, type FormatInfo } from '../src/shared/formats';
import type { FilterMode, HitTarget, HostToWebview, SearchResultItem, WebviewToHost } from '../src/shared/protocol';
import { compileQuery, findRanges, isEmptyQuery, isTextQuery, type Query } from '../src/shared/searchQuery';
import { SearchBar } from './SearchBar';
import './styles.css';
import { appendMarked, VirtualList, type Mark, type RowData } from './VirtualList';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface SavedState {
  topLine: number;
  query?: Query;
  resultsHeight?: number;
  filterMode?: FilterMode;
  /** DSV column widths by header signature. */
  columns?: { key: string; widths: number[] };
}

interface CachedLine extends RowData {
  /** File line shown in the row. */
  lineNumber: number;
  /** decorVersion the decorations were computed for. */
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
const MIN_COLUMN_PX = 40;
const MIN_AUTO_COLUMN_PX = 60;
const MAX_AUTO_COLUMN_PX = 420;
const DETAIL_FIELDS = 500;
const DETAIL_JSON_CHARS = 200_000;
const DETAIL_JSON_TOKENS = 50_000;
const YEAR = new Date().getUTCFullYear();

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
const tableHeaderEl = $('table-header');
const tableCellsEl = $('table-header-cells');
const detailsEl = $('details');

/** Main list rows by row index (file lines, or filtered rows). */
const lineCache = new Map<number, CachedLine>();
const pendingLineBlocks = new Map<number, number>();
const resultCache = new Map<number, SearchResultItem>();
const pendingResultBlocks = new Map<number, number>();
let reqSeq = 0;
let lineCount = 0;
let fileSize = 0;
let indexInfo: IndexMessage | undefined;
let viewportTimer = 0;

let searchId = 0;
let searchState: SearchStateMessage | undefined;
let searchRegex: RegExp | undefined;
/** Bumped when highlights or format decorations must be recomputed. */
let decorVersion = 0;
let currentHit = -1;
let currentHitLine = -1;
/** Jump to the first hit once the new search produces one. */
let autoJump = false;

/** What the main list shows. Rows of a filtered view come from the host with their line numbers. */
let viewMode: FilterMode = saved.query && !isEmptyQuery(saved.query) ? (saved.filterMode ?? 'all') : 'all';
/** Changes whenever the rows change meaning; responses for older views are dropped. */
let viewId = 1;
let viewCount = 0;
/** Requested filter mode awaiting the host's filterState. */
let pendingFilter: FilterMode | undefined;
let restoreLine = viewMode === 'all' ? saved.topLine : 0;

let format: FormatInfo = { kind: 'text', source: 'content' };
let columnWidths: number[] = [];
/** Columns still use their initial width and may be sized from loaded rows. */
let columnsAutoSize = false;
let detailRequest = 0;

const rowCount = (): number => (viewMode === 'all' ? lineCount : viewCount);
const hasQuery = (): boolean => !isEmptyQuery(bar.value);

function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

function saveState(): void {
  vscode.setState(saved);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
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

const JSON_TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: 'json-key',
  string: 'json-string',
  number: 'json-number',
  literal: 'json-literal',
};

function jsonMarks(text: string, maxTokens?: number): Mark[] {
  return jsonTokens(text, maxTokens).map((t) => ({ start: t.start, end: t.end, cls: JSON_TOKEN_CLASS[t.kind] }));
}

/** Class for a field value in the details panel, by JSON type. */
function jsonValueClass(value: JsonValue): string {
  if (typeof value === 'string') return ' json-string';
  if (typeof value === 'number') return ' json-number';
  if (typeof value === 'boolean' || value === null) return ' json-literal';
  return '';
}

/** Search highlights and format decorations of a row (computed once per decorVersion). */
function decorate(entry: CachedLine): void {
  entry.ranges = searchRegex ? findRanges(entry.text, searchRegex) : undefined;
  entry.cls = undefined;
  entry.marks = undefined;
  entry.cells = undefined;
  entry.cellRanges = undefined;
  switch (format.kind) {
    case 'log': {
      const marks: Mark[] = [];
      const level = detectLevel(entry.text);
      if (level) {
        entry.cls = `lvl-${level.level}`;
        marks.push({ start: level.start, end: level.end, cls: 'log-level' });
      }
      const ts = parseTimestamp(entry.text, YEAR);
      if (ts) marks.push({ start: ts.start, end: ts.end, cls: 'log-ts' });
      entry.marks = marks;
      break;
    }
    case 'dsv': {
      const cells = parseDsvLine(entry.text, format.delimiter ?? ',');
      entry.cells = cells;
      // Matches are highlighted within cells; a match spanning a delimiter still finds the row.
      const regex = searchRegex;
      if (regex) entry.cellRanges = cells.map((cell) => findRanges(cell, regex));
      if (entry.lineNumber === 0) entry.cls = 'dsv-header-row';
      break;
    }
    case 'jsonl': {
      // Syntax colors for rows that look like JSON; other lines stay plain.
      const first = entry.text.trimStart().charCodeAt(0);
      if (first === 0x7b || first === 0x5b) entry.marks = jsonMarks(entry.text);
      break;
    }
    default:
      break;
  }
  entry.v = decorVersion;
}

function lineRow(row: number): RowData | undefined {
  const entry = lineCache.get(row);
  if (!entry) return undefined;
  if (entry.v !== decorVersion) decorate(entry);
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
  onRowClick: (row) => showDetails(row),
  cellWidths: () => (format.kind === 'dsv' ? columnWidths : undefined),
  contentWidth: () => (format.kind === 'dsv' ? columnWidths.reduce((a, b) => a + b + 8, 0) + 48 : undefined),
  onHorizontalScroll: (left) => {
    tableCellsEl.style.transform = `translate3d(${-left}px, 0, 0)`;
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
bar.setFilter(viewMode, Boolean(saved.query && !isEmptyQuery(saved.query)));

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
  post({
    type: 'viewport',
    topLine: list.topLine,
    visibleLines: list.visibleLines,
    rowCount: rowCount(),
    mode: viewMode,
    format: format.kind,
  });
}

function resetRows(): void {
  lineCache.clear();
  pendingLineBlocks.clear();
  list.refresh();
}

// ---- formats ----

function renderFileInfo(): void {
  fileInfoEl.textContent = `${formatBytes(fileSize)} · ${formatLabel(format)}`;
}

function applyFormat(next: FormatInfo): void {
  format = next;
  decorVersion++;
  const dsv = next.kind === 'dsv';
  tableHeaderEl.hidden = !dsv;
  if (dsv) initColumns();
  if (next.kind !== 'jsonl') hideDetails();
  bar.setFormat(next.kind);
  renderFileInfo();
  list.refresh();
  list.relayout();
  scheduleViewport(true);
}

function columnKey(): string {
  return `${format.delimiter}|${(format.header ?? []).join(format.delimiter ?? ',')}`;
}

function initColumns(): void {
  const header = format.header ?? [];
  const key = columnKey();
  columnsAutoSize = false;
  if (saved.columns?.key === key && saved.columns.widths.length === header.length) {
    columnWidths = [...saved.columns.widths];
  } else {
    columnWidths = header.map((name) => columnWidthFor(name.length));
    columnsAutoSize = true;
    autoSizeColumns();
  }
  buildTableHeader();
}

function columnWidthFor(chars: number): number {
  return Math.round(Math.min(MAX_AUTO_COLUMN_PX, Math.max(MIN_AUTO_COLUMN_PX, (chars + 2) * list.charPixels)));
}

function alignTableHeader(): void {
  // Cells start after the gutter and the row padding (see .vl-text .vl-row).
  tableCellsEl.style.left = `${list.gutterPixels + 12}px`;
}

/** Sizes columns to the header and the rows loaded so far (90th percentile of cell length). */
function autoSizeColumns(): void {
  if (!columnsAutoSize || lineCache.size === 0) return;
  const lengths: number[][] = (format.header ?? []).map((name) => [name.length]);
  let sampled = 0;
  for (const entry of lineCache.values()) {
    if (sampled++ >= 200) break;
    parseDsvLine(entry.text, format.delimiter ?? ',').forEach((cell, i) => lengths[i]?.push(cell.length));
  }
  columnWidths = lengths.map((ls) => {
    const sorted = [...ls].sort((a, b) => a - b);
    return columnWidthFor(sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0);
  });
  columnsAutoSize = false;
  buildTableHeader();
  list.refresh();
  list.relayout();
}

function buildTableHeader(): void {
  tableCellsEl.textContent = '';
  alignTableHeader();
  (format.header ?? []).forEach((name, i) => {
    const cell = el('div', 'th-cell');
    cell.style.width = `${columnWidths[i]}px`;
    cell.textContent = name;
    cell.title = name;
    const handle = el('div', 'th-resize');
    handle.addEventListener('pointerdown', (e) => startColumnResize(e, i, cell, handle));
    cell.append(handle);
    tableCellsEl.append(cell);
  });
}

function startColumnResize(e: PointerEvent, index: number, cell: HTMLDivElement, handle: HTMLDivElement): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startWidth = columnWidths[index] ?? 120;
  handle.setPointerCapture(e.pointerId);
  handle.classList.add('dragging');
  const move = (ev: PointerEvent): void => {
    if ((ev.buttons & 1) === 0) {
      end();
      return;
    }
    columnsAutoSize = false;
    const width = Math.max(MIN_COLUMN_PX, Math.round(startWidth + ev.clientX - startX));
    columnWidths[index] = width;
    cell.style.width = `${width}px`;
    list.refresh();
    list.relayout();
  };
  const end = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('lostpointercapture', end);
    handle.classList.remove('dragging');
    saved.columns = { key: columnKey(), widths: [...columnWidths] };
    saveState();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('lostpointercapture', end);
}

// ---- JSON details panel ----

function showDetails(row: number): void {
  if (format.kind !== 'jsonl') return;
  const line = fileLineOfRow(row);
  if (line === undefined) return;
  list.setHighlight(row);
  detailsEl.hidden = false;
  detailsEl.textContent = '';
  detailsEl.append(detailsHead(line), note('Loading…'));
  post({ type: 'getLineText', reqId: ++detailRequest, line });
}

function hideDetails(): void {
  detailsEl.hidden = true;
  detailsEl.textContent = '';
  detailRequest++;
}

function detailsHead(line: number): HTMLDivElement {
  const head = el('div', 'dt-head');
  const title = el('span', 'dt-title');
  title.textContent = `Line ${formatCount(line + 1)}`;
  const close = el('button', 'sb-button');
  close.textContent = '×';
  close.title = 'Close';
  close.addEventListener('click', hideDetails);
  head.append(title, close);
  return head;
}

function note(text: string, cls = 'dt-note'): HTMLDivElement {
  const div = el('div', cls);
  div.textContent = text;
  return div;
}

/** Field query value: bare when unambiguous, JSON-quoted otherwise. */
function queryValue(value: JsonValue): string {
  const text = fieldValueText(value);
  return typeof value === 'string' && (text !== text.trim() || text.startsWith('"') || text === '') ? JSON.stringify(value) : text;
}

function renderDetails(msg: Extract<HostToWebview, { type: 'lineText' }>): void {
  detailsEl.textContent = '';
  detailsEl.append(detailsHead(msg.line));
  if (msg.error) {
    detailsEl.append(note(msg.error, 'dt-error'));
    return;
  }
  const parsed = parseJsonLine(msg.text);
  if (!parsed.ok) {
    detailsEl.append(note(`Not valid JSON: ${parsed.error}${msg.truncated ? ' (the line is longer than 1 MB)' : ''}`, 'dt-error'));
    const raw = el('pre', 'dt-json');
    raw.textContent = msg.text.slice(0, DETAIL_JSON_CHARS);
    detailsEl.append(raw);
    return;
  }
  const fields = flattenJson(parsed.value, DETAIL_FIELDS + 1);
  const list = el('div', 'dt-fields');
  for (const field of fields.slice(0, DETAIL_FIELDS)) {
    const row = el('div', 'dt-field');
    const path = el('span', 'dt-path');
    path.textContent = field.path || '(value)';
    const value = el('span', `dt-value${jsonValueClass(field.value)}`);
    const text = fieldValueText(field.value);
    value.textContent = text;
    row.title = `${field.path} = ${text.slice(0, 1000)}\nClick to filter by this value`;
    row.append(path, value);
    if (field.path) {
      row.addEventListener('click', () => {
        const query: Query = { kind: 'field', expression: `${field.path}=${queryValue(field.value)}` };
        bar.setValue(query);
        startSearch(query, true);
      });
    }
    list.append(row);
  }
  detailsEl.append(list);
  if (fields.length > DETAIL_FIELDS) detailsEl.append(note(`Showing the first ${DETAIL_FIELDS} fields`));
  const pretty = el('pre', 'dt-json');
  const json = JSON.stringify(parsed.value, null, 2);
  const shown = json.length > DETAIL_JSON_CHARS ? `${json.slice(0, DETAIL_JSON_CHARS)}\n…` : json;
  appendMarked(pretty, shown, jsonMarks(shown, DETAIL_JSON_TOKENS));
  detailsEl.append(pretty);
}

// ---- search and filter ----

function startSearch(query: Query, jump: boolean): void {
  searchId++;
  searchState = undefined;
  currentHit = -1;
  currentHitLine = -1;
  resultCache.clear();
  pendingResultBlocks.clear();
  try {
    searchRegex = isTextQuery(query) && query.text ? compileQuery(query).regex : undefined;
  } catch {
    searchRegex = undefined; // the host reports the error
  }
  decorVersion++;
  const empty = isEmptyQuery(query);

  const mode: FilterMode = empty ? 'all' : (pendingFilter ?? viewMode);
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
  setResultsVisible(!empty);
  bar.setFilter(mode, !empty);
  autoJump = jump && !empty;
  saved.query = query;
  saved.filterMode = mode;
  saveState();
  post({ type: 'search', searchId, query, mode });
  renderSearchStatus();
  renderHeader();
  scheduleViewport(true);
}

function requestFilter(mode: FilterMode): void {
  if (!hasQuery() || !searchState) mode = 'all';
  if (mode === (pendingFilter ?? viewMode)) return;
  pendingFilter = mode;
  viewId++;
  bar.setFilter(mode, hasQuery());
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
  bar.setFilter(mode, hasQuery());
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
  if (!hasQuery()) {
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
      fileSize = msg.fileSize;
      renderFileInfo();
      break;
    case 'index': {
      // tail -f: follow new lines if the last row was visible
      const follow = msg.tail && viewMode === 'all' && list.isAtEnd;
      if (msg.tail && viewMode === 'all' && lineCount > 0) {
        // The last line may have been incomplete: read it again.
        lineCache.delete(lineCount - 1);
        pendingLineBlocks.delete(Math.floor((lineCount - 1) / LINE_BLOCK));
      }
      const prevCount = lineCount;
      if (msg.fileSize !== fileSize) {
        fileSize = msg.fileSize; // grows with tail
        renderFileInfo();
      }
      indexInfo = msg;
      lineCount = msg.lineCount;
      list.setGutterMax(Math.max(1, msg.lineCount));
      results.setGutterMax(Math.max(1, msg.lineCount));
      if (format.kind === 'dsv') alignTableHeader();
      if (viewMode === 'all') {
        list.setCount(msg.lineCount);
        if (follow) list.scrollToEnd();
        // Report the new row count even without scrolling (tail, re-index after rotation).
        if (prevCount !== msg.lineCount) scheduleViewport(msg.tail || msg.done);
      }
      renderHeader();
      if (restoreLine > 0 && viewMode === 'all' && (msg.lineCount > restoreLine || msg.done)) {
        list.scrollToLine(restoreLine);
        restoreLine = 0;
      }
      break;
    }
    case 'format':
      applyFormat(msg.format);
      break;
    case 'theme':
      // Editor JSON token colors; styles.css falls back to debug token colors without them.
      for (const kind of ['key', 'string', 'number', 'literal'] as const) {
        const color = msg.json[kind];
        if (color) document.documentElement.style.setProperty(`--bv-json-${kind}`, color);
        else document.documentElement.style.removeProperty(`--bv-json-${kind}`);
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
      if (format.kind === 'dsv') autoSizeColumns();
      list.invalidate();
      break;
    }
    case 'lineText':
      if (msg.reqId === detailRequest) renderDetails(msg);
      break;
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
    case 'reset':
      // The file was replaced (e.g. log rotation): everything shown is stale.
      errorEl.hidden = true;
      viewId++;
      lineCache.clear();
      pendingLineBlocks.clear();
      resultCache.clear();
      pendingResultBlocks.clear();
      list.refresh();
      list.setHighlight(-1);
      if (hasQuery()) startSearch(bar.value, false);
      break;
    case 'searchState': {
      if (msg.searchId !== searchId) break;
      // Rows added after the search had finished come from tail: follow them like the full view.
      const settled = searchState?.status === 'done';
      searchState = msg;
      results.setCount(msg.total);
      results.invalidate();
      if (viewMode !== 'all' && msg.mode === viewMode && pendingFilter === undefined && msg.viewCount !== viewCount) {
        const follow = settled && list.isAtEnd;
        if (settled && viewCount > 0) lineCache.delete(viewCount - 1);
        viewCount = msg.viewCount;
        list.setCount(viewCount);
        if (follow) list.scrollToEnd();
        scheduleViewport(msg.status === 'done');
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
    }
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
if (saved.query && !isEmptyQuery(saved.query)) startSearch(saved.query, false);
