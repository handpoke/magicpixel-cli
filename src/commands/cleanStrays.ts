import kleur from 'kleur';
import { spinner as makeSpinner, ui } from '../util/ui.js';
import { confirm } from '../util/prompt.js';
import { existsSync } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fetchAllManifest, type ManifestEntry } from '../api.js';
import { loadConfig, loadState, saveState } from '../config.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { countingSpritesText, indexGamePngs, matchConnectGlobs } from '../util/gameScan.js';
import { walkOutDirPngs, type DiskAsset } from '../util/paths.js';
import { splitStrayDownloads } from '../util/strayGuard.js';
import { collectSourceRelMap } from '../util/syncPath.js';

/**
 * Copies sync wrote under outDir for game-owned sprites that have no home in
 * this folder. Only outDir files are candidates — never a working-set original.
 */
export function findStrayCopies(
  disk: readonly DiskAsset[],
  manifest: readonly Pick<ManifestEntry, 'key' | 'game'>[],
  localKeys: Iterable<string>,
): DiskAsset[] {
  const byKey = new Map(manifest.map((e) => [e.key, e]));
  const candidates = disk.flatMap((d) => {
    const m = byKey.get(d.key);
    return m ? [{ key: d.key, game: m.game, disk: d }] : [];
  });
  return splitStrayDownloads(candidates, localKeys).foreign.map((c) => c.disk);
}


export async function removeEmptyDirsUpTo(dir: string, stopAt: string): Promise<void> {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      const left = (await readdir(cur)).filter((n) => n !== '.DS_Store');
      if (left.length > 0) return;
      await rm(resolve(cur, '.DS_Store'), { force: true });
      await rmdir(cur);
      await rm(`${cur}.meta`, { force: true }); // Unity folder meta
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}

export async function cleanStraysCommand(opts: { yes?: boolean; dryRun?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  const state = await loadState();
  const kind = await detectProjectKind();
  const spinner = makeSpinner({ text: 'Fetching your sprites from MagicPixel…', spinner: 'dots' }).start();
  const manifest = await fetchAllManifest(config);
  spinner.text = countingSpritesText(0);
  const index = isEngineKind(kind)
    ? await indexGamePngs(kind, process.cwd(), config.outDir, {
        onProgress: (p) => { spinner.text = countingSpritesText(p); },
      })
    : { files: [] };
  const connected = matchConnectGlobs(index, config.connect ?? [], config.exclude).entries;
  const localKeys = [...collectSourceRelMap(connected, state.synced).keys(), ...connected.map((e) => e.key)];
  const strays = findStrayCopies(await walkOutDirPngs(config.outDir), manifest, localKeys);
  spinner.stop();

  if (strays.length === 0) {
    console.log(ui.ok(`No stray copies in ${config.outDir}.`));
    return;
  }
  console.log(kleur.bold(`${strays.length} stray cop${strays.length === 1 ? 'y' : 'ies'} of sprites from another game folder:`));
  for (const s of strays.slice(0, 30)) console.log(`  ${kleur.red('-')} ${relative(process.cwd(), s.abs)}`);
  if (strays.length > 30) console.log(kleur.dim(`  …and ${strays.length - 30} more`));
  console.log(kleur.dim('  Their .meta files go too. Your own game files are never touched.'));
  if (opts.dryRun) {
    console.log(kleur.dim('--dry-run: nothing deleted.'));
    return;
  }
  if (!opts.yes && !(await confirm('Delete them? (y/N) '))) {
    console.log(kleur.dim('Nothing deleted. Re-run with --yes to skip this question.'));
    return;
  }
  const outRoot = resolve(process.cwd(), config.outDir);
  const removedKeys = new Set<string>();
  for (const s of strays) {
    await rm(s.abs, { force: true });
    if (existsSync(`${s.abs}.meta`)) await rm(`${s.abs}.meta`, { force: true });
    removedKeys.add(s.key);
    await removeEmptyDirsUpTo(dirname(s.abs), outRoot);
  }
  const synced = { ...(state.synced ?? {}) };
  for (const k of removedKeys) delete synced[k];
  const assets = Object.fromEntries(Object.entries(state.assets ?? {}).filter(([, k]) => !removedKeys.has(k)));
  await saveState({ ...state, synced, assets });
  console.log(ui.ok(`Removed ${removedKeys.size} stray cop${removedKeys.size === 1 ? 'y' : 'ies'}.`));
}
