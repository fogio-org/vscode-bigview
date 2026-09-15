import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import htmlTemplate from '../../webview/index.html';
import { BINARY_SAMPLE_BYTES, looksBinary } from '../core/binary';
import { ChunkReader, type ChunkReaderOptions } from '../core/ChunkReader';
import { describeFsError, isStorageError } from '../core/errors';
import type { FileHandlePool } from '../core/FileHandlePool';
import { restoreLineIndex, type IndexStore } from '../core/IndexStore';
import { LineIndex, LineStartScanner } from '../core/LineIndex';
import { FREE_FILE_SIZE_LIMIT, isPro } from '../license';
import type { IndexSource, IndexState, StatusInfo } from '../shared/format';
import { detectFormat, type FormatChoice, type FormatInfo, type FormatKind } from '../shared/formats';
import {
  MAX_DETAIL_BYTES,
  MAX_LINES_PER_MESSAGE,
  type FilterMode,
  type HostToWebview,
  type WebviewCommand,
  type WebviewToHost,
} from '../shared/protocol';
import type { Query } from '../shared/searchQuery';
import type { IndexOutcome, WorkerPool } from '../workers/workerPool';
import { SearchController } from './SearchController';
import { jsonTokenColors } from './themeColors';
import { snapshotOf, TailWatcher, type FileSnapshot } from './TailWatcher';

/** Remembers the format chosen by the user per file. */
export interface FormatStore {
  get(filePath: string): FormatChoice | undefined;
  set(filePath: string, choice: FormatChoice | undefined): Thenable<void>;
}

export interface DocumentDeps {
  pool: FileHandlePool;
  workers: WorkerPool;
  store: IndexStore;
  formats: FormatStore;
  /** Stat poll interval of the tail watcher. */
  tailPollMs?: number;
}

/** Lines sampled for format detection (SPEC §5 formats.ts). */
const FORMAT_SAMPLE_LINES = 50;
/** Appends larger than this are indexed by a full rebuild in the worker instead of on the host. */
const TAIL_MAX_APPEND_BYTES = 64 * 1024 * 1024;
const TAIL_READ_BYTES = 1024 * 1024;

let warnedAboutIndexCache = false;

export class BigViewDocument implements vscode.CustomDocument {
  readonly index: LineIndex;
  readonly reader: ChunkReader;
  source: IndexSource;
  state: IndexState;
  error: string | undefined;
  fileSize: number;
  readonly openedAt = performance.now();
  /** When the index became complete (loaded from cache or scanned). */
  readyAt: number | undefined;
  /** Time the first batch of lines was sent to a webview (for first-render metrics). */
  firstLinesAt: number | undefined;
  /** Resolves when the first indexing ends (check `state`). */
  readonly indexed: Promise<void>;
  /** Resolves after a freshly built index was written to disk (or skipped / failed). */
  readonly persisted: Promise<void>;
  persistError: string | undefined;
  /** Undefined until the first lines are available. */
  format: FormatInfo | undefined;
  /** Incremented each time lines appended to the file were added to the index (tail). */
  tailGeneration = 0;
  /** Incremented each time the index was rebuilt because the file was replaced. */
  resetGeneration = 0;

  private formatOverride: FormatChoice | undefined;
  private formatGeneration = 0;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  /** The file was replaced (rotation, truncation): everything derived from its lines is stale. */
  readonly onDidReset = this.resetEmitter.event;
  private cancelIndexing: () => void = () => undefined;
  private fileIno: number;
  private deleted = false;
  private disposed = false;
  private watcher: TailWatcher | undefined;
  /** File changes are handled one at a time. */
  private queue: Promise<void> = Promise.resolve();

