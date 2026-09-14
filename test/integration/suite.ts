/**
 * Integration tests, executed inside the VS Code extension host.
 * A tiny sequential runner keeps the project free of extra test dependencies.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { BigViewDocument, BigViewEditor } from '../../src/editor/BigViewProvider';
import type { SearchState } from '../../src/editor/SearchController';
import type { BigViewApi } from '../../src/extension';
import { formatCount } from '../../src/shared/format';
import type { HitTarget } from '../../src/shared/protocol';
import { compileQuery, type SearchQuery } from '../../src/shared/searchQuery';
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

const sameQuery = (a: SearchQuery | undefined, b: SearchQuery): boolean =>
  !!a && a.text === b.text && a.caseSensitive === b.caseSensitive && a.wholeWord === b.wholeWord && a.regex === b.regex;

/** Types the query into the webview search bar (real webview path) and waits for the result. */
async function runSearch(editor: BigViewEditor, input: QueryInput, timeoutMs = 30_000): Promise<{ state: SearchState; ms: number }> {
  const query: SearchQuery = { caseSensitive: true, wholeWord: false, regex: false, ...input };
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
  if (state.status === 'done' && state.stored > 0) {
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
    const firstId = seen.find((s) => s.query?.text.endsWith('NOPE'))?.searchId;
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
