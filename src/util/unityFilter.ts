/**
 * Per-artboard Unity sync opt-in (strict), with a working-set override.
 *
 * In the editor, each artboard has a "Sync to Unity" checkbox (and library
 * folders have a folder-level switch that cascades). A project may hold 100
 * drafts but only 3 artboards that belong in the Unity project, so the CLI
 * mirrors the in-app sync button and pulls ONLY the flagged ones.
 *
 * Strict opt-in: `unity === true` syncs, anything else does not. A missing
 * flag means the server didn't say (older edge deploy, or a budget-starved
 * manifest backfill) — those entries are excluded and reported via
 * `unknown` so the caller can warn instead of silently syncing the whole
 * library into someone's game project.
 *
 * Exception: sprites already in the game (connect working set / previously
 * synced keys) always pull. An editor save nulls `artboard_index` and the
 * next manifest often omits `unity` (or rebuilds it as false because the
 * layer JSON dropped `syncToUnity`). Those saves must still write back to
 * the original PNG.
 */

export interface UnityFilterable {
  unity?: boolean;
  key?: string;
  previous_keys?: string[];
  asset_id?: string;
}

export interface UnityFilterResult<T> {
  entries: T[];
  /** True when the manifest had entries but none were flagged for Unity. */
  noneFlagged: boolean;
  /** Entries whose `unity` flag the server omitted (excluded from `entries`). */
  unknown: T[];
}

export function filterUnityManifest<T extends UnityFilterable>(
  manifest: T[],
  opts: { syncAll?: boolean } = {},
): UnityFilterResult<T> {
  if (opts.syncAll) return { entries: manifest, noneFlagged: false, unknown: [] };
  const entries = manifest.filter((e) => e.unity === true);
  const unknown = manifest.filter((e) => typeof e.unity !== 'boolean');
  return {
    entries,
    noneFlagged: manifest.length > 0 && entries.length === 0,
    unknown,
  };
}

/** Keys we already write to on disk — connect globs plus those sprites' cloud aliases. */
export function workingSetPullKeys(
  sourceByKey: ReadonlyMap<string, string>,
  synced?: Record<string, { assetId?: string }>,
): { keys: Set<string>; assetIds: Set<string> } {
  const keys = new Set(sourceByKey.keys());
  const assetIds = new Set<string>();
  if (synced) {
    for (const [key, sprite] of Object.entries(synced)) {
      if (!keys.has(key)) continue;
      if (sprite.assetId) assetIds.add(sprite.assetId);
    }
  }
  return { keys, assetIds };
}

export function isWorkingSetEntry<T extends UnityFilterable>(
  entry: T,
  pull: { keys: Set<string>; assetIds: Set<string> },
): boolean {
  if (entry.key && pull.keys.has(entry.key)) return true;
  if (entry.previous_keys?.some((k) => pull.keys.has(k))) return true;
  if (entry.asset_id && pull.assetIds.has(entry.asset_id)) {
    // Same document as a connected sprite. Post-save fallback (flag omitted)
    // must still pull; explicitly unflagged sibling artboards must not dump
    // into outDir.
    return entry.unity !== false;
  }
  return false;
}

/**
 * Flagged artboards, plus any working-set sprite whose Unity flag is missing
 * or false after an editor save / index rebuild.
 */
export function applyUnityPullPolicy<T extends UnityFilterable>(
  manifest: T[],
  opts: {
    syncAll?: boolean;
    alwaysPull?: (entry: T) => boolean;
  } = {},
): UnityFilterResult<T> {
  const filtered = filterUnityManifest(manifest, { syncAll: opts.syncAll });
  if (opts.syncAll || !opts.alwaysPull) return filtered;
  const already = new Set(filtered.entries);
  const extra = manifest.filter((e) => !already.has(e) && opts.alwaysPull!(e));
  if (extra.length === 0) return filtered;
  const extraSet = new Set(extra);
  return {
    entries: filtered.entries.concat(extra),
    unknown: filtered.unknown.filter((e) => !extraSet.has(e)),
    noneFlagged: false,
  };
}
