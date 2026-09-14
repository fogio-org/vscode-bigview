/**
 * Integration tests, executed inside the VS Code extension host.
 * A tiny sequential runner keeps the project free of extra test dependencies.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BigViewDocument, BigViewEditor } from '../../src/editor/BigViewProvider';
import type { SearchState } from '../../src/editor/SearchController';
import type { BigViewApi, ExportResult } from '../../src/extension';
import { formatCount } from '../../src/shared/format';
import type { FilterMode, HitTarget } from '../../src/shared/protocol';
import type { FormatInfo } from '../../src/shared/formats';
import { compileQuery, type Query, type SearchQuery } from '../../src/shared/searchQuery';
import type { GenerateResult } from '../fixtures/generate';
import { enabledTiers, FIXTURES, loadFixture, type FixtureSpec } from './fixtures';

const ROOT = process.env.BIGVIEW_ROOT ?? process.cwd();
const TIERS = enabledTiers(process.env);
const MB = 1024 * 1024;
const FIRST_PAGE_BUDGET_MS = 500;
/** SPEC §6 M2 acceptance: peak RSS of the extension process on a 5 GB file. */
const RSS_LIMIT_5GB = 400 * MB;

type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

export async function run(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    const started = performance.now();
    try {
      await t.fn();
      console.log(`  ✓ ${t.name} (${Math.round(performance.now() - started)} ms)`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}\n`, err);
    } finally {
      await closeAll();
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${tests.length} integration tests failed`);
}

async function api(): Promise<BigViewApi> {
  const ext = vscode.extensions.getExtension<BigViewApi>('fogio.bigview');
  assert.ok(ext, 'extension not found');
  return ext.activate();
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const { provider } = await api();
  for (const spec of Object.values(FIXTURES)) {
    const uri = vscode.Uri.file(`${ROOT}/test/.tmp/${spec.name}`);
    await waitFor(() => provider.findDocument(uri) === undefined, 5000, `disposal of ${spec.name}`);
  }
}

const fixture = (spec: FixtureSpec): GenerateResult => loadFixture(ROOT, spec);

/** Samples process RSS (extension host + its worker threads). */
class RssSampler {
  peak = process.memoryUsage().rss;
  private readonly timer = setInterval(() => this.sample(), 10);
  sample(): void {
    this.peak = Math.max(this.peak, process.memoryUsage().rss);
  }
  stop(): number {
    clearInterval(this.timer);
    this.sample();
    return this.peak;
  }
}

interface Opened {
  doc: BigViewDocument;
  editor: BigViewEditor;
  firstPageMs: number;
  readyMs: number;
}

async function open(gen: GenerateResult, how: 'command' | 'openWith' = 'openWith'): Promise<Opened> {
  const { provider } = await api();
  const uri = vscode.Uri.file(gen.path);
  const t0 = performance.now();
  if (how === 'command') await vscode.commands.executeCommand('bigview.openFile', uri);
  else await vscode.commands.executeCommand('vscode.openWith', uri, 'bigview.viewer');
  const doc = await waitFor(() => provider.findDocument(uri), 10_000, 'document');
  const editor = await waitFor(() => provider.editorsFor(doc)[0], 10_000, 'editor');
  const firstLinesAt = await waitFor(() => doc.firstLinesAt, 10_000, 'first lines sent to webview');
  await doc.indexed;
  assert.equal(doc.error, undefined);
  assert.equal(doc.state, 'ready');
  assert.equal(doc.index.lineCount, gen.lines, 'line count');
  return { doc, editor, firstPageMs: firstLinesAt - t0, readyMs: (doc.readyAt ?? Infinity) - t0 };
}

const TS_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO |DEBUG|WARN |ERROR) \[worker-\d+\] /;

async function checkSampledLines(doc: BigViewDocument, lineCount: number): Promise<number> {
  const samples = [0, 1, Math.floor(lineCount / 2), lineCount - 2, lineCount - 1];
  for (let i = 0; i < 20; i++) samples.push(Math.floor(Math.random() * lineCount));
  let worstMs = 0;
  for (const line of samples) {
    const t = performance.now();
    const res = await doc.reader.readLines(line, 100);
    worstMs = Math.max(worstMs, performance.now() - t);
    for (const text of res.lines) {
      assert.match(text, TS_PREFIX, `line ${line} looks misaligned: ${text.slice(0, 80)}`);
    }
  }
  return worstMs;
}

async function forgetIndex(gen: GenerateResult): Promise<void> {
  await (await api()).store.remove(gen.path);
}

