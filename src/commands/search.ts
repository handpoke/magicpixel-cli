import kleur from 'kleur';
import ora from 'ora';
import { loadConfig } from '../config.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { indexGamePngs, searchGameIndex, GAME_INDEX_CAP_HINT, countingSpritesText } from '../util/gameScan.js';
import { cmd } from '../util/invoke.js';

const PRINT_CAP = 50;

/**
 * Substring search over the local game PNG index. No network.
 */
export async function searchCommand(query: string): Promise<void> {
  const q = query.trim();
  if (!q) {
    console.log(kleur.yellow('  Pass a search string, e.g. `magicpixel search hero`.'));
    return;
  }
  const kind = await detectProjectKind();
  if (!isEngineKind(kind)) {
    console.log(kleur.yellow('  Game-sprite search is for Unity, Godot, and GameMaker projects.'));
    return;
  }
  let outDir = '';
  try {
    outDir = (await loadConfig()).outDir;
  } catch {
    // Config is optional for search — skip MagicPixel outDir when missing.
  }
  const spinner = ora({ text: countingSpritesText(0), spinner: 'dots' }).start();
  const index = await indexGamePngs(kind, process.cwd(), outDir, {
    onProgress: (p) => { spinner.text = countingSpritesText(p); },
  });
  spinner.stop();
  if (index.capped) {
    console.log(kleur.yellow(`! ${GAME_INDEX_CAP_HINT}`));
  }
  const hits = searchGameIndex(index, q);
  if (hits.length === 0) {
    console.log(kleur.dim(`  No indexed PNGs matching "${q}" (${index.files.length} scanned).`));
    return;
  }
  const shown = hits.slice(0, PRINT_CAP);
  console.log(
    kleur.dim(
      `  ${hits.length} match${hits.length === 1 ? '' : 'es'} (of ${index.files.length} indexed). Connect with \`${cmd('connect')} '<glob>'\`.`,
    ),
  );
  for (const h of shown) {
    console.log(`  ${h.sourceRel}  ${kleur.dim(`→ ${h.key}`)}`);
  }
  if (hits.length > shown.length) {
    console.log(kleur.dim(`  …and ${hits.length - shown.length} more. Narrow the query.`));
  }
}
