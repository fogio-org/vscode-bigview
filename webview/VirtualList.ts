/**
 * Virtualized line list with fully virtual scrollbars (SPEC §3.5, §7.6).
 *
 * There is no native scroll container at all:
 * - Chromium clamps element heights (~33M px), so a spacer of `lineCount * lineHeight`
 *   cannot work for big files;
 * - VS Code webviews on macOS use overlay scrollbars (zero width), which cannot be grabbed
 *   when content is drawn over them.
 *
 * The logical position (`virtualTop`, unscaled px) is changed by wheel, keyboard and our own
 * scrollbar thumbs. Only visible rows plus a buffer are in the DOM, and they are offset by at
 * most a few hundred pixels, so no element ever gets huge coordinates.
 */
import { clamp, positionForThumbOffset, thumbGeometry, type ThumbGeometry } from './scrollMath';

export interface LineEntry {
  text: string;
  truncated: boolean;
}

export interface VirtualListOptions {
  container: HTMLElement;
  getLine(line: number): LineEntry | undefined;
  /** Called on every render with the buffered range [start, end) that should be loaded. */
  ensureRange(start: number, end: number): void;
  onScroll?(topLine: number): void;
}

const BUFFER_LINES = 50;
const SCROLLBAR_PX = 14;
const TEXT_PADDING_PX = 12;
const GUTTER_PADDING_PX = 28;

type Axis = 'v' | 'h';

interface Row {
  gutter: HTMLDivElement;
  text: HTMLDivElement;
  line: number;
  content: string | undefined;
  truncated: boolean;
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
  private readonly rows: Row[] = [];
  private readonly highlight: HTMLDivElement;

  private lineCount = 0;
  private highlightLine = -1;
  private virtualTop = 0;
  private scrollLeft = 0;
  private viewWidth = 0;
  private viewHeight = 0;
  private lineHeight = 20;
  private charWidth = 8;
  private gutterDigits = 0;
  private maxLineChars = 0;
  private hbarVisible = false;
  private drag: Drag | undefined;
  private frame = 0;

  constructor(private readonly opts: VirtualListOptions) {
    this.root = el('div', 'vl');
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
    this.bindScrollbar(this.vbar, this.vthumb, 'v');
    this.bindScrollbar(this.hbar, this.hthumb, 'h');
    new ResizeObserver(() => this.layout()).observe(this.root);
    this.layout();
    this.view.focus();
  }

  get topLine(): number {
    return Math.floor(this.virtualTop / this.lineHeight);
  }

  setLineCount(count: number): void {
    if (count === this.lineCount) return;
    this.lineCount = count;
    const digits = String(Math.max(1, count)).length;
    if (digits !== this.gutterDigits) {
      this.gutterDigits = digits;
      this.root.style.setProperty('--vl-gutter-width', `${this.gutterWidth}px`);
    }
    this.layout();
  }

  /** Call when line data changed (e.g. a batch arrived). */
  invalidate(): void {
    this.schedule();
  }

  scrollToLine(line: number): void {
    this.setScrollTop(line * this.lineHeight);
  }

  get visibleLines(): number {
    return Math.max(1, Math.floor(this.viewHeight / this.lineHeight));
  }

  /** Scrolls `line` to about a third of the viewport and highlights it. Always reports the viewport. */
  revealLine(line: number): void {
    const target = clamp(Math.floor(line), 0, Math.max(0, this.lineCount - 1));
    this.highlightLine = target;
    const above = Math.floor(this.visibleLines / 3);
    this.virtualTop = clamp((target - above) * this.lineHeight, 0, this.maxScrollTop);
    this.schedule();
    this.opts.onScroll?.(this.topLine);
  }

  focus(): void {
    this.view.focus({ preventScroll: true });
  }

  // ---- geometry ----

  private get gutterWidth(): number {
    return Math.ceil(this.gutterDigits * this.charWidth) + GUTTER_PADDING_PX;
  }

