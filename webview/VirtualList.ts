/**
 * Virtualized line list with a virtual scrollbar (SPEC §3.5, §7.6).
 *
 * The native scroller only provides a scrollbar: its spacer is capped at MAX_SCROLL_HEIGHT
 * because Chromium clamps element heights (~33M px). The logical scroll position
 * (`virtualTop`, in unscaled pixels) is mapped to the scrollbar with a ratio. Wheel and
 * keyboard input move `virtualTop` directly, so fine scrolling stays exact on files of any
 * length; dragging the scrollbar maps back through the same ratio.
 *
 * Rows are drawn in an overlay that is never taller than the viewport, so no element ever
 * gets a huge offset.
 */

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
const MAX_SCROLL_HEIGHT = 1_000_000;
const TEXT_PADDING_PX = 12;
const GUTTER_PADDING_PX = 28;

interface Row {
  gutter: HTMLDivElement;
  text: HTMLDivElement;
  line: number;
  content: string | undefined;
  truncated: boolean;
}

export class VirtualList {
  private readonly root: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly gutterLayer: HTMLDivElement;
  private readonly textLayer: HTMLDivElement;
  private readonly rows: Row[] = [];

  private lineCount = 0;
  private virtualTop = 0;
  private scrollLeft = 0;
  private lastScrollTop = 0;
  private viewWidth = 0;
  private viewHeight = 0;
  private lineHeight = 20;
  private charWidth = 8;
  private gutterDigits = 0;
  private maxLineChars = 0;
  private frame = 0;

  constructor(private readonly opts: VirtualListOptions) {
    this.root = el('div', 'vl');
    this.scroller = el('div', 'vl-scroller');
    this.scroller.tabIndex = -1;
    this.spacer = el('div', 'vl-spacer');
    this.overlay = el('div', 'vl-overlay');
    this.overlay.tabIndex = 0;
    const gutter = el('div', 'vl-gutter');
    const text = el('div', 'vl-text');
    this.gutterLayer = el('div', 'vl-layer');
    this.textLayer = el('div', 'vl-layer');

    this.scroller.append(this.spacer);
    gutter.append(this.gutterLayer);
    text.append(this.textLayer);
    this.overlay.append(gutter, text);
    this.root.append(this.scroller, this.overlay);
    opts.container.append(this.root);

    this.measureFont();
    this.root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.scroller.addEventListener('scroll', () => this.onNativeScroll());
    this.overlay.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.layout()).observe(this.root);
    this.layout();
    this.overlay.focus();
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
    this.updateSpacer();
    this.syncScrollbar();
    this.schedule();
  }

  /** Call when line data changed (e.g. a batch arrived). */
  invalidate(): void {
    this.schedule();
  }

  scrollToLine(line: number): void {
    this.setVirtualTop(line * this.lineHeight);
  }

  private get gutterWidth(): number {
    return Math.ceil(this.gutterDigits * this.charWidth) + GUTTER_PADDING_PX;
  }

  private get totalHeight(): number {
    return this.lineCount * this.lineHeight;
  }

  private get maxVirtualTop(): number {
    return Math.max(0, this.totalHeight - this.viewHeight);
  }

  private get maxScrollTop(): number {
    return Math.max(0, Math.min(this.totalHeight, MAX_SCROLL_HEIGHT) - this.viewHeight);
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
    this.viewWidth = this.scroller.clientWidth;
    this.viewHeight = this.scroller.clientHeight;
    this.overlay.style.width = `${this.viewWidth}px`;
    this.overlay.style.height = `${this.viewHeight}px`;
    this.setVirtualTop(this.virtualTop, false);
  }

  private updateSpacer(): void {
    // Integers only: template literals turn 1e6 into "1e+06px".
    const height = Math.round(Math.min(this.totalHeight, MAX_SCROLL_HEIGHT));
    const width = Math.ceil(this.gutterWidth + TEXT_PADDING_PX * 2 + this.maxLineChars * this.charWidth);
    this.spacer.style.height = `${height.toFixed(0)}px`;
    this.spacer.style.width = `${width.toFixed(0)}px`;
  }

  private setVirtualTop(top: number, notify = true): void {
    const clamped = Math.min(Math.max(0, top), this.maxVirtualTop);
    const changed = clamped !== this.virtualTop;
    this.virtualTop = clamped;
    this.syncScrollbar();
    this.schedule();
    if (changed && notify) this.opts.onScroll?.(this.topLine);
  }

  /** Moves the native scrollbar thumb to reflect `virtualTop`. */
  private syncScrollbar(): void {
    const maxVirtual = this.maxVirtualTop;
    const target = maxVirtual > 0 ? (this.virtualTop * this.maxScrollTop) / maxVirtual : 0;
    this.scroller.scrollTop = target;
    this.lastScrollTop = this.scroller.scrollTop;
  }

  private onNativeScroll(): void {
    const st = this.scroller.scrollTop;
    // Ignore echoes of our own syncScrollbar(); anything else is a scrollbar drag/click.
    if (Math.abs(st - this.lastScrollTop) >= 1) {
      this.lastScrollTop = st;
      const maxScroll = this.maxScrollTop;
      const top = maxScroll <= 0 ? 0 : st >= maxScroll - 0.5 ? this.maxVirtualTop : (st * this.maxVirtualTop) / maxScroll;
      this.virtualTop = top;
      this.opts.onScroll?.(this.topLine);
    }
    if (this.scroller.scrollLeft !== this.scrollLeft) this.scrollLeft = this.scroller.scrollLeft;
    this.schedule();
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
    if (dy !== 0) this.setVirtualTop(this.virtualTop + dy);
    if (dx !== 0) this.scroller.scrollLeft += dx; // native scroll event updates scrollLeft
  }

  private onKey(e: KeyboardEvent): void {
    const page = Math.max(this.lineHeight, this.viewHeight - this.lineHeight);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': this.setVirtualTop(this.virtualTop + this.lineHeight); break;
      case 'ArrowUp': this.setVirtualTop(this.virtualTop - this.lineHeight); break;
      case 'PageDown': this.setVirtualTop(this.virtualTop + page); break;
      case 'PageUp': this.setVirtualTop(this.virtualTop - page); break;
      case 'Home': this.setVirtualTop(0); break;
      case 'End': this.setVirtualTop(this.maxVirtualTop); break;
      case 'ArrowRight': this.scroller.scrollLeft += this.charWidth * 4; break;
      case 'ArrowLeft': this.scroller.scrollLeft -= this.charWidth * 4; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

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
      this.updateSpacer();
    }

    // Offset is at most ~BUFFER_LINES rows: layers never get huge coordinates.
    const offsetY = start * lh - this.virtualTop;
    this.gutterLayer.style.transform = `translate3d(0, ${offsetY}px, 0)`;
    this.textLayer.style.transform = `translate3d(${-this.scrollLeft}px, ${offsetY}px, 0)`;
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
