/**
 * "Was this PNG edited in the game project since we last wrote or pushed it?"
 *
 * The single definition of a local edit, used by two callers:
 *
 *   - `pullDecision` — an entry still in the manifest whose disk bytes diverged
 *     is a conflict, not a download target.
 *   - the prune sweep in `sync` — a path that LEFT the manifest (deselected
 *     "Sync to Unity", trashed document, rename/previous-key cruft) must not be
 *     deleted while it holds work MagicPixel has never seen.
 *
 * Without a recorded baseline (`state.synced[key].diskSha256`) we can't tell an
 * edit from a file we never wrote, so we report "no edit" and let the caller's
 * existing rules apply unchanged.
 */

import { fileSha256 } from './hash.js';

/** Pure comparison — no filesystem access, safe for decision unit tests. */
export function isLocalEdit(
  baselineDiskSha256: string | undefined,
  localSha256: string | null | undefined,
): boolean {
  if (!baselineDiskSha256 || !localSha256) return false;
  return baselineDiskSha256 !== localSha256;
}

export interface UnpushedLocalEditInput {
  absPath: string;
  /** `state.synced[key].diskSha256`, when we have ever synced this key. */
  baselineDiskSha256: string | undefined;
  /** Already-computed sha for `absPath`, when the caller has one. */
  knownSha256?: string | null;
}

/** Hashes `absPath` only when a baseline exists (nothing else can be an edit). */
export async function hasUnpushedLocalEdit({
  absPath,
  baselineDiskSha256,
  knownSha256,
}: UnpushedLocalEditInput): Promise<boolean> {
  if (!baselineDiskSha256) return false;
  const sha = knownSha256 !== undefined ? knownSha256 : await fileSha256(absPath);
  return isLocalEdit(baselineDiskSha256, sha);
}
