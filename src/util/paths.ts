import { resolve } from 'node:path';
import type { ManifestEntry } from '../api.js';

/**
 * Disk path for a manifest entry under `outDir`. Mirrors the MagicPixel
 * folder structure: `outDir/<folder>/<slug>.png`. Unsorted assets land at
 * `outDir/<slug>.png`.
 */
export function assetDiskPath(outDir: string, entry: ManifestEntry, cwd: string = process.cwd()): string {
  const base = resolve(cwd, outDir);
  const file = `${entry.slug}.png`;
  return entry.folder ? resolve(base, entry.folder, file) : resolve(base, file);
}