  static async open(uri: vscode.Uri, deps: DocumentDeps, onDispose: () => void): Promise<BigViewDocument> {
    if (uri.scheme !== 'file') throw new Error('BigView supports local files only.');
    const filePath = uri.fsPath;
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      throw new Error(describeFsError(err, filePath, 'open'));
    }
    if (!stat.isFile()) throw new Error(`${path.basename(filePath)} is not a regular file.`);
    if (stat.size > FREE_FILE_SIZE_LIMIT && !isPro()) {
      throw new Error('Files larger than 200 MB require BigView Pro.');
    }
    let head: Buffer;
    try {
      head = await deps.pool.read(filePath, 0, Math.min(stat.size, BINARY_SAMPLE_BYTES));
    } catch (err) {
      deps.pool.close(filePath);
      throw new Error(describeFsError(err, filePath, 'open'));
    }
    if (looksBinary(head)) {
      deps.pool.close(filePath);
      const message = `${path.basename(filePath)} looks like a binary file (it contains NUL bytes). BigView shows text files only.`;
      void vscode.window.showWarningMessage(message, 'Open in Text Editor').then((choice) => {
        if (choice) void vscode.commands.executeCommand('vscode.openWith', uri, 'default');
      });
      throw new Error(message);
    }
    const cached = await restoreLineIndex(deps.store, deps.pool, filePath, stat);
    return new BigViewDocument(uri, { size: stat.size, ino: stat.ino }, cached, deps, onDispose);
  }

  private constructor(
    readonly uri: vscode.Uri,
    stat: { size: number; ino: number },
    cached: LineIndex | undefined,
    private readonly deps: DocumentDeps,
    private readonly onDispose: () => void,
  ) {
    this.fileSize = stat.size;
    this.fileIno = stat.ino;
    this.formatOverride = deps.formats.get(uri.fsPath);
    this.index = cached ?? new LineIndex();
    this.source = cached ? 'cache' : 'scan';
    this.reader = new ChunkReader(deps.pool, uri.fsPath, this.index);

    if (cached) {
      this.state = 'ready';
      this.readyAt = performance.now();
      this.indexed = Promise.resolve();
      this.persisted = Promise.resolve();
    } else {
      this.state = 'indexing';
      const outcome = this.runIndexer();
      this.indexed = outcome.then(() => undefined);
      this.persisted = outcome.then((o) => (o?.status === 'done' ? this.persist(o) : undefined));
    }
    void this.detectFormat();
    void this.indexed.then(() => this.startWatching());
  }

  get status(): StatusInfo {
    return {
      fileSize: this.fileSize,
      lineCount: this.index.lineCount,
      bytesIndexed: this.index.bytesIndexed,
      state: this.state,
      source: this.source,
    };
  }

  /** A separate reader (own read-ahead block) over the same index. */
  createReader(opts: ChunkReaderOptions = {}): ChunkReader {
    return new ChunkReader(this.deps.pool, this.uri.fsPath, this.index, opts);
  }

  createSearchWorker(): ReturnType<WorkerPool['createSearchWorker']> {
    return this.deps.workers.createSearchWorker();
  }

  /** Whether the byte before `offset` is `\n` (i.e. `offset` starts a line). */
  async startsLine(offset: number): Promise<boolean> {
    if (offset <= 0) return true;
    const b = await this.deps.pool.read(this.uri.fsPath, offset - 1, 1);
    return b[0] === 0x0a;
  }

  /** Sets (or with undefined, clears) the user's format choice; remembered per file. */
  async setFormat(choice: FormatChoice | undefined): Promise<FormatInfo | undefined> {
    this.formatOverride = choice;
    await this.deps.formats.set(this.uri.fsPath, choice);
    await this.detectFormat();
    return this.format;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.cancelIndexing();
    this.deps.pool.close(this.uri.fsPath);
    this.changeEmitter.dispose();
    this.resetEmitter.dispose();
    this.onDispose();
  }

  // ---- indexing ----

  private runIndexer(): Promise<IndexOutcome | undefined> {
    const filePath = this.uri.fsPath;
    const task = this.deps.workers.index(filePath, this.index, (size) => {
      this.fileSize = size;
      this.changeEmitter.fire();
    });
    this.cancelIndexing = () => task.cancel();
    return task.result.then(
      (o) => {
        if (o.status === 'done') {
          this.state = 'ready';
          this.readyAt = performance.now();
          this.fileSize = o.fileSize;
        }
        this.changeEmitter.fire();
        return o;
      },
      (err: unknown) => {
        this.state = 'failed';
        this.error = `Indexing failed. ${describeFsError(err, filePath, 'read')}`;
        this.changeEmitter.fire();
        return undefined;
      },
    );
  }

  private async persist(o: Extract<IndexOutcome, { status: 'done' }>): Promise<void> {
    try {
      // Do not cache an index of a file that changed while it was being scanned.
      const now = await fsp.stat(this.uri.fsPath);
      if (now.size !== o.fileSize || now.mtimeMs !== o.mtimeMs) return;
      await this.deps.store.save(this.uri.fsPath, {
        fileSize: o.fileSize,
        mtimeMs: o.mtimeMs,
        stride: this.index.stride,
        anchors: this.index.toFloat64Array(),
      });
    } catch (err) {
      this.persistError = describeFsError(err, this.deps.store.pathFor(this.uri.fsPath), 'write');
      if (isStorageError(err) && !warnedAboutIndexCache) {
        warnedAboutIndexCache = true;
        void vscode.window.showWarningMessage(
          `BigView could not save its index cache. ${this.persistError} Files stay usable but are indexed again each time they are opened.`,
        );
      }
    }
  }

  // ---- tail -f and rotation (SPEC §6 M6) ----

  private startWatching(): void {
    // Tail is a future Pro feature (SPEC §3.9).
    if (this.disposed || !isPro()) return;
    this.watcher = new TailWatcher(this.uri.fsPath, (snap) => this.enqueue(() => this.sync(snap)), this.deps.tailPollMs);
    // The file may have changed while it was being indexed.
    this.enqueue(async () => this.sync(await snapshotOf(this.uri.fsPath)));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      if (this.disposed) return;
      this.error = describeFsError(err, this.uri.fsPath, 'read');
      this.changeEmitter.fire();
    });
  }

  private async sync(snap: FileSnapshot | undefined): Promise<void> {
    if (this.disposed || this.state === 'indexing') return;
    if (!snap) {
      if (!this.deleted) {
        this.deleted = true;
        this.error = `${path.basename(this.uri.fsPath)} was deleted or moved. BigView reloads it if it comes back.`;
        this.changeEmitter.fire();
      }
      return;
    }
    const replaced = this.deleted || snap.ino !== this.fileIno || snap.size < this.index.bytesIndexed || this.state === 'failed';
    if (replaced || snap.size - this.index.bytesIndexed > TAIL_MAX_APPEND_BYTES) {
      await this.reindex(snap);
    } else if (snap.size > this.index.bytesIndexed) {
      await this.extend(snap.size);
    }
  }

  /** Indexes the bytes appended after the indexed part. */
  private async extend(newSize: number): Promise<void> {
    const filePath = this.uri.fsPath;
    const from = this.index.bytesIndexed;
    const terminated = await this.startsLine(from);
    const scanner = new LineStartScanner({ resume: this.index.resumeState(terminated) });
    let pos = from;
    let lastByte = terminated ? 0x0a : -1;
    while (pos < newSize) {
      const buf = await this.deps.pool.read(filePath, pos, Math.min(TAIL_READ_BYTES, newSize - pos));
      if (buf.length === 0 || this.disposed) break;
      scanner.scan(buf);
      lastByte = buf[buf.length - 1] as number;
      pos += buf.length;
    }
    if (pos === from || this.disposed) return;
    const lineCount = lastByte === 0x0a ? scanner.linesStarted - 1 : scanner.linesStarted;
    this.index.extend(scanner.take(), { stride: scanner.stride, linesStarted: scanner.linesStarted, bytesIndexed: pos, lineCount });
    this.fileSize = pos;
    this.tailGeneration++;
    this.changeEmitter.fire();
  }

  /** Rebuilds the index from scratch: the file was truncated, replaced, recreated or grew a lot. */
  private async reindex(snap: FileSnapshot): Promise<void> {
    this.cancelIndexing();
    this.deleted = false;
    this.error = undefined;
    this.fileIno = snap.ino;
    this.fileSize = snap.size;
    this.deps.pool.close(this.uri.fsPath); // a cached handle may still point at the old file
    this.index.reset();
    this.state = 'indexing';
    this.source = 'scan';
    this.readyAt = undefined;
    this.resetGeneration++;
    this.resetEmitter.fire();
    this.changeEmitter.fire();
    const outcome = await this.runIndexer();
    if (outcome?.status === 'done') void this.persist(outcome);
  }

  // ---- format ----

  private async detectFormat(): Promise<void> {
    const generation = ++this.formatGeneration;
    await this.waitForLines(FORMAT_SAMPLE_LINES);
    let sample: string[] = [];
    try {
      sample = (await this.reader.readLines(0, FORMAT_SAMPLE_LINES)).lines;
    } catch {
      // unreadable: fall back to plain text
    }
    if (generation !== this.formatGeneration || this.disposed) return;
    this.format = detectFormat(path.basename(this.uri.fsPath), sample, this.formatOverride);
    this.changeEmitter.fire();
  }

  private waitForLines(count: number): Promise<void> {
    return new Promise((resolve) => {
      const ready = (): boolean => this.index.lineCount >= count || this.state !== 'indexing';
      if (ready()) {
        resolve();
        return;
      }
      const sub = this.changeEmitter.event(() => {
        if (ready()) {
          sub.dispose();
          resolve();
        }
      });
    });
  }
}

