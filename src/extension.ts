import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeFsError } from './core/errors';
import { FileHandlePool } from './core/FileHandlePool';
import { IndexStore } from './core/IndexStore';
import { BigViewProvider } from './editor/BigViewProvider';
import { BigViewStatusBar } from './editor/StatusBar';
import { isPro } from './license';
import { formatBytes, formatCount } from './shared/format';
import { formatLabel, type FormatChoice, type FormatInfo, type FormatKind } from './shared/formats';
import { parseLineNumber } from './shared/lineNumber';
import { WorkerPool, type ExportOutcome } from './workers/workerPool';

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
  const formats = {
    get: (filePath: string) => context.workspaceState.get<FormatChoice>(`bigview.format:${filePath}`),
    set: (filePath: string, choice: FormatChoice | undefined) => context.workspaceState.update(`bigview.format:${filePath}`, choice),
  };
  const provider = new BigViewProvider(context.extensionUri, { pool, workers, store, formats });
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
    vscode.commands.registerCommand('bigview.toggleFilter', () => provider.active?.runCommand('toggleFilter')),
    vscode.commands.registerCommand('bigview.toggleInvert', () => provider.active?.runCommand('toggleInvert')),
    vscode.commands.registerCommand('bigview.exportFiltered', (target?: unknown) => exportFiltered(provider, workers, target)),
    vscode.commands.registerCommand('bigview.changeFormat', (choice?: unknown) => changeFormat(provider, choice)),
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

const FORMAT_KINDS: readonly FormatKind[] = ['text', 'log', 'jsonl', 'dsv'];

/** Accepts 'auto', a kind ('log', 'jsonl', 'text', 'dsv', 'csv', 'tsv') or a FormatChoice. */
function parseFormatArg(arg: unknown): FormatChoice | 'auto' | undefined {
  if (arg === 'auto') return 'auto';
  if (arg === 'csv') return { kind: 'dsv', delimiter: ',' };
  if (arg === 'tsv') return { kind: 'dsv', delimiter: '\t' };
  if (typeof arg === 'string' && (FORMAT_KINDS as readonly string[]).includes(arg)) return { kind: arg as FormatKind };
  if (arg && typeof arg === 'object' && FORMAT_KINDS.includes((arg as FormatChoice).kind)) {
    const { kind, delimiter } = arg as FormatChoice;
    return delimiter === undefined ? { kind } : { kind, delimiter };
  }
  return undefined;
}

/** BigView: Change Format… (SPEC §6 M5: manual format switching). */
async function changeFormat(provider: BigViewProvider, arg?: unknown): Promise<FormatInfo | undefined> {
  const editor = provider.active;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a file in BigView to change its format.');
    return undefined;
  }
  let choice = parseFormatArg(arg);
  if (choice === undefined) {
    const current = editor.doc.format;
    const isCurrent = (c: FormatChoice): boolean =>
      current?.source === 'user' && current.kind === c.kind && (c.kind !== 'dsv' || current.delimiter === c.delimiter);
    const options: Array<{ label: string; choice: FormatChoice }> = [
      { label: 'Log', choice: { kind: 'log' } },
      { label: 'JSON Lines', choice: { kind: 'jsonl' } },
      { label: 'CSV (comma-separated)', choice: { kind: 'dsv', delimiter: ',' } },
      { label: 'TSV (tab-separated)', choice: { kind: 'dsv', delimiter: '\t' } },
      { label: 'Semicolon-separated', choice: { kind: 'dsv', delimiter: ';' } },
      { label: 'Pipe-separated', choice: { kind: 'dsv', delimiter: '|' } },
      { label: 'Plain text', choice: { kind: 'text' } },
    ];
    const items: Array<vscode.QuickPickItem & { choice: FormatChoice | 'auto' }> = [
      {
        label: 'Auto-detect',
        description: current && current.source !== 'user' ? `current: ${formatLabel(current)}` : undefined,
        choice: 'auto',
      },
      ...options.map((o) => ({ label: o.label, description: isCurrent(o.choice) ? 'current' : undefined, choice: o.choice })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'BigView: Change Format', placeHolder: 'Show this file as…' });
    if (!picked) return undefined;
    choice = picked.choice;
  }
  return editor.doc.setFormat(choice === 'auto' ? undefined : choice);
}

