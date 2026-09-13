import * as vscode from 'vscode';
import { formatCount, statusBarText } from '../shared/format';
import type { BigViewEditor, BigViewProvider } from './BigViewProvider';

/** Shows file size, line count and index state for the active BigView editor. */
export class BigViewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('bigview.status', vscode.StatusBarAlignment.Right, 100);
  private readonly subscription: vscode.Disposable;
  private docSubscription: vscode.Disposable | undefined;

  constructor(provider: BigViewProvider) {
    this.item.name = 'BigView';
    this.item.command = 'bigview.goToLine';
    this.subscription = provider.onDidChangeActiveEditor((e) => this.track(e));
    this.track(provider.active);
  }

  /** Current text (for tests). Empty when hidden. */
  get text(): string {
    return this.visible ? this.item.text : '';
  }

  private visible = false;

  dispose(): void {
    this.docSubscription?.dispose();
    this.subscription.dispose();
    this.item.dispose();
  }

  private track(editor: BigViewEditor | undefined): void {
    this.docSubscription?.dispose();
    this.docSubscription = undefined;
    if (!editor) {
      this.visible = false;
      this.item.hide();
      return;
    }
    const render = (): void => {
      const s = editor.doc.status;
      this.item.text = statusBarText(s);
      this.item.tooltip =
        `${editor.doc.uri.fsPath}\n` +
        `Index: ${formatCount(editor.doc.index.anchorCount)} anchors, stride ${editor.doc.index.stride}` +
        (s.source === 'cache' ? ' (loaded from disk)' : '') +
        '\nClick to go to line';
    };
    this.docSubscription = editor.doc.onDidChange(render);
    render();
    this.visible = true;
    this.item.show();
  }
}
