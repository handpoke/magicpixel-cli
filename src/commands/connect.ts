import kleur from 'kleur';
import ora from 'ora';
import { loadConfig, saveConfig } from '../config.js';
import { assertSafeGlob } from '../util/security.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { indexGamePngs, matchConnectGlobs, GAME_INDEX_CAP_HINT, connectCapMessage, countingSpritesText } from '../util/gameScan.js';
import { isAllSpritesGlob, nextConnectGlobs } from '../util/engineConnect.js';
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
  const pattern = assertSafeGlob(glob);
  const config = await loadConfig();
  const next = nextConnectGlobs(config.connect, pattern);
  const changed =
    next.length !== config.connect.length || next.some((g, i) => g !== config.connect[i]);
  if (changed) {
    config.connect = next;
    await saveConfig(config);
    console.log(kleur.green(`✓ now syncing ${describeWorkingSet(pattern)}`));
  }

  const kind = await detectProjectKind();
  if (!isEngineKind(kind)) {
    console.log(kleur.yellow('  This folder is not a Unity/Godot/GameMaker project — nothing to ingest from disk.'));
    return;
  }

  const spinner = ora({ text: countingSpritesText(0), spinner: 'dots' }).start();
  const index = await indexGamePngs(kind, process.cwd(), config.outDir, {
    onProgress: (p) => { spinner.text = countingSpritesText(p); },
  });
  spinner.stop();
  if (index.capped) {
    console.log(kleur.yellow(`! ${GAME_INDEX_CAP_HINT}`));
  }
  const matched = matchConnectGlobs(index, config.connect);
  if (matched.capped) {
    console.log(kleur.yellow(`! ${connectCapMessage(matched.total, matched.entries.length)}`));
  }
  if (matched.entries.length === 0) {
    console.log(kleur.yellow(`  No PNGs matched. Try \`${cmd('search')} <name>\` to see indexed paths.`));
    return;
  }
  const n = matched.entries.length;
  console.log(
    kleur.dim(
      `  ${n} sprite${n === 1 ? '' : 's'} to sync (of ${index.files.length} in your game` +
        (matched.capped ? `, ${matched.total} matched` : '') +
        `).`,
    ),
  );
  if (n >= 200) {
    console.log(kleur.dim(`  Already-imported sprites are skipped; only new or changed files upload.`));
  }
  await runPush({ gameIndex: index });
}