const mb = (n: number): string => `${Math.round(n / MB)} MB`;

// ---------------------------------------------------------------------------

test('opens a 10 MB log via "BigView: Open File in BigView" and reads exact content', async () => {
  const gen = fixture(FIXTURES.small);
  await forgetIndex(gen);
  const { doc, firstPageMs, readyMs } = await open(gen, 'command');
  console.log(`    first page ${firstPageMs.toFixed(0)} ms, indexed in ${readyMs.toFixed(0)} ms`);
  assert.equal(doc.source, 'scan');
  assert.ok(firstPageMs < FIRST_PAGE_BUDGET_MS, `first page took ${firstPageMs} ms`);

  const expected = fs.readFileSync(gen.path, 'utf8').split('\n');
  expected.pop(); // trailing newline
  assert.equal(expected.length, gen.lines);
  for (const start of [0, 1234, Math.floor(gen.lines / 2), gen.lines - 500]) {
    const res = await doc.reader.readLines(start, 500);
    assert.deepEqual(res.lines, expected.slice(start, start + 500));
  }
});

test('.log files open with BigView as the default editor', async () => {
  const gen = fixture(FIXTURES.tiny);
  const { provider } = await api();
  const uri = vscode.Uri.file(gen.path);
  await vscode.commands.executeCommand('vscode.open', uri);
  const doc = await waitFor(() => provider.findDocument(uri), 5000, 'document');
  await doc.indexed;
  assert.equal(doc.index.lineCount, gen.lines);
});

test('closing the editor disposes the document', async () => {
  const gen = fixture(FIXTURES.small);
  const { provider } = await api();
  const uri = vscode.Uri.file(gen.path);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'bigview.viewer');
  await waitFor(() => provider.findDocument(uri), 5000, 'document');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => provider.findDocument(uri) === undefined, 5000, 'document disposal');
});

test('reopening loads the index from the on-disk cache', async () => {
  const gen = fixture(FIXTURES.small);
  const { store } = await api();
  await forgetIndex(gen);
  const first = await open(gen);
  assert.equal(first.doc.source, 'scan');
  await first.doc.persisted;
  assert.equal(first.doc.persistError, undefined);
  assert.ok(fs.existsSync(store.pathFor(gen.path)), 'sidecar written');
  await closeAll();

  const second = await open(gen);
  console.log(`    scan ready ${first.readyMs.toFixed(0)} ms, cache ready ${second.readyMs.toFixed(0)} ms`);
  assert.equal(second.doc.source, 'cache');
  assert.ok(second.readyMs < 200, `cached index took ${second.readyMs} ms`);
  const expected = fs.readFileSync(gen.path, 'utf8').split('\n');
  for (const start of [0, 77_777 % gen.lines, gen.lines - 300]) {
    assert.deepEqual((await second.doc.reader.readLines(start, 300)).lines, expected.slice(start, start + 300));
  }
});

test('a corrupt or stale sidecar is ignored and rebuilt', async () => {
  const gen = fixture(FIXTURES.tiny);
  const { store } = await api();

  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(store.pathFor(gen.path), 'garbage');
  const corrupt = await open(gen);
  assert.equal(corrupt.doc.source, 'scan');
  await corrupt.doc.persisted;
  await closeAll();

  // Touch the file: same content, new mtime → sidecar is stale.
  const st = fs.statSync(gen.path);
  const later = new Date(st.mtimeMs + 5000);
  fs.utimesSync(gen.path, later, later);
  try {
    const stale = await open(gen);
    assert.equal(stale.doc.source, 'scan');
    await stale.doc.persisted;
  } finally {
    fs.utimesSync(gen.path, st.atime, st.mtime);
  }
});

test('Go to Line reveals the requested line in the webview', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  const target = 50_000; // 1-based
  await vscode.commands.executeCommand('bigview.goToLine', target);
  await waitFor(
    () => editor.topLine <= target - 1 && editor.topLine + editor.visibleLines > target - 1 && editor.topLine > target - 100,
    5000,
    `viewport around line ${target} (topLine=${editor.topLine})`,
  );
  await vscode.commands.executeCommand('bigview.goToLine', gen.lines + 1000); // clamps to the last line
  await waitFor(() => editor.topLine + editor.visibleLines >= gen.lines - 1, 5000, 'viewport at the end');
});

