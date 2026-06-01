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
