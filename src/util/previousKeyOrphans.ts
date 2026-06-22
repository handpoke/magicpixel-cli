import type { ManifestEntry } from '../api.js';

export interface PreviousKeyRename {
  id: string;
  oldKey: string;
  newKey: string;
}

export interface PreviousKeyOrphansInput {
  manifest: ManifestEntry[];
  /** Set of canonical disk paths currently emitted by the live manifest. */
  remoteDiskPaths: Set<string>;
  /** Resolve a manifest key (e.g. `tiles/grass`) to its on-disk PNG path. */
  resolveDiskPath: (key: string) => string;
  /** Existence check, injectable for tests. */
  fileExists: (path: string) => boolean;
}

export interface PreviousKeyOrphansResult {
  /** Disk paths to prune. */
  orphanPaths: string[];
  /** Rename hints to surface to the user. */
  renames: PreviousKeyRename[];
}

/**
 * Walk each manifest entry's `previous_keys`, emit orphan paths + rename
 * hints for prior composite keys whose PNGs still exist on disk and are
 * NOT shadowed by a live manifest entry.
 *
 * Pure / side-effect-free — file existence + path resolution are injected
 * so this is unit-testable without touching the real filesystem.
 *
 * The same `previous_keys` array is repeated on every entry from a given
 * row; the `(id|prevKey)` signature set keeps the work idempotent.
 */
export function computePreviousKeyOrphans(
  input: PreviousKeyOrphansInput,
): PreviousKeyOrphansResult {
  const { manifest, remoteDiskPaths, resolveDiskPath, fileExists } = input;
  const orphans = new Set<string>();
  const renames: PreviousKeyRename[] = [];
  const seen = new Set<string>();

  for (const entry of manifest) {
    if (!entry.previous_keys || entry.previous_keys.length === 0) continue;
    for (const prevKey of entry.previous_keys) {
      if (prevKey === entry.key) continue;
      const sig = `${entry.id}|${prevKey}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      const prevPath = resolveDiskPath(prevKey);
      // Skip when another live entry owns the old path (e.g. the "old" name
      // is still actively used by a different row in the same project).
      if (remoteDiskPaths.has(prevPath)) continue;
      if (!fileExists(prevPath)) continue;
      orphans.add(prevPath);
      if (!renames.some((r) => r.id === entry.id && r.oldKey === prevKey)) {
        renames.push({ id: entry.id, oldKey: prevKey, newKey: entry.key });
      }
    }
  }

  return { orphanPaths: [...orphans], renames };
}
