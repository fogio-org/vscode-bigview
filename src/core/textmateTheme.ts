/**
 * Resolves the colors a VS Code color theme gives JSON tokens, so JSON Lines rows in the webview
 * look like JSON in the editor. Webviews only get workbench colors as CSS variables, not token
 * colors, hence this small TextMate theme matcher. Pure; the host reads the theme files.
 */
import type { JsonTokenKind } from '../formats/jsonHighlight';

export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

export interface ThemeFile {
  include?: string;
  tokenColors?: TokenRule[] | string;
}

export type JsonTokenColors = Partial<Record<JsonTokenKind, string>>;

/** Scope stacks the built-in JSON grammar assigns (outermost first). */
export const JSON_SCOPES: Record<JsonTokenKind, readonly string[]> = {
  key: ['source.json', 'meta.structure.dictionary.json', 'string.json', 'support.type.property-name.json'],
  string: ['source.json', 'meta.structure.dictionary.json', 'meta.structure.dictionary.value.json', 'string.quoted.double.json'],
  number: ['source.json', 'meta.structure.dictionary.json', 'meta.structure.dictionary.value.json', 'constant.numeric.json'],
  literal: ['source.json', 'meta.structure.dictionary.json', 'meta.structure.dictionary.value.json', 'constant.language.json'],
};

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses JSON with comments and trailing commas (theme files are JSONC). */
export function parseJsonc(text: string): unknown {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Pass 1: drop comments. Pass 2: drop commas before `}` / `]` (a comment may sit in between).
  return JSON.parse(scanOutsideStrings(scanOutsideStrings(src, stripComment), stripTrailingComma));
}

/** Handles the text outside string literals: returns [text to emit, next index]. */
type Scanner = (src: string, i: number) => [string, number];

function scanOutsideStrings(src: string, onChar: Scanner): string {
  let out = '';
  const n = src.length;
  for (let i = 0; i < n; ) {
    if (src[i] === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      const [emit, next] = onChar(src, i);
      out += emit;
      i = next;
    }
  }
  return out;
}

const stripComment: Scanner = (src, i) => {
  if (src[i] === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return ['', end === -1 ? src.length : end];
  }
  if (src[i] === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return [' ', end === -1 ? src.length : end + 2];
  }
  return [src[i] as string, i + 1];
};

const stripTrailingComma: Scanner = (src, i) => {
  if (src[i] !== ',') return [src[i] as string, i + 1];
  let j = i + 1;
  while (j < src.length && /\s/.test(src[j] as string)) j++;
  return [src[j] === '}' || src[j] === ']' ? '' : ',', i + 1];
};

const partMatches = (part: string, scope: string): boolean => scope === part || scope.startsWith(`${part}.`);

/**
 * Score of a selector (`a.b c.d`, descendant parts separated by spaces) against a scope stack, or
 * undefined if it does not apply. Deeper matches win, then more specific (longer) parts.
 */
function selectorScore(selector: string, stack: readonly string[]): number | undefined {
  const parts = (selector.split(' - ')[0] ?? '').trim().split(/\s+/).filter((p) => p && p !== '>');
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    if (!partMatches(last, stack[depth] as string)) continue;
    let k = depth - 1;
    let ok = true;
    for (let p = parts.length - 2; p >= 0 && ok; p--) {
      while (k >= 0 && !partMatches(parts[p] as string, stack[k] as string)) k--;
      if (k < 0) ok = false;
      k--;
    }
    if (ok) return (depth + 1) * 10_000 + last.split('.').length * 100 + parts.length;
  }
  return undefined;
}

/** Foreground of the most specific rule for `stack`; later rules win ties. */
export function resolveForeground(rules: readonly TokenRule[], stack: readonly string[]): string | undefined {
  let best: { score: number; color: string } | undefined;
  for (const rule of rules) {
    const color = rule.settings?.foreground;
    if (typeof color !== 'string' || !COLOR.test(color) || rule.scope === undefined) continue;
    const selectors = (Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',')).map((s) => String(s));
    for (const selector of selectors) {
      const score = selectorScore(selector, stack);
      if (score !== undefined && (!best || score >= best.score)) best = { score, color };
    }
  }
  return best?.color;
}

export function jsonColorsFromRules(rules: readonly TokenRule[]): JsonTokenColors {
  const out: JsonTokenColors = {};
  for (const kind of Object.keys(JSON_SCOPES) as JsonTokenKind[]) {
    const color = resolveForeground(rules, JSON_SCOPES[kind]);
    if (color) out[kind] = color;
  }
  return out;
}

const SIMPLE_CUSTOMIZATIONS: Record<string, string> = {
  strings: 'string',
  numbers: 'constant.numeric',
  keywords: 'keyword',
  comments: 'comment',
  types: 'entity.name.type',
  functions: 'entity.name.function',
  variables: 'variable',
};

/** Rules from the `editor.tokenColorCustomizations` setting (global and `[Theme Name]` sections). */
export function customizationRules(custom: unknown, themeName: string | undefined): TokenRule[] {
  const rules: TokenRule[] = [];
  const add = (section: unknown): void => {
    if (!section || typeof section !== 'object') return;
    const s = section as Record<string, unknown>;
    for (const [key, scope] of Object.entries(SIMPLE_CUSTOMIZATIONS)) {
      const v = s[key];
      const foreground = typeof v === 'string' ? v : (v as { foreground?: unknown } | undefined)?.foreground;
      if (typeof foreground === 'string') rules.push({ scope, settings: { foreground } });
    }
    if (Array.isArray(s.textMateRules)) rules.push(...(s.textMateRules as TokenRule[]));
  };
  add(custom);
  if (themeName && custom && typeof custom === 'object') add((custom as Record<string, unknown>)[`[${themeName}]`]);
  return rules;
}
