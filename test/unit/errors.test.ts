import { describe, expect, it } from 'vitest';
import { looksBinary } from '../../src/core/binary';
import { describeFsError, isStorageError } from '../../src/core/errors';

const err = (code: string, message = `${code}: something`): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

describe('describeFsError', () => {
  it('explains common file system errors', () => {
    expect(describeFsError(err('ENOENT'), '/logs/app.log', 'open')).toBe('app.log was not found. It may have been deleted or moved.');
    expect(describeFsError(err('ENOENT'), '/out/x.log', 'export')).toBe('Cannot write x.log: the folder does not exist.');
    expect(describeFsError(err('EACCES'), '/logs/app.log', 'read')).toBe('Permission denied: cannot read app.log.');
    expect(describeFsError(err('EPERM'), 'a.idx', 'write')).toBe('Permission denied: cannot write a.idx.');
    expect(describeFsError(err('ENOSPC'), '/cache/1.idx', 'write')).toBe('The disk is full: cannot write 1.idx.');
    expect(describeFsError(err('EROFS'), 'x', 'write')).toMatch(/read-only/);
    expect(describeFsError(err('EISDIR'), '/logs', 'open')).toBe('logs is a folder, not a file.');
    expect(describeFsError(err('EBUSY'), 'x.log', 'open')).toMatch(/locked/);
    expect(describeFsError(new Error('boom'), 'x.log', 'read')).toBe('Cannot read x.log: boom');
    expect(describeFsError('weird', 'x.log', 'read')).toBe('Cannot read x.log: weird');
  });

  it('classifies storage errors', () => {
    for (const code of ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM']) expect(isStorageError(err(code))).toBe(true);
    expect(isStorageError(err('ENOENT'))).toBe(false);
    expect(isStorageError(new Error('x'))).toBe(false);
  });
});

describe('looksBinary', () => {
  it('flags NUL bytes', () => {
    expect(looksBinary(new TextEncoder().encode('plain text\nпривет\n'))).toBe(false);
    expect(looksBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe(true); // UTF-16 LE
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
});
