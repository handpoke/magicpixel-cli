/**
 * Plan a disk → MagicPixel push.
 *
 * Pure so the decision table (skip / update / adopt / needs-flatten) is unit
 * testable without touching the network or the filesystem.
 *
 * Two shapes reach the server:
 *   - UPDATE: the key is in the sync state, so we know the exact artboard and
 *     the composite sha we last wrote. A changed disk sha means a local edit.
 *   - ADOPT:  the key is new on disk (a sprite someone created in Unity), so
 *     the server mirrors the folders into the library and appends/creates the
 *     document.
 */

import type { SyncedSprite } from '../config.js';

export interface PushCandidate {
  /** Composite key: `folder/.../docSlug/artboardSlug` (no `.png`). */
  key: string;
  /** Path segments derived from disk, raw folder/file names (pre-slug). */
  segments: string[];
  /** sha256 of the PNG currently on disk. */
  diskSha256: string;
}

export type PushAction =
  | { kind: 'skip'; key: string; reason?: 'unchanged' | 'legacy' | 'unusable-path' }
  | { kind: 'needs-flatten'; key: string; layers: number }
  | {
      kind: 'update';
      key: string;
      assetId: string;
      layerIdx: number;
      baseSha256: string;
    }
  | { kind: 'adopt'; key: string; path: string[]; pathNames: string[]; name: string };

/**
 * Slug rule mirrored from the server (`slugify` + `SEGMENT_RE` in
 * `src/lib/integration/artboardComposite.server.ts`). The server is the
 * authority; this copy only exists so the CLI can pre-validate a path before
 * spending a request, and `pushPlan.test.ts` pins the two together.
 */
export function pushSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export const MAX_PUSH_PATH_SEGMENTS = 8;

export function planPush(
  candidates: readonly PushCandidate[],
  synced: Record<string, SyncedSprite> | undefined,
  opts: { flatten?: boolean } = {},
): PushAction[] {
  const state = synced ?? {};
  const out: PushAction[] = [];
  for (const c of candidates) {
    const known = state[c.key];
    if (known) {
      if (known.sha256 === c.diskSha256) {
        out.push({ kind: 'skip', key: c.key, reason: 'unchanged' });
        continue;
      }
      // Legacy row: the cloud has no addressable artboard, and adopting would
      // duplicate art that already exists in the library.
      if (known.legacy) {
        out.push({ kind: 'skip', key: c.key, reason: 'legacy' });
        continue;
      }
      if (!opts.flatten && typeof known.layers === 'number' && known.layers > 1) {
        out.push({ kind: 'needs-flatten', key: c.key, layers: known.layers });
        continue;
      }
      out.push({
        kind: 'update',
        key: c.key,
        assetId: known.assetId,
        layerIdx: known.layerIdx,
        baseSha256: known.sha256,
      });
      continue;
    }
    // New on disk → adopt. A single segment (outDir/hero.png) is a document
    // with one artboard of the same name — the server already accepts that.
    const rawNames = c.segments.slice(-MAX_PUSH_PATH_SEGMENTS);
    let pathNames = rawNames;
    let path = pathNames.map(pushSlug);
    if (path.length === 1 && path[0]) {
      pathNames = [pathNames[0], pathNames[0]];
      path = [path[0], path[0]];
    }
    if (path.length < 2 || path.some((s) => !s)) {
      out.push({ kind: 'skip', key: c.key, reason: 'unusable-path' });
      continue;
    }

    out.push({
      kind: 'adopt',
      key: c.key,
      path,
      pathNames,
      name: pathNames[pathNames.length - 1],
    });
  }
  return out;
}
