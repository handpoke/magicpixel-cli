import kleur from 'kleur';
import { spinner as makeSpinner, ui } from '../util/ui.js';
import { loadConfig, saveConfig } from '../config.js';
import { assertSafeGlob } from '../util/security.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { describeExcluded, indexGamePngs, matchConnectGlobs, countingSpritesText } from '../util/gameScan.js';
import { isAllSpritesGlob, nextConnectGlobs, normalizeConnectGlob, tidyConnectGlobs } from '../util/engineConnect.js';
import { cmd } from '../util/invoke.js';
import { runPush } from './push.js';

/** Plain-language label for a connect glob (`**` is not meaningful to players). */
export function describeWorkingSet(glob: string): string {
  return isAllSpritesGlob(glob) ? 'all sprites in your game' : glob.trim();
}

/**
 * Add or narrow a working-set glob, then ingest matching game PNGs.
 * A specific folder replaces the default `**`. Sync writes edits back to
 * the original files — not a copy under outDir.
 */
export async function connectCommand(glob: string): Promise<void> {
  const pattern = normalizeConnectGlob(assertSafeGlob(glob));
  if (!pattern) throw new Error(`"${glob}" isn't a folder pattern. Example: ${cmd('connect')} 'Assets/Sprites/**'`);
  const config = await loadConfig();
  const next = tidyConnectGlobs(nextConnectGlobs(config.connect.map(normalizeConnectGlob), pattern));
  const changed =
    next.length !== config.connect.length || next.some((g, i) => g !== config.connect[i]);
  if (changed) {
    const added = !config.connect.map(normalizeConnectGlob).includes(pattern);
    config.connect = next;
    await saveConfig(config);
    console.log(ui.ok(added ? `now syncing ${describeWorkingSet(pattern)}` : 'tidied your folder patterns'));
  }

  const kind = await detectProjectKind();
  if (!isEngineKind(kind)) {
    console.log(kleur.yellow('  This folder is not a Unity/Godot/GameMaker project — nothing to ingest from disk.'));
    return;
  }

  const spinner = makeSpinner({ text: countingSpritesText(0), spinner: 'dots' }).start();
  const index = await indexGamePngs(kind, process.cwd(), config.outDir, {
    onProgress: (p) => { spinner.text = countingSpritesText(p); },
  });
  spinner.stop();
  const matched = matchConnectGlobs(index, config.connect, config.exclude);
  const skipped = describeExcluded(matched);
  if (skipped) console.log(kleur.dim(`  ${skipped}`));
  if (matched.entries.length === 0) {
    console.log(kleur.yellow(`  No PNGs matched. Try \`${cmd('search')} <name>\` to see indexed paths.`));
    return;
  }
  const n = matched.entries.length;
  console.log(
    kleur.dim(
      `  ${n} sprite${n === 1 ? '' : 's'} to sync (of ${index.files.length} in your game).`,
    ),
  );
  if (n >= 200) {
    console.log(kleur.dim(`  Found ${n} sprites. Only new or changed files upload.`));
  }
  await runPush({ gameIndex: index });
}
