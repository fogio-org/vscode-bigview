import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import htmlTemplate from '../../webview/index.html';
import { ChunkReader } from '../core/ChunkReader';
import type { FileHandlePool } from '../core/FileHandlePool';
import { restoreLineIndex, type IndexStore } from '../core/IndexStore';
import { LineIndex } from '../core/LineIndex';
import { FREE_FILE_SIZE_LIMIT, isPro } from '../license';
import type { IndexSource, IndexState, StatusInfo } from '../shared/format';
import { MAX_LINES_PER_MESSAGE, type HostToWebview, type WebviewToHost } from '../shared/protocol';
import type { IndexOutcome, WorkerPool } from '../workers/workerPool';

export interface DocumentDeps {
  pool: FileHandlePool;
  workers: WorkerPool;
  store: IndexStore;
}

export class BigViewDocument implements vscode.CustomDocument {
  readonly index: LineIndex;
  readonly reader: ChunkReader;
  readonly source: IndexSource;
  state: IndexState;
  error: string | undefined;
  fileSize: number;
  readonly openedAt = performance.now();
  /** When the index became complete (loaded from cache or scanned). */
  readyAt: number | undefined;
  /** Time the first batch of lines was sent to a webview (for first-render metrics). */
  firstLinesAt: number | undefined;
  /** Resolves when indexing ends (check `state`). */
  readonly indexed: Promise<void>;
  /** Resolves after a freshly built index was written to disk (or skipped / failed). */
  readonly persisted: Promise<void>;
  persistError: string | undefined;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private cancelIndexing: () => void = () => undefined;

  static async open(uri: vscode.Uri, deps: DocumentDeps, onDispose: () => void): Promise<BigViewDocument> {
    if (uri.scheme !== 'file') throw new Error('BigView supports local files only.');
    const stat = await fsp.stat(uri.fsPath);
    if (!stat.isFile()) throw new Error(`${uri.fsPath} is not a regular file.`);
    if (stat.size > FREE_FILE_SIZE_LIMIT && !isPro()) {
      throw new Error('Files larger than 200 MB require BigView Pro.');
    }
    const cached = await restoreLineIndex(deps.store, deps.pool, uri.fsPath, stat);
    return new BigViewDocument(uri, stat.size, cached, deps, onDispose);
  }

  private constructor(
    readonly uri: vscode.Uri,
    fileSize: number,
    cached: LineIndex | undefined,
    private readonly deps: DocumentDeps,
    private readonly onDispose: () => void,
  ) {
    this.fileSize = fileSize;
    this.index = cached ?? new LineIndex();
    this.source = cached ? 'cache' : 'scan';
    this.reader = new ChunkReader(deps.pool, uri.fsPath, this.index);

    if (cached) {
      this.state = 'ready';
      this.readyAt = performance.now();
      this.indexed = Promise.resolve();
      this.persisted = Promise.resolve();
      return;
    }

    this.state = 'indexing';
    const task = deps.workers.index(uri.fsPath, this.index, (size) => {
      this.fileSize = size;
      this.changeEmitter.fire();
    });
    this.cancelIndexing = () => task.cancel();
    const outcome = task.result.then(
      (o) => {
        if (o.status === 'done') {
          this.state = 'ready';
          this.readyAt = performance.now();
        }
        this.changeEmitter.fire();
        return o;
      },
      (err: unknown) => {
        this.state = 'failed';
        this.error = `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
        this.changeEmitter.fire();
        return undefined;
      },
    );
    this.indexed = outcome.then(() => undefined);
    this.persisted = outcome.then((o) => (o?.status === 'done' ? this.persist(o) : undefined));
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

  dispose(): void {
    this.cancelIndexing();
    this.deps.pool.close(this.uri.fsPath);
    this.changeEmitter.dispose();
    this.onDispose();
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
      // User-facing reporting (e.g. disk full) comes with M6.
      this.persistError = String(err);
    }
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
  /** Scrolls to and highlights a 0-based line. */
  reveal(line: number): void;
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
    const post = (msg: HostToWebview): void => {
      if (ready) void webview.postMessage(msg);
    };
    const postState = (): void => {
      post({
        type: 'index',
        lineCount: doc.index.lineCount,
        bytesIndexed: doc.index.bytesIndexed,
        fileSize: doc.fileSize,
        done: doc.index.isComplete,
        source: doc.source,
      });
      if (doc.error) post({ type: 'error', message: doc.error });
    };

    const viewportEmitter = new vscode.EventEmitter<void>();
    const editor = {
      doc,
      panel,
      topLine: 0,
      visibleLines: 0,
      onDidChangeViewport: viewportEmitter.event,
      reveal: (line: number) => {
        if (ready) post({ type: 'reveal', line });
        else pendingReveal = line;
      },
    };
    this.editors.add(editor);

    const subscriptions: vscode.Disposable[] = [
      viewportEmitter,
      doc.onDidChange(postState),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.setActive(editor);
        else if (this.activeEditor === editor) this.setActive(undefined);
      }),
      webview.onDidReceiveMessage((msg: WebviewToHost) => {
        switch (msg.type) {
          case 'ready':
            ready = true; // (re)sent whenever the webview (re)loads
            post({ type: 'init', fileName: path.basename(doc.uri.fsPath), fileSize: doc.fileSize });
            postState();
            if (pendingReveal !== undefined) post({ type: 'reveal', line: pendingReveal });
            pendingReveal = undefined;
            break;
          case 'getLines': {
            const count = Math.min(msg.count, MAX_LINES_PER_MESSAGE);
            doc.reader.readLines(msg.start, count).then(
              (res) => {
                doc.firstLinesAt ??= performance.now();
                post({ type: 'lines', reqId: msg.reqId, start: res.start, lines: res.lines, truncated: res.truncated });
              },
              (err: unknown) => post({ type: 'error', message: `Read failed: ${String(err)}` }),
            );
            break;
          }
          case 'viewport':
            editor.topLine = msg.topLine;
            editor.visibleLines = msg.visibleLines;
            viewportEmitter.fire();
            break;
        }
      }),
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
