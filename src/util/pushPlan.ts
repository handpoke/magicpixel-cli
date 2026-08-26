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
  /** Live connect index path, when this candidate is a game original. */
  sourceRel?: string;
  diskMtimeMs?: number;
  diskSize?: number;
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

/**
 * Connected-section root used when a Unity PNG sits at the scan root
 * (`Assets/hero.png`) with no parent folder to mirror.
 */
export const GAME_IMPORT_ROOT_FOLDER = 'Game';

/**
 * Unity/Godot/GameMaker layout: parent dirs become library folders (flagged
 * Sync to Unity → Connected), and the PNG is a one-artboard document.
 * `Sprites/hero.png` → folder Sprites / doc hero — not a root "Sprites"
 * document, which would land in Files and leave Connected empty.
 */
export function gameImportAdoptPath(segments: string[]): {
  path: string[];
  pathNames: string[];
  name: string;
} {
  const parts = segments.filter(Boolean);
  const file = parts[parts.length - 1] ?? '';
  let folders = parts.length > 1 ? parts.slice(0, -1) : [GAME_IMPORT_ROOT_FOLDER];
  const maxFolders = MAX_PUSH_PATH_SEGMENTS - 2;
  if (folders.length > maxFolders) folders = folders.slice(-maxFolders);
  const pathNames = [...folders, file, file];
  return { path: pathNames.map(pushSlug), pathNames, name: file };
}

/** Disk path relative to outDir for a Unity-imported PNG (`sprites/hero/hero.png`). */
export function gameImportDiskRel(segments: string[]): string {
  return `${gameImportAdoptPath(segments).path.join('/')}.png`;
}

/**
 * Bytes last known on disk for skip decisions. Cloud `sha256` is the conflict
 * baseline, not the original game PNG — connected sprites must not treat a
 * composite mismatch as a local edit.
 */
export function lastPushedDiskSha(
  known: SyncedSprite,
  opts: { connected?: boolean } = {},
): string | undefined {
  if (known.diskSha256) return known.diskSha256;
  if (known.sourceRel || opts.connected) return undefined;
  return known.sha256;
}

export function indexSyncedBySourceRel(
  synced: Record<string, SyncedSprite>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, sprite] of Object.entries(synced)) {
    if (sprite.sourceRel) map.set(sprite.sourceRel, key);
  }
  return map;
}

/** State key for a candidate: exact key, else the row that still points at this game path. */
export function resolveSyncedKey(
  candidate: Pick<PushCandidate, 'key' | 'sourceRel'>,
  synced: Record<string, SyncedSprite>,
  byRel: ReadonlyMap<string, string> = indexSyncedBySourceRel(synced),
): string | undefined {
  if (synced[candidate.key]) return candidate.key;
  if (candidate.sourceRel) return byRel.get(candidate.sourceRel);
  return undefined;
}

/**
 * Record on-disk sha256 onto synced rows so the next push can skip without
 * comparing against a cloud composite. Only updates keys already in state.
 */
export function applyDiskFingerprints(
  synced: Record<string, SyncedSprite>,
  fingerprints: readonly Pick<PushCandidate, 'key' | 'sourceRel' | 'diskSha256' | 'diskMtimeMs' | 'diskSize'>[],
): { next: Record<string, SyncedSprite>; changed: boolean } {
  const byRel = indexSyncedBySourceRel(synced);
  let next: Record<string, SyncedSprite> | null = null;
  for (const fp of fingerprints) {
    const src = next ?? synced;
    const stateKey = resolveSyncedKey(fp, src, byRel);
    if (!stateKey) continue;
    const known = src[stateKey];
    if (!known) continue;
    if (
      known.diskSha256 === fp.diskSha256 &&
      (fp.diskMtimeMs == null || known.diskMtimeMs === fp.diskMtimeMs) &&
      (fp.diskSize == null || known.diskSize === fp.diskSize)
    ) {
      continue;
    }
    if (!next) next = { ...synced };
    next[stateKey] = {
      ...known,
      diskSha256: fp.diskSha256,
      ...(fp.diskMtimeMs != null ? { diskMtimeMs: fp.diskMtimeMs } : {}),
      ...(fp.diskSize != null ? { diskSize: fp.diskSize } : {}),
    };
  }
  return next ? { next, changed: true } : { next: synced, changed: false };
}

export function planPush(
  candidates: readonly PushCandidate[],
  synced: Record<string, SyncedSprite> | undefined,
  opts: { flatten?: boolean; folderTreeKeys?: ReadonlySet<string> } = {},
): PushAction[] {
  const state = synced ?? {};
  const byRel = indexSyncedBySourceRel(state);
  const out: PushAction[] = [];
  for (const c of candidates) {
    const stateKey = resolveSyncedKey(c, state, byRel);
    const known = stateKey ? state[stateKey] : undefined;
    if (known) {
      const connected = Boolean(
        c.sourceRel || opts.folderTreeKeys?.has(c.key) || (stateKey != null && opts.folderTreeKeys?.has(stateKey)),
      );
      const lastDisk = lastPushedDiskSha(known, { connected });
      if (lastDisk === c.diskSha256) {
        out.push({ kind: 'skip', key: c.key, reason: 'unchanged' });
        continue;
      }
      if (lastDisk === undefined) {
        // Connected original with no disk baseline yet. Ingest's composite
        // sha is not the game file — seeding happens in `applyDiskFingerprints`.
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
    // New on disk → adopt. Game-tree PNGs keep their folders so they show
    // up under Connected. MagicPixel's own `doc/artboard.png` layout stays
    // a two-segment path (document + artboard at library root / in-folder).
    if (opts.folderTreeKeys?.has(c.key)) {
      const adopted = gameImportAdoptPath(c.segments);
      if (adopted.path.length < 2 || adopted.path.some((s) => !s)) {
        out.push({ kind: 'skip', key: c.key, reason: 'unusable-path' });
        continue;
      }
      out.push({ kind: 'adopt', key: c.key, ...adopted });
      continue;
    }
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
