import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

import { configPath } from '../config.js';
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

  // 2. Run init non-interactively unless config already exists.
  const cfgPath = configPath();
  if (existsSync(cfgPath) && !opts.force) {
    console.log(kleur.dim(`  Found existing magicpixel.json — skipping init.`));
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

  // 5. First sync.
  console.log();
  console.log(kleur.bold('Step: first sync'));
  await syncCommand({ full: true });

  // 6. Tell the user how to run the watch loop.
  console.log();
  console.log(kleur.bold('You\'re set up. ✨'));
  console.log();
  console.log(`  ${kleur.green('▶')} ${kleur.bold('npm run magicpixel:watch')}   ${kleur.dim('# keeps sprites fresh while you edit them in MagicPixel')}`);
  console.log();
  if (await hasDevScript()) {
    console.log(kleur.dim('  Tip: run your dev server and the watcher together with'));
    console.log(kleur.dim('       `npx concurrently "npm run dev" "npm run magicpixel:watch"`'));
    console.log();
  }
}

async function hasDevScript(): Promise<boolean> {
  try {
    const path = resolve(process.cwd(), 'package.json');
    if (!existsSync(path)) return false;
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    return typeof pkg.scripts?.dev === 'string';
  } catch {
    return false;
  }
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
