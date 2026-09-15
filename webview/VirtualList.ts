/**
 * Virtualized list with fully virtual scrollbars (SPEC §3.5, §7.6). Used for the file lines and
 * for the search results.
 *
 * There is no native scroll container at all:
 * - Chromium clamps element heights (~33M px), so a spacer of `count * rowHeight` cannot work
 *   for big files;
 * - VS Code webviews on macOS use overlay scrollbars (zero width), which cannot be grabbed when
 *   content is drawn over them.
 *
 * The logical position (`virtualTop`, unscaled px) is changed by wheel, keyboard and our own
 * scrollbar thumbs. Only visible rows plus a buffer are in the DOM, and they are offset by at
 * most a few hundred pixels, so no element ever gets huge coordinates.
 */
import type { Range } from '../src/shared/searchQuery';
import { clamp, positionForThumbOffset, thumbGeometry, type ThumbGeometry } from './scrollMath';

/** A styled span of a row's text. Marks may overlap. */
export interface Mark {
  start: number;
  end: number;
  cls: string;
}

export interface RowData {
  text: string;
  truncated?: boolean;
  /** Search match ranges of `text` (UTF-16 offsets, ascending, non-overlapping). */
  ranges?: readonly Range[];
  /** Text was cut at the start: show an ellipsis. */
  cutStart?: boolean;
  /** Extra class of the row (e.g. log level). */
  cls?: string;
  /** Format decorations (e.g. log timestamp). */
  marks?: readonly Mark[];
  /** Table cells: rendered instead of `text` when the list has cell widths. */
  cells?: readonly string[];
  /** Search match ranges within each cell's own text (cell text differs from the raw line). */
  cellRanges?: ReadonlyArray<readonly Range[] | undefined>;
}

export interface VirtualListOptions {
  container: HTMLElement;
  /** Row content, undefined while not loaded. A row re-renders when the returned object changes. */
  getRow(index: number): RowData | undefined;
  /** Gutter label; defaults to the 1-based row number. */
  gutterText?(index: number): string;
  /** Called on every render with the buffered range [start, end) that should be loaded. */
  ensureRange(start: number, end: number): void;
  onScroll?(topRow: number): void;
  onRowClick?(index: number): void;
  className?: string;
  /** Focus the list when created. Default true. */
  autoFocus?: boolean;
  /** Table mode: widths of the cells of `RowData.cells`, px. */
  cellWidths?(): readonly number[] | undefined;
  /** Overrides the scrollable content width (px) computed from text length. */
  contentWidth?(): number | undefined;
  onHorizontalScroll?(left: number): void;
}

const DEFAULT_CELL_PX = 120;

const BUFFER_ROWS = 50;
const SCROLLBAR_PX = 14;
const TEXT_PADDING_PX = 12;
const GUTTER_PADDING_PX = 28;

type Axis = 'v' | 'h';

interface Row {
  gutter: HTMLDivElement;
  text: HTMLDivElement;
  index: number;
  /** Data last rendered; null forces a re-render. */
  data: RowData | undefined | null;
}

interface Drag {
  axis: Axis;
  pointerId: number;
  startClient: number;
  startOffset: number;
}

export class VirtualList {
  private readonly root: HTMLDivElement;
  private readonly view: HTMLDivElement;
  private readonly gutterLayer: HTMLDivElement;
  private readonly textLayer: HTMLDivElement;
  private readonly vbar: HTMLDivElement;
  private readonly vthumb: HTMLDivElement;
  private readonly hbar: HTMLDivElement;
  private readonly hthumb: HTMLDivElement;
  private readonly highlight: HTMLDivElement;
  private readonly rows: Row[] = [];

  private count = 0;
  private highlightIndex = -1;
  private virtualTop = 0;
  private scrollLeft = 0;
  private viewWidth = 0;
  private viewHeight = 0;
  private lineHeight = 20;
  private charWidth = 8;
  private measured = false;
  private gutterDigits = 0;
  private maxLineChars = 0;
  private hbarVisible = false;
  private drag: Drag | undefined;
  private frame = 0;
  private reportedLeft = -1;

