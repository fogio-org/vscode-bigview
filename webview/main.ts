import type { HostToWebview, WebviewToHost } from '../src/shared/protocol';
import './styles.css';
import { VirtualList, type LineEntry } from './VirtualList';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface SavedState {
  topLine: number;
}

/** Lines are requested in aligned blocks; always <= MAX_LINES_PER_MESSAGE. */
const BLOCK = 200;
const MAX_CACHED_LINES = 20_000;
const REQUEST_RETRY_MS = 10_000;

const vscode = acquireVsCodeApi();
const cache = new Map<number, LineEntry>();
/** block -> time requested */
const pendingBlocks = new Map<number, number>();
let reqSeq = 0;
let lineCount = 0;
let restoreLine = (vscode.getState() as SavedState | undefined)?.topLine ?? 0;

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const fileNameEl = $('file-name');
const fileInfoEl = $('file-info');
const statusEl = $('index-status');
const progressEl = $('progress');
const progressBarEl = $('progress-bar');
const errorEl = $('error');

const list = new VirtualList({
  container: $('viewport'),
  getLine: (line) => cache.get(line),
  ensureRange,
  onScroll: (topLine) => vscode.setState({ topLine } satisfies SavedState),
});

function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

function blockLoaded(block: number): boolean {
  const end = Math.min((block + 1) * BLOCK, lineCount);
  for (let i = block * BLOCK; i < end; i++) if (!cache.has(i)) return false;
  return true;
}

function ensureRange(start: number, end: number): void {
  const now = performance.now();
  for (let b = Math.floor(start / BLOCK); b <= Math.floor((end - 1) / BLOCK); b++) {
    if (blockLoaded(b)) continue;
    const sent = pendingBlocks.get(b);
    if (sent !== undefined && now - sent < REQUEST_RETRY_MS) continue;
    pendingBlocks.set(b, now);
    post({ type: 'getLines', reqId: ++reqSeq, start: b * BLOCK, count: BLOCK });
  }
}

function evict(): void {
  if (cache.size <= MAX_CACHED_LINES) return;
  const keepFrom = list.topLine - 2 * BLOCK;
  const keepTo = list.topLine + 4 * BLOCK;
  for (const line of cache.keys()) {
    if (cache.size <= MAX_CACHED_LINES * 0.75) break;
    if (line < keepFrom || line > keepTo) cache.delete(line);
  }
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      fileNameEl.textContent = msg.fileName;
      fileInfoEl.textContent = formatBytes(msg.fileSize);
      break;
    case 'index': {
      lineCount = msg.lineCount;
      list.setLineCount(msg.lineCount);
      const pct = msg.fileSize > 0 ? Math.floor((msg.bytesIndexed / msg.fileSize) * 100) : 100;
      const lines = `${msg.lineCount.toLocaleString()} lines`;
      statusEl.textContent = msg.done ? lines : `Indexing… ${pct}% · ${lines}`;
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
      msg.lines.forEach((text, i) => cache.set(msg.start + i, { text, truncated: truncated.has(i) }));
      pendingBlocks.delete(Math.floor(msg.start / BLOCK));
      evict();
      list.invalidate();
      break;
    }
    case 'error':
      errorEl.textContent = msg.message;
      errorEl.hidden = false;
      break;
  }
});

post({ type: 'ready' });
