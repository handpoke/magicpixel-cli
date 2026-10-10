/**
 * Game-owned sprites (manifest `game: true` — they live in a connected library
 * folder) belong to a real file in some game folder. Sync may write one only
 * to its game path here, or beside siblings this folder already owns (a new
 * variant saved next to its family). Otherwise it is skipped instead of being
 * dropped as a stray copy into outDir — this works on a machine that never
 * synced the owning folder, unlike the project-root registry.
 */

/** Library folder a manifest key sits in (`a/b/<doc>/<artboard>` → `a/b`). */
export function libraryFolderOf(key: string): string {
  const parts = key.split('/');
  return parts.length > 2 ? parts.slice(0, -2).join('/') : '';
}

export interface StraySplit<T> {
  keep: T[];
  /** Game-owned entries that have no home in this folder. */
  foreign: T[];
}

export function splitStrayDownloads<T extends { key: string; game?: boolean }>(
  entries: readonly T[],
  localKeys: Iterable<string>,
): StraySplit<T> {
  const local = new Set(localKeys);
  const localFolders = new Set<string>();
  for (const k of local) {
    const f = libraryFolderOf(k);
    if (f) localFolders.add(f);
  }
  const keep: T[] = [];
  const foreign: T[] = [];
  for (const e of entries) {
    const homeless = e.game === true && !local.has(e.key) && !localFolders.has(libraryFolderOf(e.key));
    (homeless ? foreign : keep).push(e);
  }
  return { keep, foreign };
}

export function straySkipMessage(count: number, ownerRoot: string | null, rerun: string): string {
  const where = ownerRoot ? ` (they live in ${ownerRoot})` : '';
  return (
    `${count.toLocaleString('en-US')} sprite${count === 1 ? '' : 's'} belong to another game folder${where} — skipped, nothing written here.\n` +
    `  Sync from that folder instead, or ${rerun} to download copies here anyway.`
  );
}

/**
 * New game-folder art (e.g. a variant saved as a new file) goes next to its
 * siblings in the game — same folder, same file-naming style — instead of
 * into outDir. Adds `key → game path` to `sourceByKey`; returns how many.
 */
export function placeBesideSiblings(
  sourceByKey: Map<string, string>,
  entries: readonly { key: string; game?: boolean; withheld?: boolean }[],
  liveRels: ReadonlySet<string>,
): number {
  const byFolder = new Map<string, string[]>();
  for (const [k, rel] of sourceByKey) {
    const f = libraryFolderOf(k);
    if (!f) continue;
    const list = byFolder.get(f) ?? [];
    list.push(rel);
    byFolder.set(f, list);
  }
  const taken = new Set([...liveRels].map((r) => r.toLowerCase()));
  for (const rel of sourceByKey.values()) taken.add(rel.toLowerCase());
  let placed = 0;
  for (const e of entries) {
    if (e.game !== true || e.withheld || sourceByKey.has(e.key)) continue;
    const sibs = byFolder.get(libraryFolderOf(e.key));
    if (!sibs?.length) continue;
    const sib = [...sibs].sort()[0]!;
    const slash = sib.lastIndexOf('/');
    const dir = slash >= 0 ? sib.slice(0, slash) : '';
    const base = sib.slice(slash + 1).replace(/\.png$/i, '');
    const slug = e.key.split('/').pop() ?? '';
    if (!slug) continue;
    const name = base.includes('_') && !base.includes('-') ? slug.replace(/-/g, '_') : slug;
    const rel = dir ? `${dir}/${name}.png` : `${name}.png`;
    if (taken.has(rel.toLowerCase())) continue;
    taken.add(rel.toLowerCase());
    sourceByKey.set(e.key, rel);
    placed++;
  }
  return placed;
}
