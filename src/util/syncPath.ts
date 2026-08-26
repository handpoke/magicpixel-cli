import { isAbsolute, relative, resolve } from 'node:path';
import { assetDiskPathFromKey } from './paths.js';
import { assertPathInsideRoot, sanitizeSourceRel } from './security.js';
import type { GameIndexEntry } from './gameScan.js';

export { sanitizeSourceRel } from './security.js';

/** Resolve a cwd-relative game path; refuse anything that escapes the project. */
export function resolveProjectRel(rel: string, cwd: string = process.cwd()): string {
  const safe = sanitizeSourceRel(rel);
  if (!safe) {
    throw new Error(
      `refusing unsafe game path (${rel}).\n` +
        `  Fix: sourceRel must be a relative .png inside the project, with no "..".`,
    );
  }
  const abs = resolve(cwd, safe);
  assertPathInsideRoot(abs, resolve(cwd), 'project');
  return abs;
}

/**
 * Write-back map from the live connect index. Persisted `sourceRel` is only
 * used as a cloud-key alias when that path is still in the working set —
 * a hand-edited state.json cannot invent a new target file.
 */
export function collectSourceRelMap(
  connected: readonly GameIndexEntry[],
  synced?: Record<string, { sourceRel?: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  const liveRels = new Set<string>();
  for (const e of connected) {
    const rel = sanitizeSourceRel(e.sourceRel);
    if (!rel) continue;
    map.set(e.key, rel);
    liveRels.add(rel);
  }
  if (synced) {
    for (const [key, sprite] of Object.entries(synced)) {
      const rel = sanitizeSourceRel(sprite.sourceRel);
      if (rel && liveRels.has(rel)) map.set(key, rel);
    }
  }
  return map;
}

/**
 * When the cloud assigned a different composite key than the index key,
 * push under the cloud key so we update instead of adopting a duplicate.
 */
export function remapAbsToCloudKeys(
  absByKey: Map<string, string>,
  connected: readonly GameIndexEntry[],
  synced?: Record<string, { sourceRel?: string }>,
): void {
  if (!synced) return;
  const relToLiveKey = new Map<string, string>();
  for (const e of connected) {
    const rel = sanitizeSourceRel(e.sourceRel);
    if (rel) relToLiveKey.set(rel, e.key);
  }
  for (const [cloudKey, sprite] of Object.entries(synced)) {
    const rel = sanitizeSourceRel(sprite.sourceRel);
    if (!rel) continue;
    const liveKey = relToLiveKey.get(rel);
    if (!liveKey || liveKey === cloudKey) continue;
    const abs = absByKey.get(liveKey) ?? absByKey.get(cloudKey);
    if (!abs) continue;
    absByKey.set(cloudKey, abs);
    absByKey.delete(liveKey);
  }
}

export function syncDiskPathFromKey(
  outDir: string,
  key: string,
  sourceByKey: ReadonlyMap<string, string>,
  cwd: string = process.cwd(),
): string {
  const rel = sourceByKey.get(key);
  if (rel) return resolveProjectRel(rel, cwd);
  return assetDiskPathFromKey(outDir, key, cwd);
}

export function isPathInside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
