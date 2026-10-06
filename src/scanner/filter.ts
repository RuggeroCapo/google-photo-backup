import path from 'node:path';
import { extensionOf } from '../mime.js';

/**
 * Directory / file names never worth looking at: hidden entries, NAS
 * thumbnail caches, OS metadata and recycle bins.
 */
const IGNORED_NAMES = new Set([
  '@eaDir',
  '#recycle',
  '#snapshot',
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
  'Thumbs.db',
]);

export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || IGNORED_NAMES.has(name);
}

export class FileFilter {
  constructor(
    readonly root: string,
    private readonly extensions: Set<string>,
  ) {}

  /** Should this file (absolute path) be backed up? */
  accepts(absPath: string): boolean {
    const rel = this.relative(absPath);
    if (rel === null) return false;
    if (rel.split('/').some(isIgnoredName)) return false;
    return this.extensions.has(extensionOf(absPath));
  }

  /** Should this path be skipped entirely by the watcher (dirs included)? */
  ignoresPath(absPath: string): boolean {
    const rel = this.relative(absPath);
    if (rel === null) return true;
    if (rel === '') return false;
    return rel.split('/').some(isIgnoredName);
  }

  /** POSIX-style path relative to the root, or null if outside it. */
  relative(absPath: string): string | null {
    const rel = path.relative(this.root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  absolute(relPath: string): string {
    return path.join(this.root, ...relPath.split('/'));
  }
}