export interface ExportResult {
  target: vscode.Uri;
  mode: 'matches' | 'nonMatches';
  lines: number;
  bytes: number;
  elapsedMs: number;
}

/**
 * BigView: Export Filtered Lines. Writes the lines selected by the filter (matching lines, or
 * non-matching ones when inverted) to a new file, streaming in a worker. `target` skips the
 * save dialog (used by tests).
 */
async function exportFiltered(provider: BigViewProvider, workers: WorkerPool, target?: unknown): Promise<ExportResult | undefined> {
  const editor = provider.active;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a file in BigView to export lines.');
    return undefined;
  }
  if (!isPro()) {
    void vscode.window.showWarningMessage('Exporting lines requires BigView Pro.');
    return undefined;
  }
  const search = editor.search;
  if (!search.state.query) {
    void vscode.window.showInformationMessage('Search first: the export writes the lines selected by the search filter.');
    return undefined;
  }
  let state = search.state;
  if (state.status === 'running') {
    state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'BigView: waiting for the search to finish…' },
      () => search.whenSettled(),
    );
  }
  if (state.status !== 'done') {
    void vscode.window.showErrorMessage(`Cannot export: ${state.error ?? 'the search did not finish'}.`);
    return undefined;
  }
  const selection = search.exportSelection();
  if (!selection) return undefined;
  if (selection.count === 0) {
    void vscode.window.showInformationMessage('No lines to export.');
    return undefined;
  }

  const source = editor.doc.uri.fsPath;
  const describe = selection.mode === 'matches' ? 'matching' : 'non-matching';
  let dest = target instanceof vscode.Uri ? target : undefined;
  if (!dest) {
    const parsed = path.parse(source);
    const suffix = selection.mode === 'matches' ? 'filtered' : 'excluded';
    dest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.${suffix}${parsed.ext}`)),
      saveLabel: 'Export',
      title: `Export ${formatCount(selection.count)} ${describe} lines`,
    });
    if (!dest) return undefined;
  }
  if (dest.scheme !== 'file') {
    void vscode.window.showErrorMessage('BigView can only export to local files.');
    return undefined;
  }
  const destPath = dest.fsPath;
  if ((await realPath(destPath)) === (await realPath(source))) {
    void vscode.window.showErrorMessage('Cannot export into the file being viewed.');
    return undefined;
  }

  const started = performance.now();
  let outcome: ExportOutcome;
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `BigView: exporting ${formatCount(selection.count)} ${describe} lines`,
        cancellable: true,
      },
      async (progress, token) => {
        let reported = 0;
        const task = workers.exportLines(
          { source, target: destPath, words: selection.words, invert: selection.mode === 'nonMatches', lineCount: selection.lineCount },
          (bytesRead, fileSize, linesWritten) => {
            const pct = fileSize > 0 ? (bytesRead / fileSize) * 100 : 100;
            progress.report({ increment: pct - reported, message: `${formatCount(linesWritten)} lines written` });
            reported = pct;
          },
        );
        token.onCancellationRequested(() => task.cancel());
        return task.result;
      },
    );
  } catch (err) {
    await fsp.rm(destPath, { force: true });
    void vscode.window.showErrorMessage(`Export failed. ${describeFsError(err, destPath, 'export')}`);
    return undefined;
  }
  if (outcome.status === 'cancelled') {
    await fsp.rm(destPath, { force: true });
    return undefined;
  }

  const result: ExportResult = {
    target: dest,
    mode: selection.mode,
    lines: outcome.linesWritten,
    bytes: outcome.bytesWritten,
    elapsedMs: performance.now() - started,
  };
  if (!(target instanceof vscode.Uri)) {
    const exported = dest;
    void vscode.window
      .showInformationMessage(`Exported ${formatCount(result.lines)} lines (${formatBytes(result.bytes)}) to ${path.basename(destPath)}.`, 'Open')
      .then((choice) => {
        if (choice === 'Open') void vscode.commands.executeCommand('vscode.open', exported);
      });
  }
  return result;
}

async function realPath(p: string): Promise<string> {
  return fsp.realpath(p).catch(() => path.resolve(p));
}

function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}