test('status bar shows size, line count and index state', async () => {
  const gen = fixture(FIXTURES.small);
  const { statusBar } = await api();
  await forgetIndex(gen);
  await open(gen);
  await waitFor(() => statusBar.text.includes('Indexed') || undefined, 5000, `status bar (${statusBar.text})`);
  assert.match(statusBar.text, /MB · /);
  assert.ok(statusBar.text.includes(`${formatCount(gen.lines)} lines`), statusBar.text);
  await closeAll();
  await open(gen);
  await waitFor(() => statusBar.text.includes('Index cached') || undefined, 5000, `cached status (${statusBar.text})`);
  await closeAll();
  assert.equal(statusBar.text, '');
});

// ---------------------------------------------------------------------------
// Search (M3)

type QueryInput = Partial<SearchQuery> & { text: string };

/** Key-order independent comparison of flat query objects. */
const sameQuery = (a: Query | undefined, b: Query): boolean =>
  !!a && JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/** Types a text query into the webview search bar (real webview path) and waits for the result. */
async function runSearch(editor: BigViewEditor, input: QueryInput, timeoutMs = 30_000): Promise<{ state: SearchState; ms: number }> {
  return runQuery(editor, { caseSensitive: true, wholeWord: false, regex: false, ...input }, timeoutMs);
}

/** Runs any query (text, time range, field) through the webview search bar. */
async function runQuery(editor: BigViewEditor, query: Query, timeoutMs = 30_000): Promise<{ state: SearchState; ms: number }> {
  const before = editor.search.state.searchId;
  const t0 = performance.now();
  editor.setQuery(query);
  const state = await waitFor(
    () => {
      const s = editor.search.state;
      return s.searchId !== before && sameQuery(s.query, query) && (s.status === 'done' || s.status === 'error') ? s : undefined;
    },
    timeoutMs,
    `search ${JSON.stringify(query)}`,
  );
  const ms = performance.now() - t0;
  // The webview jumps to the first hit on its own; let that settle before navigating.
  if (state.status === 'done' && state.total > 0) {
    await waitFor(() => editor.search.lastHit?.searchId === state.searchId || undefined, 5000, 'auto-jump to the first hit');
  }
  return { state, ms };
}

/** Sends what a click on a result row (or F3) sends and checks the main list shows the line. */
async function gotoAndCheck(editor: BigViewEditor, searchId: number, target: HitTarget, index: number, line: number): Promise<void> {
  editor.search.lastHit = undefined;
  editor.dispatch({ type: 'gotoHit', searchId, target });
  const hit = await waitFor(() => editor.search.lastHit, 5000, `hit for ${JSON.stringify(target)}`);
  assert.deepEqual({ index: hit.index, line: hit.line }, { index, line });
  await waitFor(
    () => (editor.topLine <= line && line < editor.topLine + editor.visibleLines) || undefined,
    5000,
    `viewport showing line ${line} (top ${editor.topLine}, visible ${editor.visibleLines})`,
  );
}

function fileLines(file: string): string[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

test('search finds exactly the marker lines; every result navigates the main list', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  const { state, ms } = await runSearch(editor, { text: 'NEEDLE_MARKER' });
  console.log(`    ${state.total} hits in ${ms.toFixed(0)} ms`);
  assert.equal(state.status, 'done');
  assert.equal(state.total, gen.markerLines);
  const expected = fileLines(gen.path).flatMap((t, i) => (t.includes('NEEDLE_MARKER') ? [i] : []));
  const hits = editor.search.hitLines();
  assert.deepEqual(hits, expected);

  // Result rows as the webview receives them.
  const items = await editor.search.readResults(state.searchId, 0, 200);
  assert.equal(items?.length, expected.length);
  items?.forEach((item, i) => {
    assert.equal(item.line, expected[i]);
    const [s, e] = item.ranges[0] ?? [0, 0];
    assert.equal(item.text.slice(s, e), 'NEEDLE_MARKER');
  });

  for (let i = 0; i < hits.length; i++) await gotoAndCheck(editor, state.searchId, { index: i }, i, hits[i] as number);
  const at = (i: number): number => hits[i] as number;
  const last = hits.length - 1;
  await gotoAndCheck(editor, state.searchId, { fromLine: at(5) + 1, direction: 1 }, 6, at(6));
  await gotoAndCheck(editor, state.searchId, { fromLine: at(5), direction: -1 }, 4, at(4));
  await gotoAndCheck(editor, state.searchId, { fromLine: at(last) + 1, direction: 1 }, 0, at(0));
  await gotoAndCheck(editor, state.searchId, { index: -1 }, last, at(last));
});

