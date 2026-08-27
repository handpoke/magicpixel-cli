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
}

export function decidePull(opts: PullDecisionInput): PullDecision {
  const cloud = opts.cloudSha256 ?? null;
  const local = opts.localSha256;
  const prev = opts.previousCloudSha256;

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
