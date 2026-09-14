/**
 * Search bar: query kind (text search, log time range, JSON field filter), inputs, Match Case /
 * Whole Word / Regex toggles, hit counter, navigation, filter buttons and progress line.
 *
 * F3 / Shift+F3 / Ctrl+F are VS Code keybindings (the webview forwards every keydown to the
 * workbench), so only keys that VS Code does not bind in this context are handled here.
 */
import type { FormatKind } from '../src/shared/formats';
import type { FilterMode } from '../src/shared/protocol';
import { EMPTY_QUERY, isTextQuery, type Query, type SearchQuery } from '../src/shared/searchQuery';

export interface SearchBarHandlers {
  onQuery(query: Query): void;
  onNext(): void;
  onPrevious(): void;
  onEscape(): void;
  onFilter(mode: FilterMode): void;
}

export interface SearchStatusView {
  /** 0–100 while searching. */
  progress?: number;
  error?: string;
  canNavigate: boolean;
}

export type QueryKind = 'text' | 'time' | 'field';

/** Typing is debounced (SPEC §7.8). */
const DEBOUNCE_MS = 250;

type OptionKey = 'caseSensitive' | 'wholeWord' | 'regex';

const TOGGLES: Array<{ key: OptionKey; label: string; title: string; code: string }> = [
  { key: 'caseSensitive', label: 'Aa', title: 'Match Case (Alt+C)', code: 'KeyC' },
  { key: 'wholeWord', label: 'ab', title: 'Match Whole Word (Alt+W)', code: 'KeyW' },
  { key: 'regex', label: '.*', title: 'Use Regular Expression (Alt+R)', code: 'KeyR' },
];

const KINDS: Array<{ kind: QueryKind; label: string; format?: FormatKind }> = [
  { kind: 'text', label: 'Text' },
  { kind: 'time', label: 'Time range', format: 'log' },
  { kind: 'field', label: 'Field', format: 'jsonl' },
];

export class SearchBar {
  private readonly kindSelect: HTMLSelectElement;
  private readonly textField: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly toggles = new Map<OptionKey, HTMLButtonElement>();
  private readonly timeField: HTMLDivElement;
  private readonly fromInput: HTMLInputElement;
  private readonly toInput: HTMLInputElement;
  private readonly fieldField: HTMLDivElement;
  private readonly exprInput: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private readonly progress: HTMLDivElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly filterButton: HTMLButtonElement;
  private readonly invertButton: HTMLButtonElement;

  private kind: QueryKind = 'text';
  private text: SearchQuery = { ...EMPTY_QUERY };
  private time = { from: '', to: '' };
  private expression = '';
  private format: FormatKind = 'text';
  private mode: FilterMode = 'all';
  /** Last query handed to onQuery, serialized. */
  private emitted: string;
  private timer = 0;

  constructor(
    root: HTMLElement,
    initial: Query | undefined,
    private readonly handlers: SearchBarHandlers,
  ) {
    if (initial) this.load(initial);

    this.kindSelect = el('select', 'sb-kind');
    this.kindSelect.title = 'Query type';
    for (const k of KINDS) {
      const option = el('option', '');
      option.value = k.kind;
      option.textContent = k.label;
      this.kindSelect.append(option);
    }
    this.kindSelect.addEventListener('change', () => {
      this.kind = this.kindSelect.value as QueryKind;
      this.render();
      this.flush();
      this.focus();
    });

    this.textField = el('div', 'sb-field');
    this.input = textInput('sb-input', 'Search entire file');
    this.input.id = 'search-input';
    this.textField.append(this.input);
    for (const t of TOGGLES) {
      const b = el('button', `sb-toggle sb-${t.key}`);
      b.textContent = t.label;
      b.title = t.title;
      b.addEventListener('click', () => this.toggle(t.key));
      this.toggles.set(t.key, b);
      this.textField.append(b);
    }

    this.timeField = el('div', 'sb-field sb-time');
    this.fromInput = textInput('sb-input sb-from', 'From, e.g. 2026-01-01 10:00');
    this.toInput = textInput('sb-input sb-to', 'To, e.g. 2026-01-01 10:30:00');
    const dash = el('span', 'sb-dash');
    dash.textContent = '–';
    this.timeField.append(this.fromInput, dash, this.toInput);

    this.fieldField = el('div', 'sb-field sb-expr');
    this.exprInput = textInput('sb-input sb-expression', 'field=value or field~regex, e.g. level=error');
    this.fieldField.append(this.exprInput);

    this.count = el('span', 'sb-count');
    this.count.id = 'search-count';
    this.prev = button('↑', 'Previous Match (Shift+F3)', () => this.navigate(-1));
    this.next = button('↓', 'Next Match (F3)', () => this.navigate(1));
    this.progress = el('div', 'sb-progress');
    this.filterButton = button('Filter', 'Show only matching lines', () => this.handlers.onFilter(this.mode === 'all' ? 'matches' : 'all'));
    this.invertButton = button('Invert', 'Show only lines that do not match', () =>
      this.handlers.onFilter(this.mode === 'nonMatches' ? 'matches' : 'nonMatches'),
    );
    this.filterButton.classList.add('sb-mode', 'sb-filter');
    this.invertButton.classList.add('sb-mode', 'sb-invert');
    root.append(
      this.kindSelect,
      this.textField,
      this.timeField,
      this.fieldField,
      this.count,
      this.prev,
      this.next,
      this.filterButton,
      this.invertButton,
      this.progress,
    );

    this.input.addEventListener('input', () => {
      this.text = { ...this.text, text: this.input.value };
      this.schedule();
    });
    this.fromInput.addEventListener('input', () => {
      this.time = { ...this.time, from: this.fromInput.value };
      this.schedule();
    });
    this.toInput.addEventListener('input', () => {
      this.time = { ...this.time, to: this.toInput.value };
      this.schedule();
    });
    this.exprInput.addEventListener('input', () => {
      this.expression = this.exprInput.value;
      this.schedule();
    });
    for (const i of [this.input, this.fromInput, this.toInput, this.exprInput]) i.addEventListener('keydown', (e) => this.onKey(e));

    this.emitted = JSON.stringify(this.value);
    this.setFilter('all', false);
    this.render();
  }

