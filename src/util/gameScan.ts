/**
 * Game-tree index for opt-in connect. Walks the project/package (including
 * hidden content dirs like `.SpineRaw_*`) but never copies files. `connect`
 * globs select a working set; sync writes back to those original paths.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ProjectKind } from './framework.js';
import { isEngineKind, resolveChildDir } from './framework.js';
import { assertPathInsideRoot, sanitizeSourceRel } from './security.js';
import { gameImportAdoptPath } from './pushPlan.js';
import { matchGlob } from './globMatch.js';
import { createLimit } from './limit.js';

/** Unity/engine folders that are never sprite sources. */
export const GAME_SCAN_SKIP_DIRS = new Set([
  'library',
  'temp',
  'obj',
  'logs',
  'packages',
  'projectsettings',
  'usersettings',
  'streamingassets',
  'node_modules',
  'magicpixel',
]);

/**
 * Dot-directories we never walk. Other hidden folders (e.g. `.SpineRaw_*`)
 * are scanned — Unity packages often stash sprites there.
 */
export const GAME_SCAN_SKIP_HIDDEN = new Set([
  '.git',
  '.svn',
  '.hg',
  '.magicpixel',
  '.vs',
  '.vscode',
  '.idea',
  '.cursor',
  '.config',
  '.cache',
]);

/** Parallel directory reads while walking the game tree. */
const SCAN_WALK_CONCURRENCY = 8;

/** Cap on the search index (whole tree). Connect uses the same ceiling. */
export const MAX_GAME_INDEX = 10_000;
/** Cap on PNGs ingested for one working-set connect / push. */
export const MAX_GAME_CONNECT = MAX_GAME_INDEX;

export const GAME_INDEX_CAP_HINT =
  `Game index hit ${MAX_GAME_INDEX} PNGs — later files aren't searchable or connectable.`;

export function connectCapMessage(total: number, ingested: number): string {
  return (
    `${total} PNGs match the working set — ingesting the first ${ingested} (cap ${MAX_GAME_CONNECT}). ` +
    `Narrow the glob, or add another connect pattern for the rest.`
  );
}

export function gameScanRoot(kind: ProjectKind): string | null {
  switch (kind) {
    case 'Unity':
      return 'Assets';
    case 'Godot':
      return 'assets';
    case 'GameMaker':
      return 'datafiles';
    default:
      return null;
  }
}

function shouldSkipDir(name: string): boolean {
  const n = name.toLowerCase();
  if (GAME_SCAN_SKIP_DIRS.has(n)) return true;
  if (GAME_SCAN_SKIP_HIDDEN.has(n)) return true;
  if (n.startsWith('.git')) return true;
  return false;
}

export interface GameIndexEntry {
  abs: string;
  /** cwd-relative original path (`assets/Sprites/hero.png`). */
  sourceRel: string;
  /** Path used for Connected folders (asset-root prefix stripped). */
  adoptRel: string;
  /** Manifest-style key (`sprites/hero/hero`). */
  key: string;
}

export interface GameIndex {
  files: GameIndexEntry[];
  capped: boolean;
}

function importRel(abs: string, cwd: string, assetRoot: string | null): string {
  if (assetRoot) {
    const rootNorm = assetRoot.replace(/\\/g, '/').toLowerCase();
    const absNorm = abs.replace(/\\/g, '/').toLowerCase();
    if (absNorm === rootNorm || absNorm.startsWith(`${rootNorm}/`)) {
      return relative(assetRoot, abs).replace(/\\/g, '/');
    }
  }
  return relative(cwd, abs).replace(/\\/g, '/');
}

function toEntry(abs: string, cwdAbs: string, assetRoot: string | null): GameIndexEntry | null {
  const sourceRel = sanitizeSourceRel(relative(cwdAbs, abs).replace(/\\/g, '/'));
  if (!sourceRel) return null;
  const adoptRel = importRel(abs, cwdAbs, assetRoot);
  const relKey = adoptRel.replace(/\.png$/i, '');
  const adopted = gameImportAdoptPath(relKey.split('/'));
  if (adopted.path.length < 2 || adopted.path.some((s) => !s)) return null;
  return { abs, sourceRel, adoptRel, key: adopted.path.join('/') };
}

/** Walk the engine tree and return index entries. Does not copy files. */
export async function indexGamePngs(
  kind: ProjectKind,
  cwd: string = process.cwd(),
  outDir: string = '',
): Promise<GameIndex> {
  const empty: GameIndex = { files: [], capped: false };
  if (!isEngineKind(kind)) return empty;
  const scanRoot = resolve(cwd);
  if (!existsSync(scanRoot)) return empty;
  const destNorm = outDir ? resolve(cwd, outDir).replace(/\\/g, '/').toLowerCase() : '';
  const namedRoot = gameScanRoot(kind);
  const assetRoot = namedRoot ? resolveChildDir(cwd, namedRoot) : null;

  const found: string[] = [];
  const io = createLimit(SCAN_WALK_CONCURRENCY);
  await walkPngs(scanRoot, scanRoot, destNorm, found, MAX_GAME_INDEX + 1, io);
  found.sort((a, b) => a.localeCompare(b));
  const capped = found.length > MAX_GAME_INDEX;
  if (capped) found.length = MAX_GAME_INDEX;

  const files: GameIndexEntry[] = [];
  for (const abs of found) {
    const entry = toEntry(abs, scanRoot, assetRoot);
    if (entry) files.push(entry);
  }
  return { files, capped };
}

export interface ConnectMatchResult {
  entries: GameIndexEntry[];
  /** Matches before the ingest cap. */
  total: number;
  capped: boolean;
}

/** Filter the index by connect globs (cwd-relative or asset-root-relative). */
export function matchConnectGlobs(
  index: GameIndex,
  globs: readonly string[],
  max: number = MAX_GAME_CONNECT,
): ConnectMatchResult {
  if (globs.length === 0) return { entries: [], total: 0, capped: false };
  const matched = index.files.filter((e) =>
    globs.some((g) => matchGlob(e.sourceRel, g) || matchGlob(e.adoptRel, g)),
  );
  matched.sort((a, b) => a.sourceRel.localeCompare(b.sourceRel));
  const total = matched.length;
  const capped = total > max;
  return { entries: capped ? matched.slice(0, max) : matched, total, capped };
}

export function searchGameIndex(index: GameIndex, query: string): GameIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return index.files.filter(
    (e) => e.sourceRel.toLowerCase().includes(q) || e.key.includes(q) || e.adoptRel.toLowerCase().includes(q),
  );
}

async function walkPngs(
  dir: string,
  root: string,
  destNorm: string,
  out: string[],
  limit: number,
  io: ReturnType<typeof createLimit>,
): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const subdirs: string[] = [];
  for (const ent of entries) {
    if (out.length >= limit) return;
    if (ent.isSymbolicLink()) continue;
    const full = resolve(dir, ent.name);
    try {
      assertPathInsideRoot(full, root, 'scan');
    } catch {
      continue;
    }
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      if (destNorm && full.replace(/\\/g, '/').toLowerCase() === destNorm) continue;
      subdirs.push(full);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.png')) {
      out.push(full);
    }
  }
  if (subdirs.length === 0 || out.length >= limit) return;
  await Promise.all(subdirs.map((d) => io(() => walkPngs(d, root, destNorm, out, limit, io))));
}
