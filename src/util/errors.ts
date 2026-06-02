import { relative } from 'node:path';

/**
 * Filesystem error codes that indicate a permission/lock problem rather than a
 * bug in our code. We rewrite these into multi-line, action-oriented messages
 * so a non-technical user can fix them without a Stack Overflow detour.
 */
const FS_PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'ETXTBSY']);

interface FsErrorContext {
  /** What we were trying to do — included verbatim in the message. */
  operation: string;
  /** Absolute or repo-relative path involved. Shown relative to cwd. */
  path: string;
  /** Optional second-line hint specific to the call site. */
  hint?: string;
}

/**
 * Returns `true` if the error is a filesystem permission error we know how to
 * rewrite. Useful for `try { … } catch (e) { if (isFsPermissionError(e)) … }`.
 */
export function isFsPermissionError(e: unknown): e is NodeJS.ErrnoException {
  return !!e && typeof e === 'object' && 'code' in e && FS_PERMISSION_CODES.has((e as NodeJS.ErrnoException).code ?? '');
}

/**
 * Wrap a filesystem permission error in a friendly, paste-to-AI message.
 * Returns the original error untouched if the code isn't one we recognize, so
 * callers can blindly `throw friendlyFsError(e, …)` without losing detail.
 */
export function friendlyFsError(e: unknown, ctx: FsErrorContext): Error {
  if (!isFsPermissionError(e)) return e instanceof Error ? e : new Error(String(e));
  const code = e.code ?? 'EACCES';
  const relPath = (() => {
    try {
      return relative(process.cwd(), ctx.path) || ctx.path;
    } catch {
      return ctx.path;
    }
  })();

  const lines = [`${ctx.operation} failed (${code}): ${relPath}`];

  if (code === 'EROFS') {
    lines.push('  Fix: outDir is on a read-only filesystem. Move it under your project source tree.');
  } else if (code === 'EBUSY' || code === 'ETXTBSY') {
    lines.push('  Fix: close any editor or program holding the file open and re-run.');
    lines.push('       (On Windows, OneDrive/Dropbox can also lock files briefly.)');
  } else {
    // EACCES / EPERM
    lines.push('  Fix: check that you can write to this path.');
    lines.push('    • Linux/macOS:  chmod -R u+w <path>  (or run from a different shell)');
    lines.push('    • Windows:      close OneDrive/your editor, or move outDir out of a synced folder');
  }
  if (ctx.hint) lines.push(`  ${ctx.hint}`);
  return new Error(lines.join('\n'));
}
