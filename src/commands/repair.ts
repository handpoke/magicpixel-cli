import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, statePath, getApiKey } from '../config.js';
import { assertKeyValid } from '../util/auth.js';
import { listEmptyDirs, pruneEmptyDirs } from '../util/paths.js';
import { syncCommand } from './sync.js';

interface RepairOpts {
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * One-shot self-healing command. Runs the standard "turn it off and on
 * again" recovery sequence so support can say "run `npx magicpixel repair`":
 *
 *   1. Validate the stored API key.
 *   2. Quarantine `state.json` so the next sync re-derives everything.
 *   3. Prune empty subdirectories under `outDir`.
 *   4. Run a full sync (`--full --prune`).
 *
 * Idempotent. `--dry-run` reports the plan without writing. `--yes` skips the
 * confirmation prompt for step 2.
 */
export async function repairCommand(opts: RepairOpts = {}): Promise<void> {
  console.log(kleur.bold('MagicPixel repair'));
  console.log(kleur.dim('  Validates your setup, clears local sync state, and re-fetches everything.'));
  console.log();

  const config = await loadConfig();
  const sPath = statePath();

  // --- Step 1: validate API key --------------------------------------------
  console.log(kleur.bold('1/4 ') + 'Validating API key…');
  try {
    const key = getApiKey();
    await assertKeyValid(key, config);
    console.log(`     ${kleur.green('✓')} key accepted`);
  } catch (e) {
    // Preserve multi-line "Fix:" guidance from getApiKey()/assertKeyValid —
    // truncating to the first line strips the exact instructions a
    // first-time `repair` user needs.
    const msg = (e as Error).message ?? String(e);
    const [head, ...rest] = msg.split('\n');
    console.log(`     ${kleur.red('✗')} ${head}`);
    for (const line of rest) console.log(`     ${line}`);
    process.exitCode = 1;
    return;
  }

  // --- Step 2: quarantine state.json ---------------------------------------
  console.log(kleur.bold('2/4 ') + 'Resetting local sync state…');
  const stateExists = existsSync(sPath);
  // In dry-run we predict whether a real run *would* skip step 2: that
  // happens only when there's no --yes AND no TTY for the prompt to come
  // from (CI / piped input). Otherwise the prompt would run interactively
  // and we can't know the answer from here — assume "would proceed" for
  // the dry-run summary, matching the optimistic "plan looks good" line.
  let skippedStep2 = false;
  if (!stateExists) {
    console.log(`     ${kleur.dim('— no state.json on disk; nothing to reset')}`);
  } else if (opts.dryRun) {
    const dest = `${sPath}.repair-<ts>`;
    console.log(`     ${kleur.dim(`would move:  ${relative(process.cwd(), sPath)}`)}`);
    console.log(`     ${kleur.dim(`        →    ${relative(process.cwd(), dest)}`)}`);
    if (!opts.yes && !stdin.isTTY) {
      // Predict the skip a real run would hit, so step 4's note and the
      // closing summary stay honest.
      skippedStep2 = true;
      console.log(`     ${kleur.yellow('note')} ${kleur.dim('non-TTY without --yes — a real run would skip this step. Re-run with --yes.')}`);
    }
  } else {
    if (!opts.yes && !(await confirm(`Move ${relative(process.cwd(), sPath)} aside? (y/N) `))) {
      console.log(`     ${kleur.yellow('skipped')} (re-run with --yes to skip the prompt)`);
      skippedStep2 = true;
    } else {
      const dest = `${sPath}.repair-${Date.now()}`;
      try {
        await rename(sPath, dest);
        console.log(`     ${kleur.green('✓')} moved to ${relative(process.cwd(), dest)}`);
      } catch (e) {
        console.log(`     ${kleur.red('✗')} ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // --- Step 3: prune empty dirs --------------------------------------------
  console.log(kleur.bold('3/4 ') + 'Pruning empty directories under outDir…');
  const outRoot = resolve(process.cwd(), config.outDir);
  if (!existsSync(outRoot)) {
    console.log(`     ${kleur.dim(`— outDir doesn't exist yet (${config.outDir})`)}`);
  } else if (opts.dryRun) {
    const empties = await listEmptyDirs(outRoot);
    if (empties.length === 0) {
      console.log(`     ${kleur.dim('— no empty subdirs under outDir')}`);
    } else {
      console.log(`     ${kleur.dim(`would remove ${empties.length} empty subdir${empties.length === 1 ? '' : 's'}:`)}`);
      for (const p of empties.slice(0, 10)) {
        console.log(`     ${kleur.dim(`  - ${relative(process.cwd(), p)}`)}`);
      }
      if (empties.length > 10) {
        console.log(`     ${kleur.dim(`  …and ${empties.length - 10} more`)}`);
      }
    }
  } else {
    await pruneEmptyDirs(outRoot);
    console.log(`     ${kleur.green('✓')} done`);
  }

  // --- Step 4: full sync ---------------------------------------------------
  console.log(kleur.bold('4/4 ') + 'Running full sync…');
  if (skippedStep2) {
    console.log(kleur.dim('     (state was not reset — this will run a normal full sync, not a recovery)'));
  }
  if (opts.dryRun) {
    console.log(`     ${kleur.dim('would run `magicpixel sync --full` (skipped in --dry-run)')}`);
    console.log();
    if (skippedStep2) {
      console.log(kleur.yellow('! repair plan would skip the state reset. Re-run with --yes to apply it.'));
    } else {
      console.log(kleur.green('✓ repair plan looks good. Re-run without --dry-run to apply.'));
    }
    return;
  }
  console.log();
  // syncCommand sets `process.exitCode = 1` on download failures but does not
  // throw. Snapshot the value before/after so we can honour it in the final
  // message — otherwise we'd print a misleading green "complete" line over a
  // run that exited non-zero. Default to 0 so an already-failed prior step
  // doesn't mask a fresh failure (`1 === 1` would look like success).
  const exitBefore = process.exitCode ?? 0;
  await syncCommand({ full: true, prune: true });
  console.log();
  if ((process.exitCode ?? 0) > exitBefore) {
    console.log(
      kleur.yellow('! repair completed with errors — re-run `magicpixel sync` to retry the failed downloads.'),
    );
  } else {
    console.log(kleur.green('✓ repair complete.'));
  }
}

async function confirm(prompt: string): Promise<boolean> {
  if (!stdin.isTTY) return false;  // CI/non-interactive: default to NO; require --yes.
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`     ${prompt}`)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