test('regex, case-insensitive and whole-word searches match a per-line reference', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  const lines = fileLines(gen.path);
  const queries: QueryInput[] = [
    { text: 'needle_marker', caseSensitive: false },
    { text: 'ERROR \\[worker-1[0-5]\\]', regex: true },
    { text: 'запрос', wholeWord: true },
    { text: '^2026-01-01T00:0[0-2]', regex: true },
    { text: '(?<=WARN  \\[)worker-7', regex: true },
    { text: 'retry$', regex: true },
    { text: 'CAFÉ', caseSensitive: false },
  ];
  for (const input of queries) {
    const { state, ms } = await runSearch(editor, input);
    assert.equal(state.status, 'done', state.error);
    const re = compileQuery(state.query as SearchQuery).regex;
    const expected = lines.flatMap((t, i) => (re.test(t) ? [i] : []));
    assert.deepEqual(editor.search.hitLines(), expected, JSON.stringify(input));
    console.log(`    ${JSON.stringify(input)}: ${state.total} hits in ${ms.toFixed(0)} ms`);
  }
});

test('a new query replaces the running search; an invalid regex reports an error', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  const seen: SearchState[] = [];
  const sub = editor.search.onDidChange((s) => seen.push(s));
  try {
    editor.setQuery({ text: '\\w+\\s+\\w+\\s+\\w+\\s+NOPE', caseSensitive: true, wholeWord: false, regex: true });
    const { state } = await runSearch(editor, { text: 'NEEDLE_MARKER' });
    assert.equal(state.total, gen.markerLines);
    const firstId = seen.find((s) => s.query && 'text' in s.query && s.query.text.endsWith('NOPE'))?.searchId;
    assert.ok(firstId !== undefined, 'the first search started');
    let lastOfFirst = -1;
    seen.forEach((s, i) => {
      if (s.searchId === firstId) lastOfFirst = i;
    });
    const firstOfSecond = seen.findIndex((s) => s.searchId === state.searchId);
    assert.ok(lastOfFirst < firstOfSecond, 'no updates from the replaced search after the new one started');
  } finally {
    sub.dispose();
  }
  const bad = await runSearch(editor, { text: '(unclosed', regex: true });
  assert.equal(bad.state.status, 'error');
  assert.match(bad.state.error ?? '', /Invalid regular expression/);
});

// ---------------------------------------------------------------------------
// Filter and export (M4)

/** Uses the webview's filter buttons path and waits until the webview shows the new rows. */
async function setFilterMode(editor: BigViewEditor, mode: FilterMode): Promise<number> {
  const t0 = performance.now();
  // Stage timestamps, printed when a switch is slow.
  const stages: string[] = [];
  const mark = (name: string): void => {
    stages.push(`${name} +${(performance.now() - t0).toFixed(0)}ms`);
  };
  const subs = [
    editor.search.onDidChange(() => mark(`host mode=${editor.search.mode}`)),
    editor.onDidChangeViewport(() => mark(`viewport mode=${editor.viewMode} rows=${editor.rowCount}`)),
  ];
  try {
    editor.setFilterMode(mode);
    await waitFor(
      () => (editor.search.mode === mode && editor.viewMode === mode && editor.rowCount === editor.search.viewCount(mode)) || undefined,
      10_000,
      `filter ${mode} (webview ${editor.viewMode} with ${editor.rowCount} rows, host ${editor.search.mode})`,
    );
  } finally {
    subs.forEach((s) => s.dispose());
  }
  const ms = performance.now() - t0;
  if (ms > 300) console.log(`    slow switch to ${mode} (${ms.toFixed(0)} ms): ${stages.join(', ')}`);
  return ms;
}

async function gotoRow(editor: BigViewEditor, searchId: number, target: HitTarget, row: number): Promise<void> {
  editor.search.lastHit = undefined;
  editor.dispatch({ type: 'gotoHit', searchId, target });
  await waitFor(() => editor.search.lastHit, 5000, `hit for ${JSON.stringify(target)}`);
  await waitFor(
    () => (editor.topLine <= row && row < editor.topLine + editor.visibleLines) || undefined,
    5000,
    `row ${row} visible (top ${editor.topLine}, visible ${editor.visibleLines})`,
  );
}

function rawLines(file: string): Buffer[] {
  const raw = fs.readFileSync(file);
  const out: Buffer[] = [];
  for (let s = 0; s < raw.length; ) {
    const nl = raw.indexOf(10, s);
    const e = nl === -1 ? raw.length : nl + 1;
    out.push(raw.subarray(s, e));
    s = e;
  }
  return out;
}

