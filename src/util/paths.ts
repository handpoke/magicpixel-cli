import { resolve } from 'node:path';
import type { ManifestEntry } from '../api.js';
import { assertPathInsideRoot, assertSafeAssetSegments } from './security.js';

/**
 * Disk path for a manifest entry under `outDir`. Mirrors the MagicPixel
 * folder structure: `outDir/<folder>/<slug>.png`. Unsorted assets land at
 * `outDir/<slug>.png`.
 */
export function assetDiskPath(outDir: string, entry: ManifestEntry, cwd: string = process.cwd()): string {
  assertSafeAssetSegments(entry.folder, entry.slug, entry.key);
  const base = resolve(cwd, outDir);
  const file = `${entry.slug}.png`;
  const diskPath = entry.folder ? resolve(base, entry.folder, file) : resolve(base, file);
  assertPathInsideRoot(diskPath, base, 'outDir');
  return diskPath;
}
