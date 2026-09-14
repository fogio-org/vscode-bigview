import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChunkReader } from '../../src/core/ChunkReader';
import { FileHandlePool } from '../../src/core/FileHandlePool';
import { buildIndex, enc, tmpDir } from './helpers';

const dir = tmpDir('line-text');
const pool = new FileHandlePool({ idleMs: 50 });
afterAll(() => {
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function reader(content: string, stride = 3): ChunkReader {
  const data = enc(content);
  const file = path.join(dir, `f${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, data);
  return new ChunkReader(pool, file, buildIndex(data, { stride }));
}

describe('ChunkReader.readLineText', () => {
  it('reads whole lines beyond the display cap, without terminators or BOM', async () => {
    const long = `{"msg":"${'я'.repeat(40_000)}"}`;
    const r = reader(`﻿first\r\n${long}\nlast`);
    expect(await r.readLineText(0, 1 << 20)).toEqual({ text: 'first', truncated: false });
    expect(await r.readLineText(1, 1 << 20)).toEqual({ text: long, truncated: false });
    expect(await r.readLineText(2, 1 << 20)).toEqual({ text: 'last', truncated: false });
  });

  it('truncates at maxBytes on a character boundary', async () => {
    const r = reader(`a\n${'я'.repeat(100)}\nb`);
    const res = await r.readLineText(1, 51);
    expect(res.truncated).toBe(true);
    expect(res.text).toBe('я'.repeat(25));
    expect(await r.readLineText(1, 200)).toEqual({ text: 'я'.repeat(100), truncated: false });
    expect(await r.readLineText(1, 200 - 1)).toMatchObject({ truncated: true });
  });

  it('rejects lines out of range', async () => {
    await expect(reader('one\ntwo\n').readLineText(2, 100)).rejects.toThrow(RangeError);
  });
});
