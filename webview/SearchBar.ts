/**
 * Search input with Match Case / Whole Word / Regex toggles, hit counter and progress line.
 *
 * F3 / Shift+F3 / Ctrl+F are VS Code keybindings (the webview forwards every keydown to the
 * workbench), so only keys that VS Code does not bind in this context are handled here.
 */
import { EMPTY_QUERY, type SearchQuery } from '../src/shared/searchQuery';

export interface SearchBarHandlers {
  onQuery(query: SearchQuery): void;
  onNext(): void;
  onPrevious(): void;
  onEscape(): void;
}

export interface SearchStatusView {
  /** 0–100 while searching. */
  progress?: number;
  error?: string;
  canNavigate: boolean;
}

/** Typing is debounced (SPEC §7.8). */
const DEBOUNCE_MS = 250;

type OptionKey = 'caseSensitive' | 'wholeWord' | 'regex';

const TOGGLES: Array<{ key: OptionKey; label: string; title: string; code: string }> = [
  { key: 'caseSensitive', label: 'Aa', title: 'Match Case (Alt+C)', code: 'KeyC' },
  { key: 'wholeWord', label: 'ab', title: 'Match Whole Word (Alt+W)', code: 'KeyW' },
  { key: 'regex', label: '.*', title: 'Use Regular Expression (Alt+R)', code: 'KeyR' },
];

export class SearchBar {
  private readonly input: HTMLInputElement;
  private readonly field: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly progress: HTMLDivElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly toggles = new Map<OptionKey, HTMLButtonElement>();
  private query: SearchQuery;
  /** Last query handed to onQuery, serialized. */
  private emitted: string;
  private timer = 0;

  constructor(
    root: HTMLElement,
    initial: SearchQuery | undefined,
    private readonly handlers: SearchBarHandlers,
  ) {
    this.query = { ...EMPTY_QUERY, ...initial };
    this.emitted = JSON.stringify(this.query);

    this.field = el('div', 'sb-field');
    this.input = el('input', 'sb-input');
    this.input.id = 'search-input';
    this.input.type = 'text';
    this.input.placeholder = 'Search entire file';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Search entire file');
    this.field.append(this.input);
    for (const t of TOGGLES) {
      const button = el('button', `sb-toggle sb-${t.key}`);
      button.textContent = t.label;
      button.title = t.title;
      button.addEventListener('click', () => this.toggle(t.key));
      this.toggles.set(t.key, button);
      this.field.append(button);
    }

    this.count = el('span', 'sb-count');
    this.count.id = 'search-count';
    this.prev = button('↑', 'Previous Match (Shift+F3)', () => this.navigate(-1));
    this.next = button('↓', 'Next Match (F3)', () => this.navigate(1));
    this.progress = el('div', 'sb-progress');
    root.append(this.field, this.count, this.prev, this.next, this.progress);

    this.input.addEventListener('input', () => {
      this.query = { ...this.query, text: this.input.value };
      this.schedule();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.render();
  }

  get value(): SearchQuery {
    return { ...this.query };
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** Replaces the query without emitting onQuery (the caller runs it). */
  setValue(query: SearchQuery): void {
    window.clearTimeout(this.timer);
    this.query = { ...query };
    this.emitted = JSON.stringify(this.query);
    this.render();
  }

  setStatus(text: string, view: SearchStatusView): void {
    this.count.textContent = text;
    this.count.title = view.error ?? '';
    this.count.classList.toggle('error', view.error !== undefined);
    this.field.classList.toggle('invalid', view.error !== undefined);
    this.progress.hidden = view.progress === undefined;
    this.progress.style.width = `${view.progress ?? 0}%`;
    this.prev.disabled = this.next.disabled = !view.canNavigate;
  }

  private render(): void {
    if (this.input.value !== this.query.text) this.input.value = this.query.text;
    for (const [key, b] of this.toggles) b.setAttribute('aria-pressed', String(this.query[key]));
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
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
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
    this.query = { ...this.query, [key]: !this.query[key] };
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
    const key = JSON.stringify(this.query);
    if (key === this.emitted) return false;
    this.emitted = key;
    this.handlers.onQuery(this.value);
    return true;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'sb-button');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