/** One webview panel showing a document. */
export interface BigViewEditor {
  readonly doc: BigViewDocument;
  readonly panel: vscode.WebviewPanel;
  /** First visible line (0-based), as last reported by the webview. */
  readonly topLine: number;
  readonly visibleLines: number;
  readonly onDidChangeViewport: vscode.Event<void>;
  readonly search: SearchController;
  /** Rows in the webview list and its filter mode, as last reported by the webview. */
  readonly rowCount: number;
  readonly viewMode: FilterMode;
  /** Format the webview renders, as last reported. */
  readonly viewFormat: FormatKind;
  /** Scrolls to and highlights a 0-based file line. */
  reveal(line: number): void;
  /** Forwards a keybinding command (find, find next/previous, filter toggles) to the webview. */
  runCommand(command: WebviewCommand): void;
  /** Types `query` into the webview search bar and runs it. */
  setQuery(query: Query): void;
  /** Switches the webview filter as if its buttons were used. */
  setFilterMode(mode: FilterMode): void;
  /** Handles a message as if it came from the webview (also used by integration tests). */
  dispatch(msg: WebviewToHost): void;
}

export class BigViewProvider implements vscode.CustomReadonlyEditorProvider<BigViewDocument>, vscode.Disposable {
  static readonly viewType = 'bigview.viewer';

