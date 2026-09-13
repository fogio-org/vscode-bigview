/**
 * Deterministic generator of large test files (log / jsonl / csv).
 *
 * Files are never committed — they are generated into test/.tmp/ before tests.
 *
 * CLI:
 *   tsx test/fixtures/generate.ts --size 1g --format log [--avg-line 120]
 *     [--marker-count 137 | --marker-ratio 0.001] [--marker NEEDLE_MARKER]
 *     [--seed 1] [--crlf] [--unicode] [--no-trailing-newline] [--out path]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type FixtureFormat = 'log' | 'jsonl' | 'csv';

export interface GenerateOptions {
  /** Output file path. */
  path: string;
  /** Approximate target size in bytes. Output stops at the first whole line that reaches it. */
  sizeBytes: number;
  format: FixtureFormat;
  /** Average line length in bytes (excluding terminator). Default 120. */
  avgLineLength?: number;
  /** Exact number of lines that contain the marker. Takes precedence over markerRatio. */
  markerCount?: number;
  /** Probability of a line containing the marker. */
  markerRatio?: number;
  /** Marker string. Default NEEDLE_MARKER. Vocabulary never contains it. */
  marker?: string;
  seed?: number;
  /** Use \r\n line terminators. */
  crlf?: boolean;
  /** Mix Cyrillic, CJK and emoji words into the text. */
  unicode?: boolean;
  /** Terminate the last line with a newline. Default true. */
  trailingNewline?: boolean;
}

export interface GenerateResult {
  path: string;
  bytes: number;
  lines: number;
  markerLines: number;
}

export const DEFAULT_MARKER = 'NEEDLE_MARKER';

const ASCII_WORDS = [
  'request', 'response', 'user', 'session', 'cache', 'miss', 'hit', 'timeout', 'retry', 'connection',
  'database', 'query', 'handler', 'started', 'finished', 'failed', 'payload', 'upstream', 'latency',
  'bytes', 'queue', 'job', 'worker', 'shard', 'replica', 'commit', 'rollback', 'token', 'expired',
  'granted', 'denied', 'lookup', 'resolved', 'socket', 'closed', 'opened', 'flush', 'compaction',
];
const UNICODE_WORDS = ['привет', 'ошибка', 'запрос', '日本語', '数据', '🚀', '🔥', 'café', 'naïve', 'Ж'];
const LEVELS = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR'];
const BLOCK_BYTES = 1 << 20;

