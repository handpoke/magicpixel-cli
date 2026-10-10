/**
 * `magicpixel resync <folder>` — make one MagicPixel library folder match the
 * local game folder exactly:
 *   - every local sprite in the folder overwrites its MagicPixel copy (size
 *     follows the file, MagicPixel-only edits are replaced);
 *   - new local sprites are imported;
 *   - MagicPixel files in that folder with no local file go to Trash.
 */
import kleur from 'kleur';
import { ui } from '../util/ui.js';
import { confirm } from '../util/prompt.js';
import { canRedraw } from '../util/ui.js';
import { stripMemberSegment } from '../util/workspace.js';
import { stdin, stdout } from 'node:process';

import { loadConfig, loadState } from '../config.js';
import { ensureEngineConnect } from '../util/engineConnect.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { indexGamePngs, countingSpritesText } from '../util/gameScan.js';
import { pruneResyncFolder } from '../api.js';
import { runPushWith, type PushSummary } from './push.js';

export interface ResyncOpts {
  yes?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
}

export interface ResyncOutcome {
  push: PushSummary;
  trashed: number;
  pruneSkipped: string | null;
}

/** Same slug rules as library folders / manifest keys. */
export function slugifySegment(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function parseFolderArg(folder: string): string[] {
  return stripMemberSegment(folder
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => slugifySegment(s.trim()))
    .filter(Boolean));
}

/**
 * True when `key` (`<folders…>/<doc>/<artboard>`) lives inside `segments`.
 * Only the folder part of the key counts, so resyncing `enemies` never touches
 * a root document that happens to be named "enemies".
 */
export function keyInFolder(key: string, segments: readonly string[]): boolean {
  const parts = key.split('/');
  const folderParts = parts.slice(0, Math.max(0, parts.length - 2));
  if (folderParts.length < segments.length) return false;
  return segments.every((s, i) => folderParts[i] === s);
}


export async function resyncCommand(folder: string, opts: ResyncOpts = {}): Promise<void> {
  await runResync(parseFolderArg(folder), opts);
}

export async function runResync(segments: string[], opts: ResyncOpts = {}): Promise<ResyncOutcome> {
  if (segments.length === 0) {
    throw new Error('Pass a folder, e.g. `magicpixel resync Sprites/Enemies`. Resyncing the whole project is `push --force`.');
  }
  const log = (m: string) => { if (!opts.quiet) console.log(m); };
  const config = await ensureEngineConnect(await loadConfig(), process.cwd(), !opts.dryRun);
  const kind = await detectProjectKind();
  if (!isEngineKind(kind)) throw new Error('This folder is not a Unity/Godot/GameMaker project.');

  const gameIndex = await indexGamePngs(kind, process.cwd(), config.outDir, {
    onProgress: opts.quiet || !canRedraw() ? undefined : (p) => { stdout.write(`\r${countingSpritesText(p)}`); },
  });
  if (!opts.quiet && canRedraw()) stdout.write('\n');
  const keyFilter = (key: string) => keyInFolder(key, segments);
  const label = segments.join('/');

  // Plan first: what would change, and what would go to Trash.
  const plan = await runPushWith(config, await loadState(), {
    dryRun: true, replace: true, keyFilter, gameIndex, quiet: true,
  });
  if (plan.scanned === 0) {
    throw new Error(`No local sprites found in "${label}". Nothing was changed. Check the folder name with \`magicpixel search\`.`);
  }
  const preview = plan.keptAssetIds.length > 0
    ? await pruneResyncFolder(segments, plan.keptAssetIds, true)
    : null;

  log(kleur.bold(`Resync ${label} from your game`));
  log(`  local sprites: ${plan.scanned}`);
  if (preview) {
    log(`  to trash in MagicPixel (no local file): ${preview.wouldTrash.length}`);
    for (const n of preview.wouldTrash.slice(0, 10)) log(kleur.dim(`    - ${n}`));
    if (preview.wouldTrash.length > 10) log(kleur.dim(`    …and ${preview.wouldTrash.length - 10} more`));
  }
  log(kleur.dim('  Local files win: MagicPixel copies are overwritten and resized to match.'));

  if (opts.dryRun) {
    log(kleur.dim('--dry-run: nothing sent.'));
    return { push: plan, trashed: 0, pruneSkipped: 'dry-run' };
  }
  if (!opts.yes && !(await confirm('Continue? (y/N) '))) {
    throw new Error('Cancelled. Re-run with --yes to skip this question.');
  }

  const push = await runPushWith(config, await loadState(), {
    replace: true, keyFilter, gameIndex, quiet: opts.quiet,
  });

  let pruneSkipped: string | null = null;
  let trashed = 0;
  if (push.error > 0 || push.conflict > 0) pruneSkipped = 'some sprites failed to upload';
  else if (push.keptAssetIds.length === 0) pruneSkipped = 'no files confirmed';
  else {
    const res = await pruneResyncFolder(segments, push.keptAssetIds, false);
    trashed = res.trashed;
  }
  if (pruneSkipped) log(ui.warn(`Nothing moved to Trash (${pruneSkipped}). Re-run once fixed.`));
  else log(ui.ok(`${label} resynced. ${trashed} file${trashed === 1 ? '' : 's'} moved to Trash.`));
  return { push, trashed, pruneSkipped };
}
