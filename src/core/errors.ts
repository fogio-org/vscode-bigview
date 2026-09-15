/** Human-readable messages for file system errors (SPEC §6 M6). */
import * as path from 'node:path';

export type FsAction = 'open' | 'read' | 'write' | 'export';

const VERBS: Record<FsAction, string> = { open: 'open', read: 'read', write: 'write', export: 'write' };

export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function describeFsError(err: unknown, filePath: string, action: FsAction): string {
  const name = path.basename(filePath);
  const verb = VERBS[action];
  switch (errorCode(err)) {
    case 'ENOENT':
      return action === 'write' || action === 'export'
        ? `Cannot ${verb} ${name}: the folder does not exist.`
        : `${name} was not found. It may have been deleted or moved.`;
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: cannot ${verb} ${name}.`;
    case 'ENOSPC':
      return `The disk is full: cannot ${verb} ${name}.`;
    case 'EDQUOT':
      return `The disk quota is exceeded: cannot ${verb} ${name}.`;
    case 'EROFS':
      return `The file system is read-only: cannot ${verb} ${name}.`;
    case 'EISDIR':
      return `${name} is a folder, not a file.`;
    case 'ENOTDIR':
      return `Cannot ${verb} ${name}: part of its path is not a folder.`;
    case 'EMFILE':
      return `Too many open files: cannot ${verb} ${name}.`;
    case 'EBUSY':
      return `${name} is locked by another program.`;
    default:
      return `Cannot ${verb} ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Errors that mean "cannot store data here" (worth telling the user about a failed cache write). */
export function isStorageError(err: unknown): boolean {
  return ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM'].includes(errorCode(err) ?? '');
}
