import kleur from 'kleur';
import { loadConfig, saveConfig } from '../config.js';
import { assertSafeGlob } from '../util/security.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { indexGamePngs, matchConnectGlobs, GAME_INDEX_CAP_HINT, connectCapMessage } from '../util/gameScan.js';
import { cmd } from '../util/invoke.js';
import { runPush } from './push.js';

/**
 * Add a working-set glob and ingest matching game PNGs into Connected.
 * Sync writes edits back to the original files — not a copy under outDir.
 */
export async function connectCommand(glob: string): Promise<void> {
  const pattern = assertSafeGlob(glob);
  const config = await loadConfig();
  const already = config.connect.includes(pattern);
  if (!already) {
    config.connect.push(pattern);
    await saveConfig(config);
    console.log(kleur.green(`✓ added connect pattern: ${pattern}`));
  } else {
    console.log(kleur.dim(`  connect pattern already present: ${pattern}`));
  }

  const kind = await detectProjectKind();
  if (!isEngineKind(kind)) {
    console.log(kleur.yellow('  This folder is not a Unity/Godot/GameMaker project — nothing to ingest from disk.'));
    return;
  }

  const index = await indexGamePngs(kind, process.cwd(), config.outDir);
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
      `  ${n} sprite${n === 1 ? '' : 's'} in working set (of ${index.files.length} indexed` +
        (matched.capped ? `, ${matched.total} matched` : '') +
        `).`,
    ),
  );
  if (n >= 200) {
    console.log(kleur.dim(`  Already-imported sprites are skipped; only new or changed files upload.`));
  }
  await runPush({ gameIndex: index });
}
