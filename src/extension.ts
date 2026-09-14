import * as vscode from 'vscode';
import { FileHandlePool } from './core/FileHandlePool';
import { IndexStore } from './core/IndexStore';
import { BigViewProvider } from './editor/BigViewProvider';
import { BigViewStatusBar } from './editor/StatusBar';
import { formatCount } from './shared/format';
import { parseLineNumber } from './shared/lineNumber';
import { WorkerPool } from './workers/workerPool';

/** Returned from `activate`; used by integration tests. */
export interface BigViewApi {
  provider: BigViewProvider;
  store: IndexStore;
  statusBar: BigViewStatusBar;
}

export function activate(context: vscode.ExtensionContext): BigViewApi {
  const pool = new FileHandlePool();
  const workers = new WorkerPool(vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath);
  const store = new IndexStore(vscode.Uri.joinPath(context.globalStorageUri, 'index').fsPath);
  void store.cleanup();
  const provider = new BigViewProvider(context.extensionUri, { pool, workers, store });
  const statusBar = new BigViewStatusBar(provider);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(BigViewProvider.viewType, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('bigview.openFile', openInBigView),
    vscode.commands.registerCommand('bigview.goToLine', (line?: unknown) => goToLine(provider, line)),
    vscode.commands.registerCommand('bigview.find', () => provider.active?.runCommand('find')),
    vscode.commands.registerCommand('bigview.findNext', () => provider.active?.runCommand('findNext')),
    vscode.commands.registerCommand('bigview.findPrevious', () => provider.active?.runCommand('findPrevious')),
    statusBar,
    provider,
    { dispose: () => workers.dispose() },
    { dispose: () => pool.dispose() },
  );

  return { provider, store, statusBar };
}

export function deactivate(): void {
  // Resources are released through context.subscriptions.
}

async function openInBigView(uri?: unknown): Promise<void> {
  let target = uri instanceof vscode.Uri ? uri : activeTabUri();
  if (!target) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open in BigView' });
    target = picked?.[0];
  }
  if (!target) return;
  await vscode.commands.executeCommand('vscode.openWith', target, BigViewProvider.viewType);
}

/** Go to a 1-based line; prompts when `line` is not given. */
async function goToLine(provider: BigViewProvider, line?: unknown): Promise<void> {
  const editor = provider.active;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a file in BigView to use Go to Line.');
    return;
  }
  const lineCount = (): number => editor.doc.index.lineCount;
  let target = typeof line === 'number' ? line : undefined;
  if (target === undefined) {
    const input = await vscode.window.showInputBox({
      title: 'Go to Line',
      prompt: `Line number, 1 – ${formatCount(lineCount())}${editor.doc.state === 'indexing' ? ' (still indexing)' : ''}`,
      validateInput: (v) =>
        v.trim() === '' || parseLineNumber(v, lineCount()) !== undefined
          ? undefined
          : `Enter a line number between 1 and ${formatCount(lineCount())}`,
    });
    if (input === undefined) return;
    target = parseLineNumber(input, lineCount());
  }
  if (target === undefined || lineCount() === 0) return;
  editor.reveal(Math.min(Math.max(1, Math.floor(target)), lineCount()) - 1);
}

function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}
