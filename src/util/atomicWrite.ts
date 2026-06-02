import { writeFile, rename, chmod } from 'node:fs/promises';
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
 * package.json, magicpixel.json, credentials, AGENTS.md, generated index files).
 */
export async function atomicWrite(
  path: string,
  contents: string,
  opts: AtomicWriteOpts = {},
): Promise<void> {
  const tmp = tmpPathFor(path);
  const writeOpts: Parameters<typeof writeFile>[2] =
    opts.mode !== undefined ? { encoding: 'utf8', mode: opts.mode } : 'utf8';
  await writeFile(tmp, contents, writeOpts);
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
}
