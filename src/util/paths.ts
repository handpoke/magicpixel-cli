import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ManifestEntry } from '../api.js';
import { assertPathInsideRoot, assertSafeAssetSegments } from './security.js';

/**
 * Disk path for a manifest entry under `outDir`. Mirrors the MagicPixel
 * folder structure: `outDir/<folder>/<slug>.png`. Unsorted assets land at
 * `outDir/<slug>.png`.
 */
export function assetDiskPath(outDir: string, entry: ManifestEntry, cwd: string = process.cwd()): string {
  return resolveAssetDiskPath(outDir, entry.folder, entry.slug, entry.key, cwd);
}

/**
 * Same as `assetDiskPath` but takes a raw manifest key (`folder/slug` or
 * `slug`) — useful when we only have the prior key from a snapshot and don't
 * want to synthesize a fake `ManifestEntry` just to reuse the safety checks.
 */
export function assetDiskPathFromKey(outDir: string, key: string, cwd: string = process.cwd()): string {
  const parts = key.split('/');
  const slug = parts.pop() ?? key;
  const folder = parts.length ? parts.join('/') : null;
  return resolveAssetDiskPath(outDir, folder, slug, key, cwd);
}

function resolveAssetDiskPath(
  outDir: string,
  folder: string | null,
  slug: string,
  key: string,
  cwd: string,
): string {
  assertSafeAssetSegments(folder, slug, key);
  const base = resolve(cwd, outDir);
  const file = `${slug}.png`;
  const diskPath = folder ? resolve(base, folder, file) : resolve(base, file);
  assertPathInsideRoot(diskPath, base, 'outDir');
  return diskPath;
}

/**
 * On-disk asset record. Output of `walkOutDirPngs` — used both by the
 * sync-time orphan scan (which cares about `abs`) and by the typed-index
 * emitter (which cares about `folder/slug/key`).
 */
export interface DiskAsset {
  /** Absolute path to the `.png` file. */
  abs: string;
  /** `folder/sub` joined with `/`, or null when the file sits at outDir root. */
  folder: string | null;
  /** Basename without the `.png` suffix. */
  slug: string;
  /** Manifest-compatible key: `folder/slug` or `slug`. */
  key: string;
}

/**
 * Recursively walk `outDir` and return every `*.png` on disk. Skips symlinks
 * and dot-prefixed directories. Gates every path through `assertPathInsideRoot`
 * so a symlink/junction outside the tree can't sneak into the result.
 *
 * Single canonical disk walker — replaces the two near-identical implementations
 * that used to live in `sync.ts` (`findLocalPngs`) and `emitIndex.ts`
 * (`scanDiskAssets`).
 */
export async function walkOutDirPngs(
  outDir: string,
  cwd: string = process.cwd(),
): Promise<DiskAsset[]> {
  const root = resolve(cwd, outDir);
  if (!existsSync(root)) return [];
  const out: DiskAsset[] = [];
  async function walk(dir: string, folderParts: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = resolve(dir, ent.name);
      try {
        assertPathInsideRoot(full, root, 'outDir');
      } catch {
        continue;
      }
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue;
        await walk(full, [...folderParts, ent.name]);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.png')) {
        const slug = ent.name.slice(0, -4);
        const folder = folderParts.length ? folderParts.join('/') : null;
        const key = folder ? `${folder}/${slug}` : slug;
        out.push({ abs: full, folder, slug, key });
      }
    }
  }
  await walk(root, []);
  return out;
}

/**
 * DFS post-order walk that collects every subdirectory of `root` whose entire
 * subtree contains no files. Never includes `root` itself. Shared by
 * `pruneEmptyDirs` (deletes) and `repair --dry-run` (reports).
 *
 * Returns directories in post-order so callers that delete sequentially never
 * try to remove a parent before its children. Soft-fails on per-directory
 * readdir errors (returns "not empty" so we never delete a directory we
 * can't actually enumerate).
 */
export async function listEmptyDirs(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  async function walk(d: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    let hasFile = false;
    let allChildrenEmpty = true;
    for (const ent of entries) {
      const full = resolve(d, ent.name);
      if (ent.isDirectory()) {
        const childEmpty = await walk(full);
        if (childEmpty) out.push(full);
        else allChildrenEmpty = false;
      } else {
        hasFile = true;
      }
    }
    return !hasFile && allChildrenEmpty;
  }
  await walk(root);
  return out;
}

/**
 * Recursively delete empty subdirectories under `root`. Never removes `root`
 * itself. Idempotent and safe to call after every prune pass.
 */
export async function pruneEmptyDirs(root: string): Promise<void> {
  const empties = await listEmptyDirs(root);
  // `listEmptyDirs` returns post-order, so deleting sequentially never tries
  // to remove a parent before its children. `force: true` swallows the rare
  // race where a sibling pass already removed the directory.
  for (const p of empties) {
    await rm(p, { recursive: true, force: true });
  }
}