  constructor(private readonly opts: VirtualListOptions) {
    this.root = el('div', opts.className ? `vl ${opts.className}` : 'vl');
    this.view = el('div', 'vl-view');
    this.view.tabIndex = 0;
    const gutter = el('div', 'vl-gutter');
    const text = el('div', 'vl-text');
    this.gutterLayer = el('div', 'vl-layer');
    this.textLayer = el('div', 'vl-layer');
    gutter.append(this.gutterLayer);
    text.append(this.textLayer);
    this.highlight = el('div', 'vl-highlight');
    this.highlight.hidden = true;
    this.view.append(this.highlight, gutter, text);

    this.vbar = el('div', 'vl-scrollbar vl-vbar');
    this.vthumb = el('div', 'vl-thumb');
    this.vbar.append(this.vthumb);
    this.hbar = el('div', 'vl-scrollbar vl-hbar');
    this.hthumb = el('div', 'vl-thumb');
    this.hbar.append(this.hthumb);
    this.hbar.hidden = true;

    this.root.append(this.view, this.vbar, this.hbar);
    opts.container.append(this.root);

    this.measureFont();
    this.root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.view.addEventListener('keydown', (e) => this.onKey(e));
    if (opts.onRowClick) this.view.addEventListener('click', (e) => this.onClick(e));
    this.bindScrollbar(this.vbar, this.vthumb, 'v');
    this.bindScrollbar(this.hbar, this.hthumb, 'h');
    new ResizeObserver(() => this.layout()).observe(this.root);
    this.layout();
    if (opts.autoFocus ?? true) this.view.focus();
  }

  get topLine(): number {
    return Math.floor(this.virtualTop / this.lineHeight);
  }

  get visibleLines(): number {
    return Math.max(1, Math.floor(this.viewHeight / this.lineHeight));
  }

  setCount(count: number): void {
    if (count === this.count) return;
    this.count = count;
    if (!this.opts.gutterText) this.setGutterMax(count);
    this.layout();
  }

  /** Sizes the gutter for labels up to `value`. */
  setGutterMax(value: number): void {
    const digits = String(Math.max(1, Math.floor(value))).length;
    if (digits === this.gutterDigits) return;
    this.gutterDigits = digits;
    this.root.style.setProperty('--vl-gutter-width', `${this.gutterWidth}px`);
    this.layout();
  }

  /** Call when row data changed (e.g. a batch arrived). */
  invalidate(): void {
    this.schedule();
  }

  /** Re-renders all rows even if getRow() returns the same objects (e.g. highlights changed). */
  refresh(): void {
    for (const row of this.rows) row.data = null;
    this.schedule();
  }

  scrollToLine(line: number): void {
    this.setScrollTop(line * this.lineHeight);
  }

  /**
   * Highlights `line` and scrolls it to about a third of the viewport (or only if it is not
   * visible, with `onlyIfHidden`). Always reports the viewport through onScroll.
   */
  revealLine(line: number, onlyIfHidden = false): void {
    const target = clamp(Math.floor(line), 0, Math.max(0, this.count - 1));
    this.highlightIndex = target;
    const y = target * this.lineHeight;
    const visible = y >= this.virtualTop && y + this.lineHeight <= this.virtualTop + this.viewHeight;
    if (!(onlyIfHidden && visible)) {
      const above = Math.floor(this.visibleLines / 3);
      this.virtualTop = clamp((target - above) * this.lineHeight, 0, this.maxScrollTop);
    }
    this.schedule();
    this.opts.onScroll?.(this.topLine);
  }

  /** Scrolls the minimum needed to show row `index`. */
  ensureVisible(index: number): void {
    const y = index * this.lineHeight;
    if (y < this.virtualTop) this.setScrollTop(y);
    else if (y + this.lineHeight > this.virtualTop + this.viewHeight) this.setScrollTop(y + this.lineHeight - this.viewHeight);
  }

  setHighlight(index: number): void {
    this.highlightIndex = index;
    this.schedule();
  }

  focus(): void {
    this.view.focus({ preventScroll: true });
  }

  /** Width of the line-number gutter, px. */
  get gutterPixels(): number {
    return this.gutterWidth;
  }