  get value(): Query {
    switch (this.kind) {
      case 'text':
        return { ...this.text };
      case 'time':
        return { kind: 'time', from: this.time.from, to: this.time.to };
      case 'field':
        return { kind: 'field', expression: this.expression };
    }
  }

  focus(): void {
    const input = this.kind === 'text' ? this.input : this.kind === 'time' ? this.fromInput : this.exprInput;
    input.focus();
    input.select();
  }

  /** Replaces the query without emitting onQuery (the caller runs it). */
  setValue(query: Query): void {
    window.clearTimeout(this.timer);
    this.load(query);
    this.emitted = JSON.stringify(this.value);
    this.render();
  }

  /** Offers the query kinds that fit the file format; falls back to text search otherwise. */
  setFormat(format: FormatKind): void {
    this.format = format;
    if (!this.available(this.kind)) {
      this.kind = 'text';
      this.render();
      this.flush();
    } else {
      this.render();
    }
  }

  setStatus(text: string, view: SearchStatusView): void {
    this.count.textContent = text;
    this.count.title = view.error ?? '';
    this.count.classList.toggle('error', view.error !== undefined);
    for (const f of [this.textField, this.timeField, this.fieldField]) f.classList.toggle('invalid', view.error !== undefined);
    this.progress.hidden = view.progress === undefined;
    this.progress.style.width = `${view.progress ?? 0}%`;
    this.prev.disabled = this.next.disabled = !view.canNavigate;
  }

  /** Reflects the filter mode; the buttons are enabled only while there is a query. */
  setFilter(mode: FilterMode, enabled: boolean): void {
    this.mode = mode;
    this.filterButton.setAttribute('aria-pressed', String(mode !== 'all'));
    this.invertButton.setAttribute('aria-pressed', String(mode === 'nonMatches'));
    this.filterButton.disabled = this.invertButton.disabled = !enabled;
  }

  private available(kind: QueryKind): boolean {
    const format = KINDS.find((k) => k.kind === kind)?.format;
    return format === undefined || format === this.format;
  }

  private load(query: Query): void {
    if (isTextQuery(query)) {
      this.kind = 'text';
      this.text = { ...query };
    } else if (query.kind === 'time') {
      this.kind = 'time';
      this.time = { from: query.from, to: query.to };
    } else {
      this.kind = 'field';
      this.expression = query.expression;
    }
  }

  private render(): void {
    let offered = 0;
    for (const option of this.kindSelect.options) {
      const ok = this.available(option.value as QueryKind);
      option.disabled = !ok;
      option.hidden = !ok;
      if (ok) offered++;
    }
    this.kindSelect.hidden = offered < 2 && this.kind === 'text';
    this.kindSelect.value = this.kind;
    this.textField.hidden = this.kind !== 'text';
    this.timeField.hidden = this.kind !== 'time';
    this.fieldField.hidden = this.kind !== 'field';
    if (this.input.value !== this.text.text) this.input.value = this.text.text;
    if (this.fromInput.value !== this.time.from) this.fromInput.value = this.time.from;
    if (this.toInput.value !== this.time.to) this.toInput.value = this.time.to;
    if (this.exprInput.value !== this.expression) this.exprInput.value = this.expression;
    for (const [key, b] of this.toggles) b.setAttribute('aria-pressed', String(this.text[key]));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!this.flush()) {
        if (e.shiftKey) this.handlers.onPrevious();
        else this.handlers.onNext();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.handlers.onEscape();
    } else if (this.kind === 'text' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = TOGGLES.find((x) => x.code === e.code);
      if (t) {
        e.preventDefault();
        this.toggle(t.key);
      }
    }
  }

  private navigate(direction: 1 | -1): void {
    if (this.flush()) return;
    if (direction > 0) this.handlers.onNext();
    else this.handlers.onPrevious();
  }

  private toggle(key: OptionKey): void {
    this.text = { ...this.text, [key]: !this.text[key] };
    this.render();
    this.flush();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  /** Emits the query if it changed; returns whether it did. */
  private flush(): boolean {
    window.clearTimeout(this.timer);
    const key = JSON.stringify(this.value);
    if (key === this.emitted) return false;
    this.emitted = key;
    this.handlers.onQuery(this.value);
    return true;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textInput(className: string, placeholder: string): HTMLInputElement {
  const input = el('input', className);
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.setAttribute('aria-label', placeholder);
  return input;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'sb-button');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
