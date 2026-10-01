/**
 * `sync --only <folder>`: limit both halves of a sync (push + pull + prune) to
 * a few game folders. Everything outside the scope is treated as hold-only —
 * never pulled, pushed, or deleted — so a huge project can be watched one
 * folder at a time.
 */
import { relative } from 'node:path';
import { keyInFolder, parseFolderArg } from '../commands/resync.js';

export interface SyncScope {
  /** cwd-relative folders, `/`-separated, no leading/trailing slash, lowercase. */
  folders: string[];
  /** Same folders as manifest-key slug segments. */
  keySegments: string[][];
}

/** Accepts `/Runtime/Foo/`, `Runtime\\Foo`, `Runtime/Foo/**`. */
export function normalizeScopeFolder(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/\*\*?$/g, '')
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

export function resolveSyncScope(inputs: readonly string[] | undefined): SyncScope | null {
  const folders = Array.from(
    new Set((inputs ?? []).map(normalizeScopeFolder).filter(Boolean)),
  );
  if (folders.length === 0) return null;
  return {
    folders: folders.map((f) => f.toLowerCase()),
    keySegments: folders.map(parseFolderArg).filter((s) => s.length > 0),
  };
}

/** Is a cwd-relative (or absolute) path inside the scope? */
export function pathInScope(scope: SyncScope, path: string): boolean {
  const rel = (path.startsWith('/') || /^[a-z]:/i.test(path) ? relative(process.cwd(), path) : path)
    .replace(/\\/g, '/')
    .toLowerCase();
  return scope.folders.some((f) => rel === f || rel.startsWith(`${f}/`));
}

/** A manifest key is in scope when its game file or its library folder is. */
export function keyInScope(scope: SyncScope, key: string, sourceRel?: string): boolean {
  if (sourceRel) return pathInScope(scope, sourceRel);
  return scope.keySegments.some((segs) => keyInFolder(key, segs));
}

/** Stable fingerprint persisted in state — a change forces one full pass. */
export function scopeFingerprint(scope: SyncScope | null): string | undefined {
  return scope ? [...scope.folders].sort().join('|') : undefined;
}
