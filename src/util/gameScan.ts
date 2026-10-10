/**
 * Game-tree index for opt-in connect. Walks the project/package (including
 * hidden content dirs like `.SpineRaw_*`) but never copies files. `connect`
 * globs select a working set; sync writes back to those original paths.
 */
import { existsSync } from 'node:fs';
import { opendir, readdir } from 'node:fs/promises';
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
  const empty: GameIndex = { files: [] };
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
  await walkPngs(startAt, scanRoot, destNorm, found, Infinity, io, report, stats, preferFirst);
  // Full Unity games also keep sprite sources in root dot-folders next to
  // Assets/ (e.g. `.SpineRaw`). Walk those too; Unity's own folders stay out.
  if (startAt !== scanRoot) {
    for (const dir of await rootSpriteDotDirs(scanRoot)) {
      await walkPngs(dir, scanRoot, destNorm, found, Infinity, io, report, stats, null);
    }
  }
  report.flush?.();
  opts.onProgress?.({ pngs: found.length, folders: stats.folders });
  found.sort((a, b) => a.localeCompare(b));

  const files: GameIndexEntry[] = [];
  for (const abs of found) {
    const entry = toEntry(abs, scanRoot, assetRoot);
    if (entry) files.push(entry);
  }
  return { files };
}

/** One-line summary of exclude-dropped files, or null when none. */
export function describeExcluded(r: ConnectMatchResult): string | null {
  if (!r.excluded) return null;
  return `${r.excluded.toLocaleString('en-US')} PNG${r.excluded === 1 ? '' : 's'} skipped by exclude rules (${r.topExclude}) — edit "exclude" in magicpixel.json to include them`;
}

/** Root-level dot-folders that may hold sprites (not VCS/editor/tool dirs). */
export async function rootSpriteDotDirs(root: string): Promise<string[]> {
  try {
    const ents = await readdir(root, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name.startsWith('.') && !shouldSkipDir(e.name))
      .map((e) => resolve(root, e.name))
      .sort();
  } catch {
    return [];
  }
}

export interface ConnectMatchResult {
  entries: GameIndexEntry[];
  /** Files that matched `connect` but were dropped by an `exclude` rule. */
  excluded?: number;
  /** The exclude rule that dropped the most files. */
  topExclude?: string;
}

/** Filter the index by connect globs minus exclude globs (cwd-, asset-root-relative or manifest key). */
export function matchConnectGlobs(
  index: GameIndex,
  globs: readonly string[],
  exclude: readonly string[] = [],
): ConnectMatchResult {
  if (globs.length === 0) return { entries: [] };
  const hit = (e: GameIndexEntry, g: string) =>
    matchGlob(e.sourceRel, g) || matchGlob(e.adoptRel, g) || matchGlob(e.key, g);
  // `exclude` wins over `connect`: excluded game files are never uploaded.
  const matched: GameIndexEntry[] = [];
  const byRule = new Map<string, number>();
  let excluded = 0;
  for (const e of index.files) {
    if (!globs.some((g) => hit(e, g))) continue;
    const rule = exclude.find((g) => hit(e, g));
    if (rule === undefined) matched.push(e);
    else { excluded++; byRule.set(rule, (byRule.get(rule) ?? 0) + 1); }
  }
  matched.sort((a, b) => a.sourceRel.localeCompare(b.sourceRel));
  const topExclude = [...byRule.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { entries: matched, ...(excluded ? { excluded, topExclude } : {}) };
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
