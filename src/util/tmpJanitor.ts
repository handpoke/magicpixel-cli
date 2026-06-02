import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Pattern produced by `tmpPathFor`: `<basename>.<pid>.<16-hex>.tmp`.
 * Anchored at both ends to avoid matching user files that happen to contain
 * the substring.
 */
const TMP_SUFFIX_RE = /\.\d+\.[0-9a-f]{16}\.tmp$/;

/**
 * Stale-tmp age threshold. Any tmp file modified within this window could
 * still belong to a concurrent writer (another CLI process, or an in-flight
 * write in this process whose `rename` is about to land). Skipping recent
 * files is the safety net that makes the janitor side-effect-free for the
 * happy path.
 */
const MIN_STALE_AGE_MS = 30_000;

/**
 * Walk `dirs` recursively (one level deep is enough for our layout — the
 * outDir is `src/assets/magicpixel/<folder>/*.png` and state lives in
 * `.magicpixel/`). Returns absolute paths of removed files. Errors during
 * readdir/unlink are swallowed individually so one unreadable directory
 * can't abort the whole sweep.
 *
 * Exported for tests; the entry point used by sync is `runTmpJanitor`.
 */
export async function sweepTmpFiles(
  dir: string,
  now: number = Date.now(),
  minAgeMs: number = MIN_STALE_AGE_MS,
): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // One level of recursion (e.g. outDir/<folder>/). Deeper trees are not
      // produced by atomicWrite callers.
      const nested = await sweepTmpFiles(full, now, minAgeMs);
      for (const p of nested) removed.push(p);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!TMP_SUFFIX_RE.test(ent.name)) continue;
    try {
      const st = await stat(full);
      if (now - st.mtimeMs < minAgeMs) continue;
      await unlink(full);
      removed.push(full);
    } catch {
      /* ignore — file may have just been renamed away by a concurrent writer */
    }
  }
  return removed;
}

/**
 * Run the janitor across the directories that atomicWrite targets land in:
 *   - `<outDir>/**` — asset PNGs (one level of folders).
 *   - `<cwd>/.magicpixel/` — state.json + credentials.
 *   - `<cwd>/` — package.json, magicpixel.json, AGENTS.md.
 *
 * Side-effect-free for the happy path: the `MIN_STALE_AGE_MS` floor prevents
 * any race with a concurrent in-flight write.
 */
export async function runTmpJanitor(
  outDir: string,
  cwd: string = process.cwd(),
): Promise<string[]> {
  const dirs = [outDir, join(cwd, '.magicpixel'), cwd];
  const all: string[] = [];
  for (const d of dirs) {
    const r = await sweepTmpFiles(d);
    for (const p of r) all.push(p);
  }
  return all;
}