/** mulberry32 — small, fast, deterministic. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFixture(opts: GenerateOptions): GenerateResult {
  const avg = Math.max(16, opts.avgLineLength ?? 120);
  const marker = opts.marker ?? DEFAULT_MARKER;
  const rng = makeRng(opts.seed ?? 1);
  const eol = opts.crlf ? '\r\n' : '\n';
  const eolBytes = eol.length;
  const trailingNewline = opts.trailingNewline ?? true;
  const words = opts.unicode ? [...ASCII_WORDS, ...UNICODE_WORDS] : ASCII_WORDS;
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

  // For an exact marker count, spread target byte positions uniformly over the file;
  // a line gets a marker when it covers one or more pending targets.
  const targets: number[] = [];
  if (opts.markerCount !== undefined) {
    for (let i = 0; i < opts.markerCount; i++) targets.push(Math.floor(rng() * opts.sizeBytes));
    targets.sort((x, y) => x - y);
  }
  let targetIdx = 0;
  let pendingMarkers = 0;

  fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  const fd = fs.openSync(opts.path, 'w');
  let block: string[] = [];
  let blockBytes = 0;
  let bytes = 0;
  let lines = 0;
  let markerLines = 0;
  let lineNo = 0;
  const startTime = Date.UTC(2026, 0, 1);

  const flush = (): void => {
    if (block.length === 0) return;
    fs.writeSync(fd, block.join(''));
    block = [];
    blockBytes = 0;
  };

  const text = (targetLen: number, withMarker: boolean): string => {
    const parts: string[] = [];
    let len = 0;
    const markerAt = withMarker ? Math.floor(rng() * 4) : -1;
    let i = 0;
    while (len < targetLen || i <= markerAt) {
      const w = i === markerAt ? marker : pick(words);
      parts.push(w);
      len += Buffer.byteLength(w) + 1;
      i++;
    }
    return parts.join(' ');
  };

  const makeLine = (withMarker: boolean): string => {
    const target = Math.max(8, Math.round(avg * (0.5 + rng())));
    const ts = new Date(startTime + lineNo * 37).toISOString();
    const level = pick(LEVELS);
    switch (opts.format) {
      case 'log': {
        const prefix = `${ts} ${level.padEnd(5)} [worker-${Math.floor(rng() * 16)}] `;
        return prefix + text(target - prefix.length, withMarker);
      }
      case 'jsonl': {
        const trace = Math.floor(rng() * 0xffffffff).toString(16).padStart(8, '0');
        const head = `{"ts":"${ts}","level":"${level.toLowerCase()}","trace_id":"${trace}","msg":"`;
        return head + text(target - head.length - 2, withMarker) + '"}';
      }
      case 'csv': {
        const head = `${lineNo},${ts},${level},user${Math.floor(rng() * 1000)},"`;
        return head + text(target - head.length - 1, withMarker) + '"';
      }
    }
  };

  const emit = (line: string, last: boolean): void => {
    const s = last && !trailingNewline ? line : line + eol;
    block.push(s);
    const n = Buffer.byteLength(s);
    blockBytes += n;
    bytes += n;
    lines++;
    lineNo++;
    if (blockBytes >= BLOCK_BYTES) flush();
  };

  try {
    if (opts.format === 'csv') emit('id,ts,level,user,message', opts.sizeBytes <= 0);

    while (bytes < opts.sizeBytes) {
      const lineEndEstimate = bytes + avg + eolBytes;
      while (targetIdx < targets.length && (targets[targetIdx] as number) < lineEndEstimate) {
        pendingMarkers++;
        targetIdx++;
      }
      let withMarker: boolean;
      if (opts.markerCount !== undefined) {
        withMarker = pendingMarkers > 0;
        if (withMarker) pendingMarkers--;
      } else {
        withMarker = opts.markerRatio !== undefined && rng() < opts.markerRatio;
      }
      const line = makeLine(withMarker);
      if (withMarker) markerLines++;
      const isLast =
        bytes + Buffer.byteLength(line) + eolBytes >= opts.sizeBytes &&
        pendingMarkers === 0 &&
        targetIdx >= targets.length;
      emit(line, isLast);
      if (isLast) break;
    }
    // Any markers not placed yet (file ended early) go into trailing lines.
    const remaining = pendingMarkers + (targets.length - targetIdx);
    for (let i = 0; i < remaining; i++) {
      markerLines++;
      emit(makeLine(true), i === remaining - 1);
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }

  return { path: opts.path, bytes, lines, markerLines };
}

export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(s.trim());
  if (!m) throw new Error(`Bad size: ${s}`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

function main(argv: string[]): void {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(a.slice(2), next);
      i++;
    } else {
      args.set(a.slice(2), true);
    }
  }
  const str = (k: string): string | undefined => {
    const v = args.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const format = (str('format') ?? 'log') as FixtureFormat;
  const sizeBytes = parseSize(str('size') ?? '10m');
  const out = str('out') ?? path.join('test', '.tmp', `fixture-${str('size') ?? '10m'}.${format}`);
  const started = Date.now();
  const res = generateFixture({
    path: out,
    sizeBytes,
    format,
    avgLineLength: str('avg-line') ? Number(str('avg-line')) : undefined,
    markerCount: str('marker-count') ? Number(str('marker-count')) : undefined,
    markerRatio: str('marker-ratio') ? Number(str('marker-ratio')) : undefined,
    marker: str('marker'),
    seed: str('seed') ? Number(str('seed')) : undefined,
    crlf: args.has('crlf'),
    unicode: args.has('unicode'),
    trailingNewline: !args.has('no-trailing-newline'),
  });
  console.log(JSON.stringify({ ...res, ms: Date.now() - started }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main(process.argv.slice(2));
}
