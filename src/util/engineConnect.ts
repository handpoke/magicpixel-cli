/**
 * Engine projects sync every game PNG by default. `connect` is only for
 * narrowing that set — users should not have to type `connect '**'`.
 */
import type { MagicPixelConfig } from '../config.js';
import { saveConfig } from '../config.js';
import { detectProjectKind, isEngineKind } from './framework.js';
import { entryMatchesGlob, type GameIndexEntry } from './gameScan.js';

export const DEFAULT_ENGINE_CONNECT = ['**'];

const ALL_SPRITES_GLOBS = new Set(['**', '**/*', '**/**', '**/*.png', '**/**/*.png']);

export function isAllSpritesGlob(glob: string): boolean {
  return ALL_SPRITES_GLOBS.has(glob.trim());
}

/**
 * Next `connect` list after the user adds a glob.
 * A specific folder replaces a default `**` (narrowing). `**` restores all
 * sprites. Other globs accumulate. Stray `**` left over from an earlier
 * default is dropped when narrowing so OR-matching cannot keep everything.
 */
export function nextConnectGlobs(current: readonly string[], pattern: string): string[] {
  if (isAllSpritesGlob(pattern)) return [...DEFAULT_ENGINE_CONNECT];
  const withoutAll = current.filter((g) => !isAllSpritesGlob(g));
  if (withoutAll.includes(pattern)) return withoutAll;
  return [...withoutAll, pattern];
}

/** Clean one folder pattern: `\` → `/`, collapse `//`, drop `./`, a trailing `/` or stray `~`. */
export function normalizeConnectGlob(glob: string): string {
  return glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/~+$/, '')
    .replace(/\/+$/, '');
}

/** Normalize, dedupe, and drop patterns already covered by a broader `<folder>/**`. */
export function tidyConnectGlobs(globs: readonly string[]): string[] {
  const clean = [...new Set(globs.map(normalizeConnectGlob).filter(Boolean))];
  const roots = clean.filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -3).toLowerCase());
  return clean.filter((g) => {
    const base = (g.endsWith('/**') ? g.slice(0, -3) : g).toLowerCase();
    return !roots.some((r) => r !== base && (base === r || base.startsWith(`${r}/`)))
      && !(roots.includes(base) && !g.endsWith('/**'));
  });
}

/**
 * Hidden art folders (`<member>/.SpineRaw/<name>`) with PNGs that no pattern
 * watches. Returns `[folder, count]`, largest first.
 */
export function unwatchedHiddenFolders(
  files: readonly GameIndexEntry[],
  watchedKeys: ReadonlySet<string>,
  exclude: readonly string[] = [],
  min = 10,
): [string, number][] {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (watchedKeys.has(f.key) || exclude.some((g) => entryMatchesGlob(f, g))) continue;
    const parts = f.sourceRel.split('/');
    const i = parts.findIndex((p) => p.startsWith('.') && p.length > 1);
    if (i < 0 || i + 2 >= parts.length) continue;
    const folder = parts.slice(0, i + 2).join('/');
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]);
}

export async function ensureEngineConnect(
  config: MagicPixelConfig,
  cwd: string = process.cwd(),
  persist = true,
): Promise<MagicPixelConfig> {
  if (config.connect.length > 0) return config;
  const kind = await detectProjectKind(cwd);
  if (!isEngineKind(kind)) return config;
  const next: MagicPixelConfig = { ...config, connect: [...DEFAULT_ENGINE_CONNECT] };
  if (persist) await saveConfig(next, cwd);
  return next;
}
