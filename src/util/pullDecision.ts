/**
 * Whether a manifest entry should be written to disk.
 *
 * Connected game PNGs are usually *not* the same bytes as MagicPixel's
 * re-encoded composite. Comparing those hashes would re-download the whole
 * library on every catch-up and overwrite the originals. Pull only when the
 * cloud composite actually changed since we last recorded it, or when there
 * is no local file to protect.
 *
 * Third outcome: `conflict`. `sync` pulls before it pushes, so a PNG edited on
 * disk *and* in MagicPixel since the last sync would be overwritten before
 * `push` ever sees it — the local edit would vanish with no message. When the
 * disk bytes diverge from the fingerprint we recorded when we last wrote/pushed
 * that file, the entry is reported instead of downloaded.
 */

import { isLocalEdit } from './localEdit.js';

export type PullDecision = 'pull' | 'skip' | 'conflict';

export interface PullDecisionInput {
  cloudSha256: string | null | undefined;
  localSha256: string | null;
  /** Cloud composite sha from `state.synced` (last pull or push). */
  previousCloudSha256?: string;
  /** Disk sha recorded when we last wrote/pushed this file (`diskSha256`). */
  lastPushedDiskSha256?: string;
  /** True when this key maps to an original game file (connect working set). */
  inWorkingSet: boolean;
  /** Explicit editor Sync marker carried by the current manifest entry. */
  releasedAt?: string;
  /** Last release marker this local state has already consumed. */
  previousReleasedAt?: string;
  releasedVersion?: number;
  previousReleasedVersion?: number;
  /** Cursor from a pre-marker CLI state; used only for safe upgrade detection. */
  lastSync?: string;
}

/** A newer editor Sync press explicitly chooses MagicPixel for this sprite. */
export function hasNewExplicitRelease(opts: Pick<
  PullDecisionInput,
  'releasedAt' | 'previousReleasedAt' | 'releasedVersion' | 'previousReleasedVersion' | 'lastSync'
>): boolean {
  if (opts.releasedVersion != null && opts.previousReleasedVersion != null) {
    return opts.releasedVersion > opts.previousReleasedVersion;
  }
  if (!opts.releasedAt) return false;
  const released = Date.parse(opts.releasedAt);
  if (!Number.isFinite(released)) return false;
  const baseline = opts.previousReleasedAt ?? opts.lastSync;
  if (!baseline) return false;
  const previous = Date.parse(baseline);
  return Number.isFinite(previous) && released > previous;
}

/**
 * Cheap "nothing to do" test that runs before we hash the local PNG and before
 * any per-file request. Two ways to prove a row is unchanged:
 *
 *  1. The manifest still reports the exact cloud composite sha we recorded.
 *  2. The manifest has no sha at all (legacy / uncached documents) but the
 *     row's `updated_at` has not moved since we last synced this key. A row
 *     cannot change — including an editor Sync release — without its
 *     `updated_at` advancing, so there is nothing to fetch.
 *
 * Case 2 is what stops a quiet project from spending one conditional download
 * per file on every sync just to be told "304 Not Modified".
 */
export function canSkipWithoutHashing(opts: {
  freshRelease: boolean;
  fileExists: boolean;
  cloudSha256?: string | null;
  previousCloudSha256?: string;
  cloudUpdatedAt?: string;
  previousCloudUpdatedAt?: string;
}): boolean {
  if (opts.freshRelease || !opts.fileExists) return false;
  if (opts.cloudSha256 && opts.previousCloudSha256 === opts.cloudSha256) return true;
  if (opts.cloudSha256) return false;
  return Boolean(
    opts.cloudUpdatedAt &&
      opts.previousCloudUpdatedAt &&
      opts.cloudUpdatedAt === opts.previousCloudUpdatedAt,
  );
}

export function decidePull(opts: PullDecisionInput): PullDecision {
  const cloud = opts.cloudSha256 ?? null;
  const local = opts.localSha256;
  const prev = opts.previousCloudSha256;

  // A fresh explicit release is the user's scoped instruction for the cloud
  // copy to replace this PNG, even if the PNG also changed locally.
  if (hasNewExplicitRelease(opts)) return 'pull';

  // Missing on disk → restore from cloud (MagicPixel-only art and deletions).
  if (!local) return 'pull';
  if (cloud && cloud === local) return 'skip';
  // Cloud composite unchanged since last pull/push — keep the original PNG.
  if (cloud && prev && cloud === prev) return 'skip';

  if (opts.inWorkingSet) {
    // Never recorded a cloud hash: disk is the source of truth (connect/ingest).
    if (!prev) return 'skip';
    // Editor save often nulls the cached hash; treat that as a cloud change.
    return localEdit(opts) ? 'conflict' : 'pull';
  }

  return localEdit(opts) ? 'conflict' : 'pull';
}

/**
 * Disk bytes changed since we recorded them → someone edited the PNG in the
 * game project. Without a recorded baseline we can't tell an edit from a file
 * we never wrote, so we stay out of the way and let the pull proceed.
 */
function localEdit(opts: PullDecisionInput): boolean {
  return isLocalEdit(opts.lastPushedDiskSha256, opts.localSha256);
}
