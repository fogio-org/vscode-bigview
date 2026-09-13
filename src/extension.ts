import * as vscode from 'vscode';
import { FileHandlePool } from './core/FileHandlePool';
import { BigViewProvider } from './editor/BigViewProvider';
import { WorkerPool } from './workers/workerPool';

/** Returned from `activate`; used by integration tests. */
export interface BigViewApi {
  provider: BigViewProvider;
}

export function activate(context: vscode.ExtensionContext): BigViewApi {
  const pool = new FileHandlePool();
  const workers = new WorkerPool(vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath);
  const provider = new BigViewProvider(context.extensionUri, pool, workers);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(BigViewProvider.viewType, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('bigview.openFile', openInBigView),
    { dispose: () => workers.dispose() },
    { dispose: () => pool.dispose() },
  );

  return { provider };
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

function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}
