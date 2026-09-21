/**
 * Per-artboard game sync opt-in (strict).
 *
 * A project may hold 100 drafts but only 3 artboards that belong in the game,
 * so the CLI mirrors the in-app Sync to Game action and pulls ONLY the
 * explicitly flagged ones.
 *
 * Strict opt-in: `unity === true` syncs, anything else does not. A missing
 * flag means the server didn't say (older edge deploy, or a budget-starved
 * manifest backfill) — those entries are excluded and reported via
 * `unknown` so the caller can warn instead of silently syncing the whole
 * library into someone's game project.
 *
 * There is deliberately no working-set override: a local path or previous
 * download must never turn an unmarked sibling into a pull candidate.
 */

export interface UnityFilterable {
  unity?: boolean;
  /** Server withheld this document (unreleased edits) — hold, never pull. */
  withheld?: boolean;
  key?: string;
  folder?: string | null;
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

/**
 * Split the manifest into syncable entries and withheld ones. Withheld entries
 * are never pull candidates and carry no bytes;
 * callers use them only to protect what's already on disk from pruning.
 */
export function partitionWithheldEntries<T extends UnityFilterable>(
  manifest: T[],
): { entries: T[]; withheld: T[] } {
  const withheld: T[] = [];
  const entries: T[] = [];
  for (const e of manifest) (e.withheld === true ? withheld : entries).push(e);
  return { entries, withheld };
}

export function filterUnityManifest<T extends UnityFilterable>(
  manifest: T[],
): UnityFilterResult<T> {
  const syncable = partitionWithheldEntries(manifest).entries;
  const entries = syncable.filter((e) => e.unity === true);
  const unknown = syncable.filter((e) => typeof e.unity !== 'boolean');
  return {
    entries,
    noneFlagged: syncable.length > 0 && entries.length === 0,
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
 * Whether an explicitly unmarked manifest entry should leave the local game.
 * A file previously pulled by MagicPixel is safe to reconcile even if it now
 * matches a connect glob; a game-authored working-set file without a sync
 * baseline remains protected.
 */
export function shouldPruneDeselectedEntry(
  entry: UnityFilterable,
  opts: { sourceByKey: ReadonlyMap<string, string>; syncedKeys: ReadonlySet<string> },
): boolean {
  if (!entry.key) return false;
  return !opts.sourceByKey.has(entry.key) || opts.syncedKeys.has(entry.key);
}

/**
 * Flagged artboards, plus any working-set sprite whose Unity flag is missing
 * or false after an editor save / index rebuild.
 */
