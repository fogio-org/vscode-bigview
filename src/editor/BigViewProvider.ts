import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import htmlTemplate from '../../webview/index.html';
import { ChunkReader } from '../core/ChunkReader';
import type { FileHandlePool } from '../core/FileHandlePool';
import { LineIndex } from '../core/LineIndex';
import { FREE_FILE_SIZE_LIMIT, isPro } from '../license';
import { MAX_LINES_PER_MESSAGE, type HostToWebview, type WebviewToHost } from '../shared/protocol';
import type { IndexOutcome, WorkerPool } from '../workers/workerPool';

export class BigViewDocument implements vscode.CustomDocument {
  readonly index = new LineIndex();
  readonly reader: ChunkReader;
  /** Resolves when indexing ends (done, cancelled or failed — check `error`). */
  readonly indexed: Promise<IndexOutcome | undefined>;
  readonly openedAt = performance.now();
  /** Time the first batch of lines was sent to a webview (for first-render metrics). */
  firstLinesAt: number | undefined;
  error: string | undefined;
  fileSize: number;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly cancelIndexing: () => void;

  constructor(
    readonly uri: vscode.Uri,
    fileSize: number,
    private readonly pool: FileHandlePool,
    workers: WorkerPool,
    private readonly onDispose: () => void,
  ) {
    this.fileSize = fileSize;
    this.reader = new ChunkReader(pool, uri.fsPath, this.index);
    const task = workers.index(uri.fsPath, this.index, (size) => {
      this.fileSize = size;
      this.changeEmitter.fire();
    });
    this.cancelIndexing = () => task.cancel();
    this.indexed = task.result.catch((err: unknown) => {
      this.error = `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
      this.changeEmitter.fire();
      return undefined;
    });
  }

  dispose(): void {
    this.cancelIndexing();
    this.pool.close(this.uri.fsPath);
    this.changeEmitter.dispose();
    this.onDispose();
  }
}

export class BigViewProvider implements vscode.CustomReadonlyEditorProvider<BigViewDocument> {
  static readonly viewType = 'bigview.viewer';

  private readonly documents = new Set<BigViewDocument>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: FileHandlePool,
    private readonly workers: WorkerPool,
  ) {}

  /** Open document for `uri`, if any. Used by commands and integration tests. */
  findDocument(uri: vscode.Uri): BigViewDocument | undefined {
    for (const doc of this.documents) if (doc.uri.toString() === uri.toString()) return doc;
    return undefined;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<BigViewDocument> {
    if (uri.scheme !== 'file') throw new Error('BigView supports local files only.');
    const stat = await fsp.stat(uri.fsPath);
    if (!stat.isFile()) throw new Error(`${uri.fsPath} is not a regular file.`);
    if (stat.size > FREE_FILE_SIZE_LIMIT && !isPro()) {
      throw new Error('Files larger than 200 MB require BigView Pro.');
    }
    const doc = new BigViewDocument(uri, stat.size, this.pool, this.workers, () => this.documents.delete(doc));
    this.documents.add(doc);
    return doc;
  }

  async resolveCustomEditor(doc: BigViewDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = renderHtml(webview, dist);

    let ready = false;
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
      });
      if (doc.error) post({ type: 'error', message: doc.error });
    };

    const subscriptions = [
      doc.onDidChange(postState),
      webview.onDidReceiveMessage((msg: WebviewToHost) => {
        switch (msg.type) {
          case 'ready':
            ready = true; // (re)sent whenever the webview (re)loads
            post({ type: 'init', fileName: path.basename(doc.uri.fsPath), fileSize: doc.fileSize });
            postState();
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
        }
      }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((d) => d.dispose()));
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
