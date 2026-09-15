/**
 * JSON token colors of the active color theme (see core/textmateTheme.ts). The theme is found
 * among installed extensions by its id or label, its file (and `include` chain) is read, and the
 * user's `editor.tokenColorCustomizations` are applied on top.
 */
import * as vscode from 'vscode';
import {
  customizationRules,
  jsonColorsFromRules,
  parseJsonc,
  type JsonTokenColors,
  type ThemeFile,
  type TokenRule,
} from '../core/textmateTheme';

/** Theme files are small; anything larger is not a theme. */
const MAX_THEME_BYTES = 4 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 8;

let cache: { key: string; colors: Promise<JsonTokenColors> } | undefined;

export function jsonTokenColors(): Promise<JsonTokenColors> {
  const themeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  const custom = vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations');
  const key = JSON.stringify([themeName, vscode.window.activeColorTheme.kind, custom]);
  if (cache?.key !== key) {
    const colors = resolveJsonTokenColors(themeName, custom).catch(() => ({}));
    cache = { key, colors };
  }
  return cache.colors;
}

/** Uncached; throws if the theme file cannot be read (exported for tests). */
export async function resolveJsonTokenColors(themeName: string | undefined, custom: unknown): Promise<JsonTokenColors> {
  const file = themeName ? findThemeFile(themeName) : undefined;
  const rules = file ? await loadRules(file, 0) : [];
  return jsonColorsFromRules([...rules, ...customizationRules(custom, themeName)]);
}

function findThemeFile(themeName: string): vscode.Uri | undefined {
  // Built-in themes are declared as "Dark Modern" etc. but settings still use the legacy
  // "Default Dark Modern" names, which VS Code maps itself.
  const names = [themeName, themeName.replace(/^Default /, '')];
  for (const name of names) {
    for (const ext of vscode.extensions.all) {
      const themes = (ext.packageJSON as { contributes?: { themes?: Array<{ id?: string; label?: string; path?: string }> } })
        .contributes?.themes;
      const theme = themes?.find((t) => t.id === name || t.label === name);
      if (theme?.path) return vscode.Uri.joinPath(ext.extensionUri, theme.path);
    }
  }
  return undefined;
}

async function loadRules(uri: vscode.Uri, depth: number): Promise<TokenRule[]> {
  if (depth > MAX_INCLUDE_DEPTH) return [];
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_THEME_BYTES) return [];
  // eslint-disable-next-line no-restricted-syntax -- a color theme file (size-checked above), not a user file
  const bytes = await vscode.workspace.fs.readFile(uri);
  const theme = parseJsonc(new TextDecoder().decode(bytes)) as ThemeFile;
  const included = theme.include ? await loadRules(vscode.Uri.joinPath(uri, '..', theme.include), depth + 1).catch(() => []) : [];
  // `tokenColors` may also name a .tmTheme file (legacy themes): not supported, keep the fallback colors.
  return [...included, ...(Array.isArray(theme.tokenColors) ? theme.tokenColors : [])];
}
