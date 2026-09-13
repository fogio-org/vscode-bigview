/** Formatting shared by the extension host and the webview. */

export type IndexState = 'indexing' | 'ready' | 'failed';
export type IndexSource = 'cache' | 'scan';

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export interface StatusInfo {
  fileSize: number;
  lineCount: number;
  bytesIndexed: number;
  state: IndexState;
  source: IndexSource;
}

export function indexStateLabel(s: StatusInfo): string {
  switch (s.state) {
    case 'indexing': {
      const pct = s.fileSize > 0 ? Math.floor((s.bytesIndexed / s.fileSize) * 100) : 100;
      return `Indexing ${pct}%`;
    }
    case 'failed':
      return 'Index failed';
    case 'ready':
      return s.source === 'cache' ? 'Index cached' : 'Indexed';
  }
}

/** Status bar text (uses VS Code codicons). */
export function statusBarText(s: StatusInfo): string {
  const icon = s.state === 'indexing' ? '$(sync~spin)' : s.state === 'failed' ? '$(error)' : s.source === 'cache' ? '$(database)' : '$(check)';
  return `${formatBytes(s.fileSize)} · ${formatCount(s.lineCount)} lines · ${icon} ${indexStateLabel(s)}`;
}
