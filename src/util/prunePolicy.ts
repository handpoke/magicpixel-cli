/**
 * Which local PNGs a full sync is allowed to delete.
 *
 * Pruning used to be "anything on disk the manifest didn't mention". Two-way
 * Unity sync breaks that assumption in two directions:
 *
 *   - Strict Unity opt-in excludes entries whose `unity` flag the server
 *     omitted (older edge deploy, work-budget-starved manifest backfill). Those
 *     are "unknown", not "unwanted" — deleting their sprite because of a
 *     transient server response would be data loss inside someone's game
 *     project. They're protected instead.
 *   - Sprites authored in Unity have no manifest entry until `magicpixel push`
 *     adopts them. They're pending, not orphaned.
 *
 * Everything we HAVE synced before (it's in `state.synced`) and that the
 * manifest no longer references is a genuine orphan and still prunes: renames,
 * deletions, and un-checked "Sync to Unity" boxes all keep working.
 */

export interface PrunePolicyInput {
  /** Absolute paths of every `*.png` found under `outDir`. */
  localPaths: readonly string[];
  /** Absolute disk paths the current manifest maps to. */
  remoteDiskPaths: ReadonlySet<string>;
  /** Paths we must not delete this run (unknown Unity flag, etc). */
  protectedPaths?: ReadonlySet<string>;
  /**
   * True when the CLI has synced this path before — i.e. `state.synced` (or the
   * legacy id→key snapshot) knows about it. Untracked paths are pending push.
   */
  isTracked: (absPath: string) => boolean;
}

export interface PrunePolicyResult {
  /** Safe to delete. */
  orphans: string[];
  /** On disk, never synced from the cloud — candidates for `magicpixel push`. */
  pendingPush: string[];
}

export function selectFullSyncOrphans({
  localPaths,
  remoteDiskPaths,
  protectedPaths,
  isTracked,
}: PrunePolicyInput): PrunePolicyResult {
  const orphans: string[] = [];
  const pendingPush: string[] = [];
  for (const p of localPaths) {
    if (remoteDiskPaths.has(p)) continue;
    if (protectedPaths?.has(p)) continue;
    if (isTracked(p)) orphans.push(p);
    else pendingPush.push(p);
  }
  return { orphans, pendingPush };
}
