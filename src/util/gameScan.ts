/**
 * First-connect import: when `outDir` has no PNGs yet, copy nearby game
 * sprites into it so `push` can adopt them into the MagicPixel library.
 *
 * Only engine projects. Never walks Library/Temp/Packages. Never overwrites
 * a file already in outDir. Capped so a huge Assets/ tree can't stampede
 * the library.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { ProjectKind } from './framework.js';
import { isEngineKind } from './framework.js';
import { assertPathInsideRoot } from './security.js';

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
]);

export const MAX_GAME_IMPORT = 200;

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

export interface GameImportResult {
  copied: number;
  skipped: number;
  capped: boolean;
}

/**
 * Copy PNGs from the engine asset root into `outDir`, preserving relative
 * paths. No-op when `outDir` already has PNGs, when the project isn't an
 * engine, or when the scan root is missing.
 */
export async function importNearbyGamePngs(
  outDir: string,
  kind: ProjectKind,
  cwd: string = process.cwd(),
): Promise<GameImportResult> {
  const result: GameImportResult = { copied: 0, skipped: 0, capped: false };
  if (!isEngineKind(kind)) return result;
  const scanRel = gameScanRoot(kind);
  if (!scanRel) return result;
  const scanRoot = resolve(cwd, scanRel);
  const destRoot = resolve(cwd, outDir);
  if (!existsSync(scanRoot)) return result;

  const destNorm = destRoot.replace(/\\/g, '/').toLowerCase();
  const found: string[] = [];
  await walkPngs(scanRoot, scanRoot, destNorm, found);
  if (found.length >= MAX_GAME_IMPORT) result.capped = true;
  if (found.length > MAX_GAME_IMPORT) found.length = MAX_GAME_IMPORT;

  for (const abs of found) {
    const rel = relative(scanRoot, abs).replace(/\\/g, '/');
    const dest = resolve(destRoot, rel);
    try {
      assertPathInsideRoot(dest, destRoot, 'outDir');
    } catch {
      result.skipped++;
      continue;
    }
    if (existsSync(dest)) {
      result.skipped++;
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(abs, dest);
    result.copied++;
  }
  return result;
}

async function walkPngs(
  dir: string,
  root: string,
  destNorm: string,
  out: string[],
): Promise<void> {
  if (out.length >= MAX_GAME_IMPORT) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= MAX_GAME_IMPORT) return;
    if (ent.isSymbolicLink()) continue;
    const full = resolve(dir, ent.name);
    try {
      assertPathInsideRoot(full, root, 'scan');
    } catch {
      continue;
    }
    if (ent.isDirectory()) {
      const name = ent.name.toLowerCase();
      if (name.startsWith('.')) continue;
      if (GAME_SCAN_SKIP_DIRS.has(name)) continue;
      // Don't re-import from outDir if it sits inside the scan root
      // (Assets/MagicPixel under Assets/).
      if (full.replace(/\\/g, '/').toLowerCase() === destNorm) continue;
      await walkPngs(full, root, destNorm, out);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.png')) {
      out.push(full);
    }
  }
}
