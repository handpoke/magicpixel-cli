import kleur from 'kleur';
import { ui } from '../util/ui.js';
import { confirm } from '../util/prompt.js';

let stepNo = 0;
let stepTotal = 0;
const step = (title: string) => console.log(ui.step(++stepNo, title, stepTotal));
import type { GameIndex } from '../util/gameScan.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { basename, dirname, resolve } from 'node:path';

import { configPath, loadConfig } from '../config.js';
import { detectProjectKind, hasPackageJson, isEngineKind } from '../util/framework.js';
import { findKeyInDotenv, readCredentialsSync, writeCredentials } from '../util/credentials.js';
import { initCommand } from './init.js';
import { consolidateCommand, needsConsolidation } from './consolidate.js';
import { cleanStraysCommand } from './cleanStrays.js';
import { runPush } from './push.js';
import { readWorkspaceMembers } from '../util/framework.js';
import { detectWorkspaceMembers } from '../util/workspace.js';
import { loginCommand } from './login.js';
import { syncCommand } from './sync.js';
import { cmd } from '../util/invoke.js';
import { assertKeyValid } from '../util/auth.js';
import { ApiError } from '../api.js';
import { connectCommand } from './connect.js';
import { isAllSpritesGlob } from '../util/engineConnect.js';
import type { MagicPixelConfig } from '../config.js';
import { COMMAND_TIPS, formatTipsBlock } from '../util/commandTips.js';

interface StartOpts {
  force?: boolean;
  folder?: string;
}

export type KeyCheck = 'ok' | 'rejected';

/** Validate a key; only auth rejections map to 'rejected' — other failures throw. */
export async function checkKey(key: string, config: MagicPixelConfig): Promise<KeyCheck> {
  try {
    await assertKeyValid(key, config);
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return 'rejected';
    throw e;
  }
}

/** `Sprites/Enemies` → `Sprites/Enemies/**`; already-globbed input is kept. */
export function folderToGlob(folder: string): string {
  const f = folder.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return /[*?]/.test(f) ? f : `${f}/**`;
}

/** Only ask on an interactive engine project still set to "everything". */
export function shouldAskFolder(connect: readonly string[], isTTY: boolean, engine: boolean): boolean {
  return isTTY && engine && (connect.length === 0 || connect.every(isAllSpritesGlob));
}

/**
 * One-command bootstrap for new users. Runs init → key prompt → first sync →
 * prints copy-pasteable watch instructions. Designed so a non-technical user
 * can paste `npx @magicpixelart/cli start` and end up with game sprites in
 * MagicPixel (and flagged sprites back on disk) plus a watch script.
 */