  private get totalHeight(): number {
    return this.lineCount * this.lineHeight;
  }

  private get maxScrollTop(): number {
    return Math.max(0, this.totalHeight - this.viewHeight);
  }

  private get textViewWidth(): number {
    return Math.max(0, this.viewWidth - this.gutterWidth);
  }

  private get contentWidth(): number {
    return Math.ceil(this.maxLineChars * this.charWidth) + TEXT_PADDING_PX * 2;
  }

  private get maxScrollLeft(): number {
    return Math.max(0, this.contentWidth - this.textViewWidth);
  }

  private thumb(axis: Axis): ThumbGeometry | undefined {
    return axis === 'v'
      ? thumbGeometry(this.totalHeight, this.viewHeight, this.virtualTop, this.viewHeight)
      : thumbGeometry(this.contentWidth, this.textViewWidth, this.scrollLeft, this.viewWidth);
  }

  private measureFont(): void {
    const probe = el('span', 'vl-probe');
    probe.textContent = 'X'.repeat(100);
    this.root.append(probe);
    const rect = probe.getBoundingClientRect();
    const fontSize = parseFloat(getComputedStyle(this.root).fontSize) || 13;
    probe.remove();
    this.charWidth = rect.width > 0 ? rect.width / 100 : fontSize * 0.6;
    this.lineHeight = Math.max(Math.round(fontSize * 1.5), Math.ceil(rect.height), 12);
    this.root.style.setProperty('--vl-line-height', `${this.lineHeight}px`);
  }

  private layout(): void {
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

  // ---- scrolling ----

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

  // ---- rendering ----

  private schedule(): void {
    if (this.frame === 0) this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.frame = 0;
    const lh = this.lineHeight;
    const first = Math.floor(this.virtualTop / lh);
    const visible = Math.ceil(this.viewHeight / lh) + 1;
    const start = Math.max(0, first - BUFFER_LINES);
    const end = Math.min(this.lineCount, first + visible + BUFFER_LINES);
    if (end > start) this.opts.ensureRange(start, end);

    const count = end - start;
    while (this.rows.length < count) this.rows.push(this.createRow(this.rows.length));

    let widest = this.maxLineChars;
    for (let k = 0; k < this.rows.length; k++) {
      const row = this.rows[k] as Row;
      if (k >= count) {
        if (row.line !== -1) {
          row.gutter.hidden = row.text.hidden = true;
          row.line = -1;
        }
        continue;
      }
      const line = start + k;
      const entry = this.opts.getLine(line);
      if (row.line !== line) {
        row.gutter.textContent = String(line + 1);
        row.gutter.hidden = row.text.hidden = false;
        row.line = line;
        row.content = undefined;
      }
      const content = entry?.text;
      if (row.content !== content || row.truncated !== (entry?.truncated ?? false)) {
        row.text.textContent = content ?? '';
        row.content = content;
        row.truncated = entry?.truncated ?? false;
        row.text.classList.toggle('truncated', row.truncated);
        if (content && content.length > widest) widest = content.length;
      }
    }
    if (widest !== this.maxLineChars) {
      this.maxLineChars = widest;
      this.layout(); // may show the horizontal scrollbar; schedules another frame
    }

    // Offset is at most ~BUFFER_LINES rows: layers never get huge coordinates.
    const offsetY = start * lh - this.virtualTop;
    this.gutterLayer.style.transform = `translate3d(0, ${offsetY}px, 0)`;
    this.textLayer.style.transform = `translate3d(${-this.scrollLeft}px, ${offsetY}px, 0)`;

    const hy = this.highlightLine * lh - this.virtualTop;
    const showHighlight = this.highlightLine >= 0 && this.highlightLine < this.lineCount && hy > -lh && hy < this.viewHeight;
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
    return { gutter, text, line: -1, content: undefined, truncated: false };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
