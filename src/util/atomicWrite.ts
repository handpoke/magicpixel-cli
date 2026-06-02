import { writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { tmpPathFor } from './security.js';

export interface AtomicWriteOpts {
  /** POSIX file mode to chmod the staged tmp file to *before* rename, so the
   *  final file lands with the correct perms atomically (avoids the brief
   *  window between rename and a follow-up chmod). Best-effort on platforms
   *  that don't honor chmod (Windows). */
  mode?: number;
}

/**
 * Stage-and-rename file write. A crash mid-write can never leave a truncated
 * file on disk — the rename is atomic on every POSIX FS and on NTFS. Used
 * everywhere a corrupted target would break the project (state.json,
 * package.json, magicpixel.json, credentials, AGENTS.md, generated index files,
 * asset PNGs from `sync`).
 *
 * Accepts `string | Uint8Array` so the asset-bytes writer in `sync` can reuse
 * this instead of duplicating the staging logic (one of the two prior leak
 * sites — see CHANGELOG 0.5.1).
 *
 * CRITICAL: On ANY failure between staging and rename, the tmp file is
 * unlinked before the original error is rethrown. Without this, every rare
 * `rename` failure (FS hiccup, AV scan, racing writer, ENOSPC) leaks a
 * `<path>.<pid>.<hex>.tmp` file forever — `saveState` runs every watch tick,
 * so even a low failure rate accumulates hundreds of stale tmps over a long
 * dev session and they're invisible to the `.png`-only orphan walker.
 */
export async function atomicWrite(
  path: string,
  contents: string | Uint8Array,
  opts: AtomicWriteOpts = {},
): Promise<void> {
  const tmp = tmpPathFor(path);
  try {
    if (typeof contents === 'string') {
      const writeOpts: Parameters<typeof writeFile>[2] =
        opts.mode !== undefined ? { encoding: 'utf8', mode: opts.mode } : 'utf8';
      await writeFile(tmp, contents, writeOpts);
    } else {
      const writeOpts: Parameters<typeof writeFile>[2] | undefined =
        opts.mode !== undefined ? { mode: opts.mode } : undefined;
      await writeFile(tmp, contents, writeOpts);
    }
    if (opts.mode !== undefined) {
      // Belt-and-suspenders: writeFile's `mode` only applies on create. If the
      // tmp path was somehow pre-existing (collision is vanishingly unlikely
      // given the pid+random suffix) the chmod ensures the perms land.
      try {
        await chmod(tmp, opts.mode);
      } catch {
        // Windows / read-only FS — ignore.
      }
    }
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup. We don't want a cleanup failure (e.g. tmp was
    // never created because writeFile threw on the very first syscall) to
    // mask the real error the caller cares about.
    try {
      await unlink(tmp);
    } catch {
      /* ignore — tmp may not exist */
    }
    throw err;
  }
}
