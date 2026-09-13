/**
 * Integration tests, executed inside the VS Code extension host.
 * A tiny sequential runner keeps the project free of extra test dependencies.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { BigViewDocument } from '../../src/editor/BigViewProvider';
import type { BigViewApi } from '../../src/extension';
import type { GenerateResult } from '../fixtures/generate';
import { FIXTURES, loadFixture, type FixtureSpec } from './fixtures';

const ROOT = process.env.BIGVIEW_ROOT ?? process.cwd();
const MB = 1024 * 1024;
const FIRST_PAGE_BUDGET_MS = 500;

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
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${tests.length} integration tests failed`);
}

async function api(): Promise<BigViewApi> {
  const ext = vscode.extensions.getExtension<BigViewApi>('fogio.bigview');
  assert.ok(ext, 'extension not found');
  return ext.activate();
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const fixture = (spec: FixtureSpec): GenerateResult => loadFixture(ROOT, spec);

async function openAndMeasure(
  gen: GenerateResult,
  open: (uri: vscode.Uri) => Thenable<unknown>,
): Promise<{ doc: BigViewDocument; firstPageMs: number; indexMs: number }> {
  const { provider } = await api();
  const uri = vscode.Uri.file(gen.path);
  const t0 = performance.now();
  await open(uri);
  const doc = await waitFor(() => provider.findDocument(uri), 5000, 'document');
  const firstLinesAt = await waitFor(() => doc.firstLinesAt, 5000, 'first lines sent to webview');
  const firstPageMs = firstLinesAt - t0;
  const outcome = await doc.indexed;
  const indexMs = performance.now() - t0;
  assert.equal(doc.error, undefined);
  assert.equal(outcome?.status, 'done');
  assert.equal(doc.index.lineCount, gen.lines, 'line count');
  return { doc, firstPageMs, indexMs };
}

const TS_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO |DEBUG|WARN |ERROR) \[worker-\d+\] /;

async function checkSampledLines(doc: BigViewDocument, lineCount: number): Promise<void> {
  const samples = [0, 1, Math.floor(lineCount / 2), lineCount - 2, lineCount - 1];
  for (let i = 0; i < 20; i++) samples.push(Math.floor(Math.random() * lineCount));
  for (const line of samples) {
    const res = await doc.reader.readLines(line, 3);
    for (const text of res.lines) {
      assert.match(text, TS_PREFIX, `line ${line} looks misaligned: ${text.slice(0, 80)}`);
      assert.ok(!text.includes('\n') && !text.includes('\r'));
    }
  }
}

function reportRss(label: string): void {
  console.log(`    ${label}: rss=${Math.round(process.memoryUsage().rss / MB)} MB`);
}

test('opens a 10 MB log via "BigView: Open File in BigView" and reads exact content', async () => {
  const gen = fixture(FIXTURES.small);
  const { doc, firstPageMs, indexMs } = await openAndMeasure(gen, (uri) =>
    vscode.commands.executeCommand('bigview.openFile', uri),
  );
  console.log(`    first page ${firstPageMs.toFixed(0)} ms, indexed in ${indexMs.toFixed(0)} ms`);
  assert.ok(firstPageMs < FIRST_PAGE_BUDGET_MS, `first page took ${firstPageMs} ms`);

  // Small enough to compare against a naive split in the test.
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

if (process.env.BIGVIEW_LARGE) {
  for (const [label, spec] of [['200 MB', FIXTURES.m200], ['1 GB', FIXTURES.g1]] as const) {
    test(`opens a ${label} log: first page < ${FIRST_PAGE_BUDGET_MS} ms, index is exact`, async () => {
      const gen = fixture(spec);
      reportRss('before open');
      const { doc, firstPageMs, indexMs } = await openAndMeasure(gen, (uri) =>
        vscode.commands.executeCommand('vscode.openWith', uri, 'bigview.viewer'),
      );
      console.log(`    first page ${firstPageMs.toFixed(0)} ms, indexed in ${indexMs.toFixed(0)} ms, ${gen.lines} lines`);
      reportRss('after index');
      assert.ok(firstPageMs < FIRST_PAGE_BUDGET_MS, `first page took ${firstPageMs} ms`);
      await checkSampledLines(doc, gen.lines);
    });
  }
}
