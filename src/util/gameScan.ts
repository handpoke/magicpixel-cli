/**
 * Game-tree index for opt-in connect. Walks the project/package (including
 * hidden content dirs like `.SpineRaw_*`) but never copies files. `connect`
 * globs select a working set; sync writes back to those original paths.
 */
import { existsSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
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
  'build',
  'builds',
  'recordings',
  'memorycaptures',
]);

/**
 * Dot-directories we never walk. Other hidden folders (e.g. `.SpineRaw_*`)
 * are scanned — Unity packages often stash sprites there.
 */
export const GAME_SCAN_SKIP_HIDDEN = new Set([
  '.git',
  '.svn',
  '.hg',
  '.godot',
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
    `${total} sprites match — syncing the first ${ingested} (cap ${MAX_GAME_CONNECT}). ` +
    `Connect a smaller folder if you don't need all of them.`
  );
}

/** True for a full Unity game project (not an embedded UPM package). */
function isUnityGameProject(cwd: string, assetRoot: string | null): boolean {
  return Boolean(assetRoot && existsSync(resolve(cwd, 'ProjectSettings')));
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

export interface ScanProgress {
  pngs: number;
  folders: number;
  /** cwd-relative folder currently being read. */
  current?: string;
}

export interface IndexGamePngsOpts {
  /** Called as folders/PNGs are visited. Throttled (~80ms); always fires with the final counts. */
  onProgress?: (progress: ScanProgress) => void;
}

function fmtCount(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
}

function shortPath(rel: string): string {
  const n = rel.replace(/\\/g, '/');
  if (!n || n === '.') return '';
  return n.length <= 48 ? n : `…${n.slice(-47)}`;
}

/** Spinner / status copy while walking the game tree. */
export function countingSpritesText(progress: ScanProgress | number = 0): string {
  const pngs = typeof progress === 'number' ? progress : progress.pngs;
  const folders = typeof progress === 'number' ? 0 : progress.folders;
  const current = typeof progress === 'number' ? undefined : progress.current;
  if (pngs === 0 && folders === 0 && !current) return 'Counting sprites in your game…';
  const spriteBit = fmtCount(pngs, 'sprite');
  const parts = [spriteBit];
  if (folders > 0) parts.push(fmtCount(folders, 'folder'));
  const where = current ? shortPath(current) : '';
  if (where) parts.push(where);
  return `Counting sprites in your game…  ${parts.join(' · ')}`;
}

type VisitFn = ((pngs: number, folders: number, current?: string) => void) & {
  flush?: () => void;
};

function bindScanProgress(onProgress?: (progress: ScanProgress) => void): VisitFn {
  if (!onProgress) return () => {};
  let lastAt = 0;
  let pending: ScanProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (p: ScanProgress) => {
    pending = null;
    lastAt = Date.now();
    onProgress(p);
  };

  const visit: VisitFn = (pngs: number, folders: number, current?: string) => {
    const next: ScanProgress = { pngs, folders, current };
    const now = Date.now();
    if (lastAt === 0 || now - lastAt >= 80) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush(next);
      return;
    }
    pending = next;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) flush(pending);
      }, 80 - (now - lastAt));
      timer.unref();
    }
  };
  visit.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) flush(pending);
  };
  return visit;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/** Walk the engine tree and return index entries. Does not copy files. */
export async function indexGamePngs(
  kind: ProjectKind,
  cwd: string = process.cwd(),
  outDir: string = '',
  opts: IndexGamePngsOpts = {},
): Promise<GameIndex> {
  const empty: GameIndex = { files: [], capped: false };
  if (!isEngineKind(kind)) return empty;
  const scanRoot = resolve(cwd);
  if (!existsSync(scanRoot)) return empty;
  const destNorm = outDir ? resolve(cwd, outDir).replace(/\\/g, '/').toLowerCase() : '';
  const namedRoot = gameScanRoot(kind);
  const assetRoot = namedRoot ? resolveChildDir(cwd, namedRoot) : null;

  const found: string[] = [];
  const stats = { folders: 0 };
  const io = createLimit(SCAN_WALK_CONCURRENCY);
  const report = bindScanProgress(opts.onProgress);
  // Full Unity games: walk Assets/ only. Listing the project root waits on
  // Library/Packages/cloud placeholders and looks hung at "1 folder".
  const startAt = isUnityGameProject(cwd, assetRoot) ? assetRoot! : scanRoot;
  const preferFirst = startAt === scanRoot ? assetRoot : null;
  await walkPngs(startAt, scanRoot, destNorm, found, MAX_GAME_INDEX + 1, io, report, stats, preferFirst);
  report.flush?.();
  opts.onProgress?.({ pngs: found.length, folders: stats.folders });
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

function folderLabel(dir: string, root: string): string {
  return relative(root, dir).replace(/\\/g, '/') || '.';
}

/**
 * List one directory. The limiter wraps *only* this listing so a parent does
 * not hold a slot while waiting on children (that deadlocks wide Unity trees).
 */
async function listDir(
  dir: string,
  root: string,
  destNorm: string,
  out: string[],
  limit: number,
  onVisit: VisitFn,
  stats: { folders: number },
  preferFirst: string | null,
  current: string,
): Promise<{ preferred: string[]; other: string[] }> {
  const preferred: string[] = [];
  const other: string[] = [];
  let dh;
  try {
    dh = await opendir(dir);
  } catch {
    return { preferred, other };
  }
  let lastBeat = Date.now();
  try {
    for await (const ent of dh) {
      if (out.length >= limit) break;
      const now = Date.now();
      if (now - lastBeat >= 80) {
        lastBeat = now;
        onVisit(out.length, stats.folders, current);
      }
      if (shouldSkipDir(ent.name) || ent.isSymbolicLink()) continue;
      const full = resolve(dir, ent.name);
      try {
        assertPathInsideRoot(full, root, 'scan');
      } catch {
        continue;
      }
      if (ent.isDirectory()) {
        if (destNorm && full.replace(/\\/g, '/').toLowerCase() === destNorm) continue;
        if (preferFirst && samePath(full, preferFirst)) preferred.push(full);
        else other.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.png')) {
        out.push(full);
        onVisit(out.length, stats.folders, current);
      }
    }
  } catch {
    /* unreadable mid-listing */
  }
  return { preferred, other };
}

async function walkPngs(
  dir: string,
  root: string,
  destNorm: string,
  out: string[],
  limit: number,
  io: ReturnType<typeof createLimit>,
  onVisit: VisitFn,
  stats: { folders: number },
  preferFirst: string | null,
): Promise<void> {
  if (out.length >= limit) return;
  stats.folders++;
  const current = folderLabel(dir, root);
  onVisit(out.length, stats.folders, current);
  const { preferred, other } = await io(() =>
    listDir(dir, root, destNorm, out, limit, onVisit, stats, preferFirst, current),
  );
  if (out.length >= limit) return;
  for (const d of preferred) {
    await walkPngs(d, root, destNorm, out, limit, io, onVisit, stats, null);
  }
  if (other.length === 0 || out.length >= limit) return;
  await Promise.all(other.map((d) => walkPngs(d, root, destNorm, out, limit, io, onVisit, stats, null)));
}