export async function startCommand(opts: StartOpts = {}): Promise<void> {
  console.log(kleur.bold('🪄  MagicPixel — first-run setup'));
  console.log(kleur.dim('  This links your game project and syncs sprites both ways.'));
  console.log();

  // Started inside one game folder of a monorepo: set up once at the root.
  if (!existsSync(configPath()) && stdin.isTTY) {
    const parent = dirname(process.cwd());
    const siblings = detectWorkspaceMembers(parent);
    if (siblings.length >= 2 && siblings.includes(basename(process.cwd()))) {
      const rl = createInterface({ input: stdin, output: stdout });
      let ans = '';
      try {
        ans = (await rl.question(
          `${kleur.cyan('?')} ${basename(process.cwd())} is one of ${siblings.length} game folders in ${parent}. Set up one MagicPixel for all of them there? ${kleur.dim('(Y/n)')} `,
        )).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (ans !== 'n' && ans !== 'no') process.chdir(parent);
    }
  }

  // Monorepo with several game folders: merge their old setups into one here.
  let consolidated = false;
  const merging = needsConsolidation();
  stepNo = 0;
  stepTotal = merging ? 3 : 2;
  if (merging) {
    step('One setup for all your game folders');
    consolidated = await consolidateCommand({});
    if (!consolidated && !readWorkspaceMembers(process.cwd())) return;
    console.log();
  }

  const kind = await detectProjectKind();
  // Engine projects (including Unity UPM packages) have no package.json
  // requirement. JS projects still need one.
  if (!hasPackageJson() && !isEngineKind(kind)) {
    console.log(
      kleur.yellow(
        '  MagicPixel needs a game project to sync into.\n' +
          '  Run this inside your Unity, Godot, GameMaker, or JavaScript folder\n' +
          '  (Unity package, project with Assets/, or a folder with package.json).',
      ),
    );
    return;
  }
  if (kind) console.log(kleur.dim(`  Detected: ${kind}`));

  // 2. Run init non-interactively unless config already exists AND is valid.
  // A broken `magicpixel.json` (hand-edited / truncated) used to slip past
  // the existsSync check here and then explode deep inside `syncCommand`.
  const cfgPath = configPath();
  if (existsSync(cfgPath) && !opts.force) {
    try {
      await loadConfig();
      console.log(kleur.dim(`  Found existing magicpixel.json — skipping init.`));
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.log(kleur.yellow(`  Existing magicpixel.json is invalid:`));
      for (const line of msg.split('\n')) console.log(kleur.yellow(`    ${line}`));
      console.log(kleur.dim(`  Re-run \`${cmd('start')} --force\` to overwrite it, or fix the file by hand.`));
      return;
    }
  } else {
    await initCommand({ yes: true, force: opts.force });
  }

  // 3. Offer to migrate any key sitting in .env / .env.local.
  await maybeMigrateDotenvKey();

  // 4. Make sure we have a usable key — and that it actually works. A stale
  //    stored key used to sail through and fail every request with 401.
  const config = await loadConfig();
  const envKey = process.env.MAGICPIXEL_API_KEY?.trim();
  const stored = readCredentialsSync();
  console.log();
  step('Your MagicPixel account');
  if (!envKey && !stored) {
    await loginCommand();
  } else if (envKey) {
    if ((await checkKey(envKey, config)) === 'rejected') {
      console.log(ui.fail('The MAGICPIXEL_API_KEY in your environment was rejected.'));
      console.log(ui.fix('set MAGICPIXEL_API_KEY to a fresh key from https://magicpixel.art/settings'));
      process.exitCode = 1;
      return;
    }
    console.log(ui.ok('Using MAGICPIXEL_API_KEY from your environment.'));
  } else if (stored && (await checkKey(stored.apiKey, config)) === 'rejected') {
    console.log(ui.warn('Your saved key was rejected (revoked, or from another account).'));
    if (!stdin.isTTY) {
      console.log(ui.fix(`${cmd('login')} --key mp_live_…`));
      process.exitCode = 1;
      return;
    }
    await loginCommand();
  } else {
    console.log(ui.ok('Signed in (saved key in .magicpixel/credentials).'));
  }

  // 4b. Don't push a whole game by surprise — offer one folder first.
  let folder = opts.folder?.trim();
  if (!folder && !config.workspace && shouldAskFolder(config.connect, !!stdin.isTTY, isEngineKind(kind))) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      folder = (await rl.question(
        `${kleur.cyan('?')} Sync all sprites, or one folder? ${kleur.dim('(type a folder like Sprites/Enemies, or press Enter for all)')} `,
      )).trim();
    } finally {
      rl.close();
    }
  }
  if (folder) {
    console.log();
    step('Sync one folder');
    await connectCommand(folderToGlob(folder));
    console.log();
    console.log(kleur.dim(`  Add another folder later with \`${cmd('connect')} "<folder>/**"\`.`));
    console.log(`  ${kleur.green('▶')} ${kleur.bold(`${cmd('sync')} --watch`)}   ${kleur.dim('# keeps sprites fresh while you edit them in MagicPixel')}`);
    return;
  }

  // 5. First sync. syncCommand sets `process.exitCode = 1` on download
  //    failures without throwing — snapshot around the call so we don't
  //    print a misleading green "you're set up" over a half-failed run.
  //    Manifest 546s throw after still importing local sprites; catch so
  //    the watch instructions below aren't swallowed.
  if (consolidated) await removeLeftoverStrays();
  const gameIndex = await maybeFlattenLayered();

  console.log();
  step('First sync');
  const exitBefore = process.exitCode ?? 0;
  try {
    await syncCommand({ full: true }, { gameIndex });
  } catch (e) {
    const err = e as Error;
    console.error(kleur.red(err.message ?? String(e)));
    process.exitCode = 1;
    const { reportCliError } = await import('../util/telemetry.js');
    await reportCliError(err, { command: 'start' });
  }
  const firstSyncFailed = (process.exitCode ?? 0) > exitBefore;

  // 6. Tell the user how to run the watch loop. If `init` couldn't patch
  //    package.json (non-standard layout, write-protected, etc.) the
  //    `magicpixel:watch` npm script won't exist — fall back to the
  //    `npx` form so we never instruct users to run a script they don't have.
  console.log();
  if (firstSyncFailed) {
    console.log(ui.warn('first sync completed with errors.'));
    console.log(kleur.dim(`  Re-run \`${cmd('sync')}\` to retry the failed downloads, or \`${cmd('doctor')}\` to diagnose.`));
  } else {
    console.log(kleur.bold('You\'re set up. ✨'));
  }
  console.log();
  const hasWatch = await hasWatchScript();
  if (hasWatch) {
    console.log(`  ${kleur.green('▶')} ${kleur.bold('npm run magicpixel:watch')}   ${kleur.dim('# keeps sprites fresh while you edit them in MagicPixel')}`);
  } else {
    console.log(`  ${kleur.green('▶')} ${kleur.bold(`${cmd('sync')} --watch`)}   ${kleur.dim('# keeps sprites fresh while you edit them in MagicPixel')}`);
  }
  console.log();
  console.log(kleur.dim('  Game sprites write back to their original path. New MagicPixel art lands in outDir.'));
  console.log();
  console.log(formatTipsBlock(COMMAND_TIPS.slice(1)));
  console.log();
  if (await hasDevScript()) {
    const watchCmd = hasWatch ? 'npm run magicpixel:watch' : `${cmd('sync')} --watch`;
    console.log(kleur.dim('  Tip: run your dev server and the watcher together with'));
    console.log(kleur.dim(`       \`npx concurrently "npm run dev" "${watchCmd}"\``));
    console.log();
  }
}