test('filter shows only matching lines, inverts, keeps the position and maps navigation', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  const all = fileLines(gen.path);
  const { state } = await runSearch(editor, { text: 'NEEDLE_MARKER' });
  const hits = editor.search.hitLines();
  const nonHits = all.flatMap((t, i) => (t.includes('NEEDLE_MARKER') ? [] : [i]));

  const onMs = await setFilterMode(editor, 'matches');
  assert.equal(editor.rowCount, hits.length);
  const matchView = await editor.search.readView(state.searchId, 'matches', 0, 500);
  assert.deepEqual(matchView?.lineNumbers, hits);
  assert.deepEqual(matchView?.lines, hits.map((l) => all[l]));
  await gotoRow(editor, state.searchId, { index: 20 }, 20);

  const invertMs = await setFilterMode(editor, 'nonMatches');
  assert.equal(editor.rowCount, nonHits.length);
  const invView = await editor.search.readView(state.searchId, 'nonMatches', 40_000, 500);
  assert.deepEqual(invView?.lineNumbers, nonHits.slice(40_000, 40_500));
  assert.deepEqual(invView?.lines, nonHits.slice(40_000, 40_500).map((l) => all[l]));

  const offMs = await setFilterMode(editor, 'all');
  assert.equal(editor.rowCount, all.length);
  console.log(`    switch: filter ${onMs.toFixed(0)} ms, invert ${invertMs.toFixed(0)} ms, off ${offMs.toFixed(0)} ms`);

  // The file line at the top stays at the top when the filter changes.
  editor.reveal(60_000);
  await waitFor(() => (editor.topLine > 59_000 && editor.topLine <= 60_000) || undefined, 5000, `reveal (top ${editor.topLine})`);
  const topBefore = editor.topLine;
  await setFilterMode(editor, 'nonMatches');
  const anchored = editor.search.viewIndexOfLine(topBefore, 'nonMatches');
  await waitFor(() => editor.topLine === anchored || undefined, 5000, `anchored top ${anchored} (is ${editor.topLine})`);
  await setFilterMode(editor, 'all');
  await waitFor(() => editor.topLine === topBefore || undefined, 5000, `restored top ${topBefore} (is ${editor.topLine})`);
});