  /** Width of one monospace character, px. */
  get charPixels(): number {
    return this.charWidth;
  }

  get horizontalScroll(): number {
    return this.scrollLeft;
  }

  /** Recomputes sizes (e.g. after table column widths changed). */
  relayout(): void {
    this.layout();
  }

  // ---- geometry ----

  private get gutterWidth(): number {
    return Math.ceil(this.gutterDigits * this.charWidth) + GUTTER_PADDING_PX;
  }

  private get totalHeight(): number {
    return this.count * this.lineHeight;
  }

  private get maxScrollTop(): number {
    return Math.max(0, this.totalHeight - this.viewHeight);
  }

  private get textViewWidth(): number {
    return Math.max(0, this.viewWidth - this.gutterWidth);
  }

  private get contentWidth(): number {
    return this.opts.contentWidth?.() ?? Math.ceil(this.maxLineChars * this.charWidth) + TEXT_PADDING_PX * 2;
  }

  private get maxScrollLeft(): number {
    return Math.max(0, this.contentWidth - this.textViewWidth);
  }

  private thumb(axis: Axis): ThumbGeometry | undefined {
    return axis === 'v'
      ? thumbGeometry(this.totalHeight, this.viewHeight, this.virtualTop, this.viewHeight)
      : thumbGeometry(this.contentWidth, this.textViewWidth, this.scrollLeft, this.viewWidth);
  }

  /** Measures the monospace font; repeated once the list becomes visible if it was hidden. */
  private measureFont(): void {
    const probe = el('span', 'vl-probe');
    probe.textContent = 'X'.repeat(100);
    this.root.append(probe);
    const rect = probe.getBoundingClientRect();
    const fontSize = parseFloat(getComputedStyle(this.root).fontSize) || 13;
    probe.remove();
    this.measured = rect.width > 0;
    this.charWidth = rect.width > 0 ? rect.width / 100 : fontSize * 0.6;
    const lineHeight = Math.max(Math.round(fontSize * 1.5), Math.ceil(rect.height), 12);
    if (lineHeight !== this.lineHeight) {
      this.lineHeight = lineHeight;
      this.rows.forEach((row, k) => {
        row.gutter.style.top = row.text.style.top = `${k * lineHeight}px`;
      });
    }
    this.root.style.setProperty('--vl-line-height', `${this.lineHeight}px`);
    if (this.gutterDigits > 0) this.root.style.setProperty('--vl-gutter-width', `${this.gutterWidth}px`);
  }

  private layout(): void {
    if (!this.measured && this.root.clientWidth > 0) this.measureFont();
    this.viewWidth = Math.max(0, this.root.clientWidth - SCROLLBAR_PX);
    const needHbar = this.contentWidth > this.textViewWidth;
    if (needHbar !== this.hbarVisible) {
      this.hbarVisible = needHbar;
      this.hbar.hidden = !needHbar;
      this.root.classList.toggle('vl-has-hbar', needHbar);
    }
    this.viewHeight = Math.max(0, this.root.clientHeight - (needHbar ? SCROLLBAR_PX : 0));
    this.virtualTop = clamp(this.virtualTop, 0, this.maxScrollTop);
    this.scrollLeft = clamp(this.scrollLeft, 0, this.maxScrollLeft);
    this.schedule();
  }

  // ---- input ----

  private setScrollTop(top: number): void {
    const next = clamp(top, 0, this.maxScrollTop);
    if (next === this.virtualTop) return;
    this.virtualTop = next;
    this.schedule();
    this.opts.onScroll?.(this.topLine);
  }

  private setScrollLeft(left: number): void {
    const next = clamp(left, 0, this.maxScrollLeft);
    if (next === this.scrollLeft) return;
    this.scrollLeft = next;
    this.schedule();
  }

  private applyThumbOffset(axis: Axis, offset: number): void {
    if (axis === 'v') {
      this.setScrollTop(positionForThumbOffset(this.totalHeight, this.viewHeight, offset, this.viewHeight));
    } else {
      this.setScrollLeft(positionForThumbOffset(this.contentWidth, this.textViewWidth, offset, this.viewWidth));
    }
  }

