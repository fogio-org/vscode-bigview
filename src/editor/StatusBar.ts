import * as vscode from 'vscode';
import { formatCount, statusBarText } from '../shared/format';
import { formatLabel } from '../shared/formats';
import type { BigViewEditor, BigViewProvider } from './BigViewProvider';

/** Shows file size, line count, index state and the format of the active BigView editor. */
export class BigViewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('bigview.status', vscode.StatusBarAlignment.Right, 100);
  private readonly formatItem = vscode.window.createStatusBarItem('bigview.format', vscode.StatusBarAlignment.Right, 99);
  private readonly subscription: vscode.Disposable;
  private docSubscription: vscode.Disposable | undefined;
  private visible = false;

  constructor(provider: BigViewProvider) {
    this.item.name = 'BigView';
    this.item.command = 'bigview.goToLine';
    this.formatItem.name = 'BigView Format';
    this.formatItem.command = 'bigview.changeFormat';
    this.formatItem.tooltip = 'Change the format BigView uses for this file';
    this.subscription = provider.onDidChangeActiveEditor((e) => this.track(e));
    this.track(provider.active);
  }

  /** Current text (for tests). Empty when hidden. */
  get text(): string {
    return this.visible ? this.item.text : '';
  }

  get formatText(): string {
    return this.visible ? this.formatItem.text : '';
  }

  dispose(): void {
    this.docSubscription?.dispose();
    this.subscription.dispose();
    this.item.dispose();
    this.formatItem.dispose();
  }

  private track(editor: BigViewEditor | undefined): void {
    this.docSubscription?.dispose();
    this.docSubscription = undefined;
    if (!editor) {
      this.visible = false;
      this.item.hide();
      this.formatItem.hide();
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
      const format = editor.doc.format;
      if (format) {
        this.formatItem.text = formatLabel(format);
        this.formatItem.show();
      } else {
        this.formatItem.hide();
      }
    };
    this.docSubscription = editor.doc.onDidChange(render);
    render();
    this.visible = true;
    this.item.show();
  }
}
