import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

import { configPath, loadConfig } from '../config.js';
import { hasPackageJson } from '../util/framework.js';
import { findKeyInDotenv, readCredentialsSync, writeCredentials } from '../util/credentials.js';
import { initCommand } from './init.js';
import { loginCommand } from './login.js';
import { syncCommand } from './sync.js';

interface StartOpts {
  force?: boolean;
}

/**
 * One-command bootstrap for new users. Runs init → key prompt → first sync →
 * prints copy-pasteable watch instructions. Designed so a non-technical user
 * can paste `npx magicpixel start` and end up with sprites on disk and a watch
 * script ready to run.
 */
export async function startCommand(opts: StartOpts = {}): Promise<void> {
  console.log(kleur.bold('🪄  MagicPixel — first-run setup'));
  console.log(kleur.dim('  This walks you through getting your sprites onto disk.'));
  console.log();

  // 1. Need a package.json — refuse to scaffold into a non-project directory.
  if (!hasPackageJson()) {
    console.log(
      kleur.yellow(
        '  MagicPixel needs a JavaScript project (package.json) to sync into.\n' +
          '  Run this inside your project folder — the one with package.json.',
      ),
    );
    return;
  }

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
      console.log(kleur.dim('  Re-run `npx magicpixel start --force` to overwrite it, or fix the file by hand.'));
      return;
    }
  } else {
    await initCommand({ yes: true, force: opts.force });
  }

  // 3. Offer to migrate any key sitting in .env / .env.local.
  await maybeMigrateDotenvKey();

  // 4. Make sure we have a usable key. Env var or stored credentials are fine.
  const haveEnv = !!process.env.MAGICPIXEL_API_KEY;
  const stored = readCredentialsSync();
  if (!haveEnv && !stored) {
    console.log();
    console.log(kleur.bold('Step: connect your account'));
    await loginCommand();
  } else if (haveEnv) {
    console.log(kleur.dim('  Using MAGICPIXEL_API_KEY from your environment.'));
  } else {
    console.log(kleur.dim('  Using stored credentials from .magicpixel/credentials.'));
  }

  // 5. First sync. syncCommand sets `process.exitCode = 1` on download
  //    failures without throwing — snapshot around the call so we don't
  //    print a misleading green "you're set up" over a half-failed run.
  console.log();
  console.log(kleur.bold('Step: first sync'));
  const exitBefore = process.exitCode ?? 0;
  await syncCommand({ full: true });
  const firstSyncFailed = (process.exitCode ?? 0) > exitBefore;

  // 6. Tell the user how to run the watch loop. If `init` couldn't patch
  //    package.json (non-standard layout, write-protected, etc.) the
  //    `magicpixel:watch` npm script won't exist — fall back to the
  //    `npx` form so we never instruct users to run a script they don't have.
  console.log();
  if (firstSyncFailed) {
    console.log(kleur.yellow('! first sync completed with errors.'));
    console.log(kleur.dim('  Re-run `npx magicpixel sync` to retry the failed downloads, or `npx magicpixel doctor` to diagnose.'));
  } else {
    console.log(kleur.bold('You\'re set up. ✨'));
  }
  console.log();
  const hasWatch = await hasWatchScript();
  if (hasWatch) {
    console.log(`  ${kleur.green('▶')} ${kleur.bold('npm run magicpixel:watch')}   ${kleur.dim('# keeps sprites fresh while you edit them in MagicPixel')}`);
  } else {
    console.log(`  ${kleur.green('▶')} ${kleur.bold('npx magicpixel sync --watch')}   ${kleur.dim('# keeps sprites fresh while you edit them in MagicPixel')}`);
  }
  console.log();
  if (await hasDevScript()) {
    const watchCmd = hasWatch ? 'npm run magicpixel:watch' : 'npx magicpixel sync --watch';
    console.log(kleur.dim('  Tip: run your dev server and the watcher together with'));
    console.log(kleur.dim(`       \`npx concurrently "npm run dev" "${watchCmd}"\``));
    console.log();
  }
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
    console.log(kleur.green(`✓ migrated key from ${found.file} → .magicpixel/credentials`));
    console.log(kleur.dim(`  You can now remove the MAGICPIXEL_API_KEY line from ${found.file}.`));
  } finally {
    rl.close();
  }
}