  private bindScrollbar(bar: HTMLDivElement, thumb: HTMLDivElement, axis: Axis): void {
    const coord = (e: PointerEvent): number => (axis === 'v' ? e.clientY : e.clientX);

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const geo = this.thumb(axis);
      if (!geo) return;
      e.preventDefault();
      let startOffset = geo.offset;
      if (e.target !== thumb) {
        // Click on the track: jump so the thumb centers under the pointer, then keep dragging.
        const rect = bar.getBoundingClientRect();
        startOffset = coord(e) - (axis === 'v' ? rect.top : rect.left) - geo.size / 2;
        this.applyThumbOffset(axis, startOffset);
      }
      this.drag = { axis, pointerId: e.pointerId, startClient: coord(e), startOffset };
      bar.setPointerCapture(e.pointerId);
      thumb.classList.add('active');
      this.view.focus({ preventScroll: true });
    });

    const end = (e: PointerEvent): void => {
      if (this.drag?.axis !== axis || this.drag.pointerId !== e.pointerId) return;
      this.drag = undefined;
      thumb.classList.remove('active');
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    };

    bar.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.axis !== axis || d.pointerId !== e.pointerId) return;
      // The webview is an iframe: a release outside it may never reach us.
      if ((e.buttons & 1) === 0) {
        end(e);
        return;
      }
      this.applyThumbOffset(axis, d.startOffset + coord(e) - d.startClient);
    });
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    bar.addEventListener('lostpointercapture', end);
  }

  private onWheel(e: WheelEvent): void {
    if (e.ctrlKey) return; // pinch-zoom
    e.preventDefault();
    const unit = e.deltaMode === 1 ? this.lineHeight : e.deltaMode === 2 ? this.viewHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    if (dy !== 0) this.setScrollTop(this.virtualTop + dy);
    if (dx !== 0) this.setScrollLeft(this.scrollLeft + dx);
  }

  private onKey(e: KeyboardEvent): void {
    const page = Math.max(this.lineHeight, this.viewHeight - this.lineHeight);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': this.setScrollTop(this.virtualTop + this.lineHeight); break;
      case 'ArrowUp': this.setScrollTop(this.virtualTop - this.lineHeight); break;
      case 'PageDown': this.setScrollTop(this.virtualTop + page); break;
      case 'PageUp': this.setScrollTop(this.virtualTop - page); break;
      case 'Home': this.setScrollTop(0); break;
      case 'End': this.setScrollTop(this.maxScrollTop); break;
      case 'ArrowRight': this.setScrollLeft(this.scrollLeft + this.charWidth * 4); break;
      case 'ArrowLeft': this.setScrollLeft(this.scrollLeft - this.charWidth * 4); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  private onClick(e: MouseEvent): void {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return; // the user was selecting text
    const rect = this.view.getBoundingClientRect();
    const index = Math.floor((e.clientY - rect.top + this.virtualTop) / this.lineHeight);
    if (index >= 0 && index < this.count) this.opts.onRowClick?.(index);
  }

  // ---- rendering ----

  private schedule(): void {
    if (this.frame === 0) this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.frame = 0;
    const lh = this.lineHeight;
    const first = Math.floor(this.virtualTop / lh);
    const visible = Math.ceil(this.viewHeight / lh) + 1;
    const start = Math.max(0, first - BUFFER_ROWS);
    const end = Math.min(this.count, first + visible + BUFFER_ROWS);
    if (end > start) this.opts.ensureRange(start, end);

    const count = end - start;
    while (this.rows.length < count) this.rows.push(this.createRow(this.rows.length));

    let widest = this.maxLineChars;
    for (let k = 0; k < this.rows.length; k++) {
      const row = this.rows[k] as Row;
      if (k >= count) {
        if (row.index !== -1) {
          row.gutter.hidden = row.text.hidden = true;
          row.index = -1;
        }
        continue;
      }
      const index = start + k;
      const data = this.opts.getRow(index);
      if (row.index !== index) {
        row.gutter.hidden = row.text.hidden = false;
        row.index = index;
        row.data = null;
      }
      if (row.data !== data) {
        row.gutter.textContent = this.opts.gutterText ? this.opts.gutterText(index) : String(index + 1);
        renderRow(row.text, data, this.opts.cellWidths?.());
        row.data = data;
        if (data && data.text.length > widest) widest = data.text.length;
      }
    }
    if (widest !== this.maxLineChars) {
      this.maxLineChars = widest;
      this.layout(); // may show the horizontal scrollbar; schedules another frame
    }

    // Offset is at most ~BUFFER_ROWS rows: layers never get huge coordinates.
    const offsetY = start * lh - this.virtualTop;
    this.gutterLayer.style.transform = `translate3d(0, ${offsetY}px, 0)`;
    this.textLayer.style.transform = `translate3d(${-this.scrollLeft}px, ${offsetY}px, 0)`;
    if (this.scrollLeft !== this.reportedLeft) {
      this.reportedLeft = this.scrollLeft;
      this.opts.onHorizontalScroll?.(this.scrollLeft);
    }

    const hy = this.highlightIndex * lh - this.virtualTop;
    const showHighlight = this.highlightIndex >= 0 && this.highlightIndex < this.count && hy > -lh && hy < this.viewHeight;
    this.highlight.hidden = !showHighlight;
    if (showHighlight) this.highlight.style.transform = `translate3d(0, ${hy}px, 0)`;

    const vg = this.thumb('v');
    this.vthumb.hidden = !vg;
    if (vg) {
      this.vthumb.style.height = `${vg.size}px`;
      this.vthumb.style.transform = `translate3d(0, ${vg.offset}px, 0)`;
    }
    const hg = this.hbarVisible ? this.thumb('h') : undefined;
    this.hthumb.hidden = !hg;
    if (hg) {
      this.hthumb.style.width = `${hg.size}px`;
      this.hthumb.style.transform = `translate3d(${hg.offset}px, 0, 0)`;
    }
  }

  private createRow(k: number): Row {
    const gutter = el('div', 'vl-row');
    const text = el('div', 'vl-row');
    const top = `${k * this.lineHeight}px`;
    gutter.style.top = top;
    text.style.top = top;
    this.gutterLayer.append(gutter);
    this.textLayer.append(text);
    return { gutter, text, index: -1, data: null };
  }
}