  private readonly documents = new Set<BigViewDocument>();
  private readonly editors = new Set<BigViewEditor>();
  private activeEditor: BigViewEditor | undefined;
  private readonly activeEmitter = new vscode.EventEmitter<BigViewEditor | undefined>();
  readonly onDidChangeActiveEditor = this.activeEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: DocumentDeps,
  ) {}

  get active(): BigViewEditor | undefined {
    return this.activeEditor;
  }

  /** Open document for `uri`, if any. Used by commands and integration tests. */
  findDocument(uri: vscode.Uri): BigViewDocument | undefined {
    for (const doc of this.documents) if (doc.uri.toString() === uri.toString()) return doc;
    return undefined;
  }

  editorsFor(doc: BigViewDocument): BigViewEditor[] {
    return [...this.editors].filter((e) => e.doc === doc);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<BigViewDocument> {
    const doc = await BigViewDocument.open(uri, this.deps, () => this.documents.delete(doc));
    this.documents.add(doc);
    return doc;
  }

  async resolveCustomEditor(doc: BigViewDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = renderHtml(webview, dist);

    let ready = false;
    let pendingReveal: number | undefined;
    let lastFormat: FormatInfo | undefined;
    let lastTail = doc.tailGeneration;
    const post = (msg: HostToWebview): void => {
      if (ready) void webview.postMessage(msg);
    };

    const viewportEmitter = new vscode.EventEmitter<void>();
    const search = new SearchController(doc, () => doc.createSearchWorker(), post);

    const postState = (): void => {
      const tail = doc.tailGeneration !== lastTail;
      lastTail = doc.tailGeneration;
      if (tail) search.onFileGrew();
      post({
        type: 'index',
        lineCount: doc.index.lineCount,
        bytesIndexed: doc.index.bytesIndexed,
        fileSize: doc.fileSize,
        done: doc.index.isComplete,
        source: doc.source,
        tail,
      });
      if (doc.error) post({ type: 'error', message: doc.error });
      if (ready && doc.format && doc.format !== lastFormat) {
        lastFormat = doc.format;
        post({ type: 'format', format: doc.format });
      }
    };

    const postTheme = (): void => {
      void jsonTokenColors().then((json) => post({ type: 'theme', json }));
    };

    const postReveal = (line: number): void =>
      post({ type: 'reveal', line, viewIndex: search.viewIndexOfLine(line), mode: search.mode });

    const editor = {
      doc,
      panel,
      search,
      topLine: 0,
      visibleLines: 0,
      rowCount: 0,
      viewMode: 'all' as FilterMode,
      viewFormat: 'text' as FormatKind,
      onDidChangeViewport: viewportEmitter.event,
      reveal: (line: number) => {
        if (ready) postReveal(line);
        else pendingReveal = line;
      },
      runCommand: (command: WebviewCommand) => post({ type: 'command', command }),
      setQuery: (query: Query) => post({ type: 'setQuery', query }),
      setFilterMode: (mode: FilterMode) => post({ type: 'setFilterMode', mode }),
      dispatch: (msg: WebviewToHost) => {
        switch (msg.type) {
          case 'ready':
            ready = true; // (re)sent whenever the webview (re)loads
            lastFormat = undefined;
            lastTail = doc.tailGeneration;
            search.reset();
            post({ type: 'init', fileName: path.basename(doc.uri.fsPath), fileSize: doc.fileSize });
            postState();
            postTheme();
            if (pendingReveal !== undefined) postReveal(pendingReveal);
            pendingReveal = undefined;
            break;
          case 'getLines': {
            if (msg.mode !== 'all') {
              search.sendViewLines(msg);
              break;
            }
            const count = Math.min(msg.count, MAX_LINES_PER_MESSAGE);
            doc.reader.readLines(msg.start, count).then(
              (res) => {
                doc.firstLinesAt ??= performance.now();
                post({ type: 'lines', reqId: msg.reqId, viewId: msg.viewId, start: res.start, lines: res.lines, truncated: res.truncated });
              },
              (err: unknown) => post({ type: 'error', message: describeFsError(err, doc.uri.fsPath, 'read') }),
            );
            break;
          }
          case 'viewport':
            editor.topLine = msg.topLine;
            editor.visibleLines = msg.visibleLines;
            editor.rowCount = msg.rowCount;
            editor.viewMode = msg.mode;
            editor.viewFormat = msg.format;
            viewportEmitter.fire();
            break;
          case 'search':
            search.start(msg.searchId, msg.query, msg.mode);
            break;
          case 'getLineText':
            doc.reader.readLineText(msg.line, MAX_DETAIL_BYTES).then(
              (r) => post({ type: 'lineText', reqId: msg.reqId, line: msg.line, text: r.text, truncated: r.truncated }),
              (err: unknown) =>
                post({
                  type: 'lineText',
                  reqId: msg.reqId,
                  line: msg.line,
                  text: '',
                  truncated: false,
                  error: describeFsError(err, doc.uri.fsPath, 'read'),
                }),
            );
            break;
          case 'setFilter':
            search.setFilter(msg.searchId, msg.viewId, msg.mode, msg.anchorIndex);
            break;
          case 'getResults':
            search.sendResults(msg.searchId, msg.reqId, msg.start, msg.count);
            break;
          case 'gotoHit':
            search.gotoHit(msg.searchId, msg.target);
            break;
        }
      },
    };
    this.editors.add(editor);

    const subscriptions: vscode.Disposable[] = [
      viewportEmitter,
      search,
      doc.onDidChange(postState),
      vscode.window.onDidChangeActiveColorTheme(postTheme),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.colorTheme') || e.affectsConfiguration('editor.tokenColorCustomizations')) postTheme();
      }),
      doc.onDidReset(() => {
        search.reset();
        lastTail = doc.tailGeneration;
        post({ type: 'reset' });
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.setActive(editor);
        else if (this.activeEditor === editor) this.setActive(undefined);
      }),
      webview.onDidReceiveMessage((msg: WebviewToHost) => editor.dispatch(msg)),
    ];
    if (panel.active) this.setActive(editor);

    panel.onDidDispose(() => {
      this.editors.delete(editor);
      if (this.activeEditor === editor) this.setActive(undefined);
      subscriptions.forEach((d) => d.dispose());
    });
  }

  dispose(): void {
    this.activeEmitter.dispose();
  }

  private setActive(editor: BigViewEditor | undefined): void {
    if (this.activeEditor === editor) return;
    this.activeEditor = editor;
    this.activeEmitter.fire(editor);
  }
}

function renderHtml(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const values: Record<string, string> = {
    cspSource: webview.cspSource,
    nonce,
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
  };
  return htmlTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
