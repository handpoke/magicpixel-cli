import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { atomicWrite } from './atomicWrite.js';

/**
 * Machine-wide registry: MagicPixel project id → game folders that own
 * connected sprites (`sourceRel` in their `.magicpixel/state.json`). Lets a
 * sync from the wrong folder notice those sprites belong elsewhere instead of
 * dumping copies into its own `outDir`.
 */
type Registry = Record<string, string[]>;

export function registryPath(home: string = homedir()): string {
  return resolve(home, '.magicpixel', 'project-roots.json');
}

async function readRegistry(home?: string): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(home), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Registry) : {};
  } catch {
    return {};
  }
}

/** Remember `root` as a home for this project's connected sprites. Best-effort. */
const recorded = new Set<string>();

export async function recordProjectRoot(projectId: string, root: string, home?: string): Promise<void> {
  const memo = `${home ?? ''}\0${projectId}\0${resolve(root)}`;
  if (recorded.has(memo)) return; // watch mode: once per run
  recorded.add(memo);
  try {
    const reg = await readRegistry(home);
    const abs = resolve(root);
    const list = reg[projectId] ?? [];
    if (list.includes(abs)) return;
    reg[projectId] = [...list, abs].slice(-20);
    const path = registryPath(home);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, JSON.stringify(reg, null, 2));
  } catch {
    /* registry is advisory */
  }
}

/** Keys another folder already syncs to a real game path. */
function connectedKeysAt(root: string): Set<string> {
  try {
    const state = JSON.parse(readFileSync(resolve(root, '.magicpixel', 'state.json'), 'utf8')) as {
      synced?: Record<string, { sourceRel?: string }>;
    };
    return new Set(Object.entries(state.synced ?? {}).filter(([, v]) => !!v?.sourceRel).map(([k]) => k));
  } catch {
    return new Set();
  }
}

export interface ForeignRoot {
  root: string;
  count: number;
}

/**
 * Of the keys this run would download WITHOUT a local game path, how many
 * belong to another registered folder. Returns the folder owning the most, or
 * null when the download is safe.
 */
export async function findForeignOwner(
  projectId: string,
  cwd: string,
  downloadKeysWithoutLocalPath: string[],
  home?: string,
): Promise<ForeignRoot | null> {
  if (downloadKeysWithoutLocalPath.length === 0) return null;
  const here = resolve(cwd);
  const roots = ((await readRegistry(home))[projectId] ?? []).filter((r) => r !== here && existsSync(r));
  let best: ForeignRoot | null = null;
  for (const root of roots) {
    const owned = connectedKeysAt(root);
    const count = downloadKeysWithoutLocalPath.filter((k) => owned.has(k)).length;
    if (count > 0 && (!best || count > best.count)) best = { root, count };
  }
  return best;
}

export function foreignOwnerMessage(owner: ForeignRoot, cwd: string, rerun: string): string {
  return (
    `This folder isn't the game these sprites are connected to.\n` +
    `  ${owner.count} sprite${owner.count === 1 ? '' : 's'} live in ${owner.root}, not ${resolve(cwd)}.\n` +
    `  Fix: cd "${owner.root}" and run sync there — or ${rerun} to download copies here anyway.`
  );
}