function renderRow(node: HTMLDivElement, data: RowData | undefined, cellWidths: readonly number[] | undefined): void {
  node.className = `vl-row${data?.cls ? ` ${data.cls}` : ''}${data?.truncated ? ' truncated' : ''}`;
  node.textContent = '';
  if (data?.cells && cellWidths) {
    data.cells.forEach((cell, i) => {
      const span = el('span', 'vl-cell');
      span.style.width = `${cellWidths[i] ?? DEFAULT_CELL_PX}px`;
      appendMarked(span, cell, matchMarks(data.cellRanges?.[i]));
      node.append(span);
    });
    return;
  }
  const text = data?.text ?? '';
  if (data?.cutStart) node.append('…');
  appendMarked(node, text, [...matchMarks(data?.ranges), ...(data?.marks ?? [])]);
}

function matchMarks(ranges: readonly Range[] | undefined): Mark[] {
  return (ranges ?? []).map(([start, end]) => ({ start, end, cls: 'vl-match' }));
}

/** Appends `text` to `node`, wrapping marked pieces in spans with the classes of their marks. */
function appendMarked(node: HTMLElement, text: string, marks: readonly Mark[]): void {
  if (marks.length === 0) {
    node.append(text);
    return;
  }
  // Split at every mark boundary; each piece gets the classes of the marks covering it.
  const cuts = new Set<number>([0, text.length]);
  for (const m of marks) {
    cuts.add(clamp(m.start, 0, text.length));
    cuts.add(clamp(m.end, 0, text.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k] as number;
    const b = points[k + 1] as number;
    const classes = marks.filter((m) => m.start <= a && m.end >= b).map((m) => m.cls);
    if (classes.length === 0) {
      node.append(text.slice(a, b));
    } else {
      const span = el('span', classes.join(' '));
      span.textContent = text.slice(a, b);
      node.append(span);
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