/** After a merge: drop copies an older sync wrote for another folder's sprites. */
async function removeLeftoverStrays(): Promise<void> {
  try {
    await cleanStraysCommand({ yes: true });
  } catch (e) {
    console.log(ui.warn(`couldn't check for stray copies: ${(e as Error).message.split('\n')[0]}`));
  }
}

/**
 * Local files win: offer to replace multi-layer MagicPixel artboards that a
 * normal upload refuses, instead of silently skipping them.
 */
async function maybeFlattenLayered(): Promise<GameIndex | undefined> {
  if (!stdin.isTTY) return undefined;
  let keys: string[] = [];
  let gameIndex: GameIndex | undefined;
  try {
    const plan = await runPush({ dryRun: true, quiet: true, nestedSync: true });
    keys = plan.needsFlatten ?? [];
    gameIndex = plan.gameIndex;
  } catch {
    return undefined;
  }
  if (keys.length === 0) return gameIndex;
  console.log();
  console.log(ui.warn(`${keys.length} of your files match a MagicPixel artboard with several layers:`));
  for (const k of keys.slice(0, 10)) console.log(kleur.dim(`    ${k}`));
  if (keys.length > 10) console.log(kleur.dim(`    …and ${keys.length - 10} more`));
  if (!(await confirm(`${kleur.cyan('?')} Replace them with your local files (layers are flattened)? ${kleur.dim('(y/N)')} `))) return gameIndex;
  const only = new Set(keys);
  await runPush({ flatten: true, keyFilter: (k) => only.has(k), gameIndex });
  return gameIndex;
}

async function readPkgJson(): Promise<Record<string, unknown> | null> {
  try {
    const path = resolve(process.cwd(), 'package.json');
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function hasWatchScript(): Promise<boolean> {
  const pkg = await readPkgJson();
  const scripts = pkg?.scripts;
  return !!scripts && typeof scripts === 'object' && typeof (scripts as Record<string, unknown>)['magicpixel:watch'] === 'string';
}

async function hasDevScript(): Promise<boolean> {
  const pkg = await readPkgJson();
  const scripts = pkg?.scripts;
  return !!scripts && typeof scripts === 'object' && typeof (scripts as Record<string, unknown>).dev === 'string';
}

async function maybeMigrateDotenvKey(): Promise<void> {
  if (process.env.MAGICPIXEL_API_KEY) return;
  if (readCredentialsSync()) return;
  if (!stdin.isTTY) return;
  const found = await findKeyInDotenv();
  if (!found) return;
  if (!/^mp_(live|test)_[a-f0-9]{64}$/.test(found.value)) return;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = (
      await rl.question(
        `${kleur.cyan('?')} Found MAGICPIXEL_API_KEY in ${found.file} — move it to .magicpixel/credentials so it stays out of your bundler? ${kleur.dim('(Y/n)')} `,
      )
    ).trim().toLowerCase();
    if (ans === 'n' || ans === 'no') return;
    await writeCredentials(found.value);
    console.log(ui.ok(`migrated key from ${found.file} → .magicpixel/credentials`));
    console.log(kleur.dim(`  You can now remove the MAGICPIXEL_API_KEY line from ${found.file}.`));
  } finally {
    rl.close();
  }
}