test('export writes exactly the selected lines, for a filter and its inverse', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  const lines = rawLines(gen.path);
  await runSearch(editor, { text: 'NEEDLE_MARKER' });
  const matchesOut = path.join(ROOT, 'test', '.tmp', 'it-export-matches.txt');
  const invertOut = path.join(ROOT, 'test', '.tmp', 'it-export-inverted.txt');
  try {
    const r1 = await vscode.commands.executeCommand<ExportResult | undefined>('bigview.exportFiltered', vscode.Uri.file(matchesOut));
    assert.equal(r1?.mode, 'matches');
    assert.equal(r1?.lines, gen.markerLines);
    assert.ok(fs.readFileSync(matchesOut).equals(Buffer.concat(lines.filter((l) => l.includes('NEEDLE_MARKER')))), 'matching lines');

    await setFilterMode(editor, 'nonMatches');
    const r2 = await vscode.commands.executeCommand<ExportResult | undefined>('bigview.exportFiltered', vscode.Uri.file(invertOut));
    assert.equal(r2?.mode, 'nonMatches');
    assert.equal(r2?.lines, lines.length - gen.markerLines);
    assert.ok(fs.readFileSync(invertOut).equals(Buffer.concat(lines.filter((l) => !l.includes('NEEDLE_MARKER')))), 'non-matching lines');
    console.log(`    exported ${r1?.lines} lines in ${r1?.elapsedMs.toFixed(0)} ms, ${r2?.lines} lines in ${r2?.elapsedMs.toFixed(0)} ms`);
  } finally {
    fs.rmSync(matchesOut, { force: true });
    fs.rmSync(invertOut, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Formats (M5)

test('formats are detected per file: log, JSON Lines (by extension and by content), CSV', async () => {
  const cases: Array<[FixtureSpec, FormatInfo]> = [
    [FIXTURES.small, { kind: 'log', source: 'extension' }],
    [FIXTURES.jsonl, { kind: 'jsonl', source: 'extension' }],
    [FIXTURES.jsonLog, { kind: 'jsonl', source: 'content' }],
    [FIXTURES.csv, { kind: 'dsv', delimiter: ',', source: 'extension', header: ['id', 'ts', 'level', 'user', 'message'] }],
  ];
  const { statusBar } = await api();
  for (const [spec, expected] of cases) {
    const { doc, editor } = await open(fixture(spec));
    const format = await waitFor(() => doc.format, 5000, `format of ${spec.name}`);
    assert.deepEqual(format, expected, spec.name);
    await waitFor(() => editor.viewFormat === expected.kind || undefined, 5000, `webview renders ${expected.kind} (${editor.viewFormat})`);
    assert.ok(statusBar.formatText.length > 0, 'format shown in the status bar');
    await closeAll();
  }
});

test('the format can be switched manually and is remembered per file', async () => {
  const gen = fixture(FIXTURES.csv);
  let { doc, editor } = await open(gen);
  await waitFor(() => doc.format, 5000, 'format');

  let f = await vscode.commands.executeCommand<FormatInfo | undefined>('bigview.changeFormat', { kind: 'dsv', delimiter: '\t' });
  assert.deepEqual(f, { kind: 'dsv', delimiter: '\t', source: 'user', header: ['id,ts,level,user,message'] });
  f = await vscode.commands.executeCommand<FormatInfo | undefined>('bigview.changeFormat', 'text');
  assert.deepEqual(f, { kind: 'text', source: 'user' });
  await waitFor(() => editor.viewFormat === 'text' || undefined, 5000, `webview text (${editor.viewFormat})`);

  await closeAll();
  ({ doc, editor } = await open(gen));
  const remembered = await waitFor(() => doc.format, 5000, 'format after reopening');
  assert.deepEqual(remembered, { kind: 'text', source: 'user' });

  f = await vscode.commands.executeCommand<FormatInfo | undefined>('bigview.changeFormat', 'auto');
  assert.equal(f?.kind, 'dsv');
  assert.equal(f?.source, 'extension');
  await waitFor(() => editor.viewFormat === 'dsv' || undefined, 5000, `webview dsv (${editor.viewFormat})`);
});

test('log: the time range filter selects lines by timestamp (bounds inclusive of their unit)', async () => {
  const gen = fixture(FIXTURES.small);
  const { editor } = await open(gen);
  await waitFor(() => editor.viewFormat === 'log' || undefined, 5000, 'log view');
  const times = fileLines(gen.path).map((t) => Date.parse(t.slice(0, 24)));
  const expect = (from: number, to: number): number[] => times.flatMap((ms, i) => (ms >= from && ms <= to ? [i] : []));

  const a = await runQuery(editor, { kind: 'time', from: '2026-01-01T00:01:00Z', to: '2026-01-01T00:02:30.500Z' });
  assert.equal(a.state.status, 'done', a.state.error);
  assert.deepEqual(editor.search.hitLines(), expect(Date.parse('2026-01-01T00:01:00Z'), Date.parse('2026-01-01T00:02:30.500Z')));

  const b = await runQuery(editor, { kind: 'time', from: '', to: '2026-01-01 00:00' });
  assert.deepEqual(editor.search.hitLines(), expect(-Infinity, Date.parse('2026-01-01T00:00:59.999Z')));
  console.log(`    time range: ${a.state.total} lines in ${a.ms.toFixed(0)} ms, ${b.state.total} lines in ${b.ms.toFixed(0)} ms`);

  // Predicates plug into the filter view like any search.
  await setFilterMode(editor, 'matches');
  assert.equal(editor.rowCount, b.state.total);

  const bad = await runQuery(editor, { kind: 'time', from: 'soon', to: '' });
  assert.equal(bad.state.status, 'error');
});

test('JSON Lines: field filters match a JSON.parse reference', async () => {
  const gen = fixture(FIXTURES.jsonl);
  const { editor } = await open(gen);
  await waitFor(() => editor.viewFormat === 'jsonl' || undefined, 5000, 'jsonl view');
  const objects = fileLines(gen.path).map((t) => JSON.parse(t) as Record<string, string>);
  const cases: Array<[string, (o: Record<string, string>) => boolean]> = [
    ['level=error', (o) => o.level === 'error'],
    ['msg~NEEDLE_MARKER', (o) => /NEEDLE_MARKER/.test(o.msg ?? '')],
    ['trace_id~^0[0-3]', (o) => /^0[0-3]/.test(o.trace_id ?? '')],
    ['level = "warn"', (o) => o.level === 'warn'],
    ['msg~/ЗАПРОС/i', (o) => /запрос/i.test(o.msg ?? '')],
  ];
  for (const [expression, predicate] of cases) {
    const { state, ms } = await runQuery(editor, { kind: 'field', expression });
    assert.equal(state.status, 'done', state.error);
    assert.deepEqual(editor.search.hitLines(), objects.flatMap((o, i) => (predicate(o) ? [i] : [])), expression);
    console.log(`    ${expression}: ${state.total} lines in ${ms.toFixed(0)} ms`);
  }
  const marker = await runQuery(editor, { kind: 'field', expression: 'msg~NEEDLE_MARKER' });
  assert.equal(marker.state.total, gen.markerLines);
  const bad = await runQuery(editor, { kind: 'field', expression: 'level' });
  assert.equal(bad.state.status, 'error');
});

if (TIERS.has('large')) {
  for (const [label, spec] of [['200 MB', FIXTURES.m200], ['1 GB', FIXTURES.g1]] as const) {
    test(`opens a ${label} log: first page < ${FIRST_PAGE_BUDGET_MS} ms, index is exact`, async () => {
      const gen = fixture(spec);
      await forgetIndex(gen);
      const rss = new RssSampler();
      const before = rss.peak;
      const { doc, firstPageMs, readyMs } = await open(gen);
      const worstReadMs = await checkSampledLines(doc, gen.lines);
      const peak = rss.stop();
      console.log(
        `    first page ${firstPageMs.toFixed(0)} ms, indexed in ${readyMs.toFixed(0)} ms, ${gen.lines} lines, ` +
          `stride ${doc.index.stride}, rss ${mb(before)} → peak ${mb(peak)}, worst 100-line read ${worstReadMs.toFixed(1)} ms`,
      );
      assert.ok(firstPageMs < FIRST_PAGE_BUDGET_MS, `first page took ${firstPageMs} ms`);
    });
  }
}

if (TIERS.has('large')) {
  test('M3 acceptance: 1 GB log with 137 marker lines — all found in < 6 s, every result navigates', async () => {
    const gen = fixture(FIXTURES.g1);
    assert.equal(gen.markerLines, 137);
    const { doc, editor } = await open(gen);
    const rss = new RssSampler();
    const { state, ms } = await runSearch(editor, { text: 'NEEDLE_MARKER' }, 60_000);
    const peak = rss.stop();
    console.log(`    literal: ${state.total} hits in ${ms.toFixed(0)} ms, peak RSS ${mb(peak)}`);
    assert.equal(state.status, 'done', state.error);
    assert.equal(state.total, 137);
    assert.ok(ms < 6000, `search took ${ms} ms`);

    const hits = editor.search.hitLines();
    assert.equal(new Set(hits).size, 137);
    for (const line of hits) {
      const { lines } = await doc.reader.readLines(line, 1);
      assert.ok(lines[0]?.includes('NEEDLE_MARKER'), `line ${line} does not contain the marker`);
    }
    for (let i = 0; i < hits.length; i++) await gotoAndCheck(editor, state.searchId, { index: i }, i, hits[i] as number);

    const variants: QueryInput[] = [
      { text: 'needle_marker', caseSensitive: false },
      { text: 'NEEDLE_MARK(ER)', regex: true },
      { text: 'NEEDLE_MARKER', wholeWord: true },
    ];
    for (const input of variants) {
      const r = await runSearch(editor, input, 60_000);
      console.log(`    ${JSON.stringify(input)}: ${r.state.total} hits in ${r.ms.toFixed(0)} ms`);
      assert.equal(r.state.total, 137);
    }
  });
}

if (TIERS.has('large')) {
  test('M4 acceptance: 1 GB regex filter builds as fast as search, switching is instant, exporting ~500k lines keeps memory flat', async () => {
    const gen = fixture(FIXTURES.g1);
    const { doc, editor } = await open(gen);
    const query: QueryInput = { text: '^\\S+ ERROR \\[worker-[0-8]\\]', regex: true };
    const re = compileQuery({ caseSensitive: true, wholeWord: false, ...query, regex: true }).regex;

    const plain = await runSearch(editor, query, 60_000);
    await setFilterMode(editor, 'matches');
    const filtered = await runSearch(editor, query, 60_000); // re-run with the filter on: rows fill in as found
    await waitFor(() => editor.rowCount === filtered.state.total || undefined, 5000, `filtered rows (${editor.rowCount})`);
    console.log(`    search ${plain.ms.toFixed(0)} ms, filter ${filtered.ms.toFixed(0)} ms, ${filtered.state.total} lines`);
    assert.equal(filtered.state.total, plain.state.total);
    assert.ok(filtered.state.total >= 400_000, `expected ~500k lines, got ${filtered.state.total}`);
    assert.ok(filtered.ms < 6000, `filter took ${filtered.ms} ms`);
    assert.ok(filtered.ms < plain.ms * 1.5 + 300, `filter ${filtered.ms} ms vs search ${plain.ms} ms`);

    const switches: Array<[FilterMode, number]> = [];
    for (const mode of ['all', 'matches', 'nonMatches', 'all', 'matches'] as FilterMode[]) switches.push([mode, await setFilterMode(editor, mode)]);
    console.log(`    switches: ${switches.map(([m, ms]) => `${m} ${ms.toFixed(0)} ms`).join(', ')}`);
    assert.ok(Math.max(...switches.map(([, ms]) => ms)) < 500, 'switching is instant');
    const mid = await editor.search.readView(filtered.state.searchId, 'matches', 250_000, 200);
    for (const [k, text] of (mid?.lines ?? []).entries()) {
      assert.match(text, re);
      const { lines } = await doc.reader.readLines(mid?.lineNumbers[k] as number, 1);
      assert.equal(lines[0], text);
    }

    const out = path.join(ROOT, 'test', '.tmp', 'it-export-1g.txt');
    try {
      const before = process.memoryUsage().rss;
      const rss = new RssSampler();
      const result = await vscode.commands.executeCommand<ExportResult | undefined>('bigview.exportFiltered', vscode.Uri.file(out));
      const peak = rss.stop();
      console.log(
        `    export ${result?.lines} lines (${mb(result?.bytes ?? 0)}) in ${result?.elapsedMs.toFixed(0)} ms, ` +
          `rss ${mb(before)} → peak ${mb(peak)} (+${mb(peak - before)})`,
      );
      assert.equal(result?.lines, filtered.state.total);
      assert.ok(peak - before < 50 * MB, `export raised RSS by ${mb(peak - before)}`);

      // Every exported line matches, and there are exactly as many as hits.
      let count = 0;
      const fd = fs.openSync(out, 'r');
      const buf = Buffer.allocUnsafe(8 << 20);
      let carry = '';
      for (let pos = 0; ; ) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n === 0) break;
        pos += n;
        const parts = (carry + buf.toString('latin1', 0, n)).split('\n');
        carry = parts.pop() ?? '';
        for (const line of parts) {
          count++;
          if (!re.test(line)) assert.fail(`exported line ${count} does not match: ${line.slice(0, 80)}`);
        }
      }
      fs.closeSync(fd);
      assert.equal(carry, '');
      assert.equal(count, filtered.state.total);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
}

if (TIERS.has('huge')) {
  test('5 GB log: indexed once, reopened from cache instantly, peak RSS < 400 MB', async () => {
    const gen = fixture(FIXTURES.g5);
    await forgetIndex(gen);

    const rssScan = new RssSampler();
    const scan = await open(gen);
    assert.equal(scan.doc.source, 'scan');
    const scanReadMs = await checkSampledLines(scan.doc, gen.lines);
    await scan.doc.persisted;
    assert.equal(scan.doc.persistError, undefined);
    const peakScan = rssScan.stop();
    console.log(
      `    scan: first page ${scan.firstPageMs.toFixed(0)} ms, indexed in ${(scan.readyMs / 1000).toFixed(1)} s, ` +
        `${gen.lines} lines, stride ${scan.doc.index.stride}, ${scan.doc.index.anchorCount} anchors, ` +
        `peak RSS ${mb(peakScan)}, worst read ${scanReadMs.toFixed(1)} ms`,
    );
    await closeAll();

    const rssCache = new RssSampler();
    const cached = await open(gen);
    const cacheReadMs = await checkSampledLines(cached.doc, gen.lines);
    const search = await runSearch(cached.editor, { text: 'NEEDLE_MARKER' }, 120_000);
    const peakCache = rssCache.stop();
    console.log(`    search: ${search.state.total} hits in ${(search.ms / 1000).toFixed(1)} s`);
    assert.equal(search.state.status, 'done', search.state.error);
    assert.ok(search.ms < 30_000, `5 GB literal search took ${search.ms} ms`);
    console.log(
      `    cache: ready in ${cached.readyMs.toFixed(0)} ms, first page ${cached.firstPageMs.toFixed(0)} ms, ` +
        `peak RSS ${mb(peakCache)}, worst read ${cacheReadMs.toFixed(1)} ms`,
    );

    assert.equal(cached.doc.source, 'cache');
    assert.ok(cached.readyMs < 500, `cached index took ${cached.readyMs} ms`);
    assert.ok(peakScan < RSS_LIMIT_5GB, `peak RSS while indexing ${mb(peakScan)} >= 400 MB`);
    assert.ok(peakCache < RSS_LIMIT_5GB, `peak RSS on cached open ${mb(peakCache)} >= 400 MB`);
  });
}
