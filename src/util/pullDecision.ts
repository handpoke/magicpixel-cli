/**
 * Whether a manifest entry should be written to disk.
 *
 * Connected game PNGs are usually *not* the same bytes as MagicPixel's
 * re-encoded composite. Comparing those hashes would re-download the whole
 * library on every catch-up and overwrite the originals. Pull only when the
 * cloud composite actually changed since we last recorded it, or when there
 * is no local file to protect.
 */

export interface PullDecisionInput {
  cloudSha256: string | null | undefined;
  localSha256: string | null;
  /** Cloud composite sha from `state.synced` (last pull or push). */
  previousCloudSha256?: string;
  /** True when this key maps to an original game file (connect working set). */
  inWorkingSet: boolean;
}

export function shouldPullEntry(opts: PullDecisionInput): boolean {
  const cloud = opts.cloudSha256 ?? null;
  const local = opts.localSha256;
  const prev = opts.previousCloudSha256;

  // Missing on disk → restore from cloud (MagicPixel-only art and deletions).
  if (!local) return true;
  if (cloud && cloud === local) return false;
  // Cloud composite unchanged since last pull/push — keep the original PNG.
  if (cloud && prev && cloud === prev) return false;

  if (opts.inWorkingSet) {
    // Never recorded a cloud hash: disk is the source of truth (connect/ingest).
    if (!prev) return false;
    // Editor save often nulls the cached hash; treat that as a cloud change.
    return true;
  }

  return true;
}
