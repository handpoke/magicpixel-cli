/**
 * Per-artboard Unity sync opt-in (strict).
 *
 * In the editor, each artboard has a "Sync to Unity" checkbox (and library
 * folders have a folder-level switch that cascades). A project may hold 100
 * drafts but only 3 artboards that belong in the Unity project, so the CLI
 * mirrors the in-app sync button and pulls ONLY the flagged ones.
 *
 * Strict opt-in: `unity === true` syncs, anything else does not. A missing
 * flag means the server didn't say (older edge deploy, or a budget-starved
 * manifest backfill) — those entries are excluded and reported via
 * `unknownFlags` so the caller can warn instead of silently syncing the whole
 * library into someone's game project.
 */

export interface UnityFilterable {
  unity?: boolean;
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
