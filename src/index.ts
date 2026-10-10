#!/usr/bin/env node
import { Command } from 'commander';
import kleur from 'kleur';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { pushCommand } from './commands/push.js';
import { addCommand } from './commands/add.js';
import { removeCommand } from './commands/remove.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import { whoamiCommand } from './commands/whoami.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { doctorCommand } from './commands/doctor.js';
import { repairCommand } from './commands/repair.js';
import { startCommand } from './commands/start.js';
import { connectCommand } from './commands/connect.js';
import { resyncCommand } from './commands/resync.js';
import { searchCommand } from './commands/search.js';
import { whyCommand } from './commands/why.js';
import { consolidateCommand } from './commands/consolidate.js';
import { findWorkspaceRoot, resolveInvokedPath } from './util/workspace.js';
import { errorCard, setPlain } from './util/ui.js';
import { cleanStraysCommand } from './commands/cleanStrays.js';
import { parseWatchInterval, parseConcurrency } from './util/flagValidators.js';
import { CLI_VERSION } from './version.js';
import { cmd } from './util/invoke.js';

// Node version guard
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(kleur.red(`magicpixel requires Node.js >= 18 (you have ${process.versions.node}).`));
  process.exit(1);
}

// A monorepo has one setup at its root. Run from any game folder inside it,
// every command uses that setup, so a second one is never created.
{
  const wsRoot = findWorkspaceRoot(process.cwd());
  if (wsRoot) {
    process.stderr.write(kleur.dim(`Using the MagicPixel setup in ${wsRoot}\n`));
    // Paths typed by the user stay relative to where they ran the command.
    process.env.MAGICPIXEL_INVOKED_FROM = process.cwd();
    process.chdir(wsRoot);
  }
}

// `--plain` anywhere: no colors, emoji or redraws (also NO_COLOR, CI, pipes).
{
  const i = process.argv.indexOf('--plain');
  if (i > 1) {
    process.argv.splice(i, 1);
    setPlain(true);
  }
}

const program = new Command();

program
  .name('magicpixel')
  .description('Sync MagicPixel pixel-art assets to your local project')
  .version(CLI_VERSION);

const wrap =
  <T extends unknown[]>(commandName: string, fn: (...a: T) => Promise<void>) =>
  async (...args: T) => {
    try {
      await fn(...args);
    } catch (e) {
      const err = e as Error;
      const msg = err.message ?? String(e);
      // Multi-line messages are already formatted with "Fix:" hints — print as-is.
      console.error(errorCard(msg));
      // Fire-and-forget telemetry → exit 1. `reportAndExit` decides whether
      // the error is worth surfacing on /admin/errors (5xx ApiErrors +
      // unexpected throws); user-fixable errors are filtered out inside
      // `shouldReportCliError`. Lazy-imported so cold paths (e.g. `--help`)
      // don't pay the cost.
      const { reportAndExit } = await import('./util/telemetry.js');
      await reportAndExit(err, commandName, 1);
    }
  };


program
  .command('start')
  .description('One-command first-run setup: init + login + first sync')
  .option('--force', 'Re-run init even if magicpixel.json exists')
  .option('--folder <path>', 'Sync only this game folder first (skips the "all or one folder" question)')
  .action(wrap("start", async (opts) => startCommand(opts)));

program
  .command('init')
  .description('Create magicpixel.json (interactive)')
  .option('--force', 'Overwrite existing config')
  .option('-y, --yes', 'Skip prompts, use defaults (CI-friendly)')
  .action(wrap("init", async (opts) => initCommand(opts)));

program
  .command('login')
  .description('Save your MagicPixel API key to .magicpixel/credentials')
  .option('--key <key>', 'Provide the key non-interactively')
  .action(wrap("login", async (opts) => loginCommand(opts)));

program
  .command('logout')
  .description('Remove the stored MagicPixel API key')
  .action(wrap("logout", async () => logoutCommand()));

program
  .command('doctor')
  .description('Print a single-page diagnostic to paste to your AI agent')
  .option('--json', 'Emit a stable JSON report (pipeable into jq or an LLM)')
  .option('--offline', 'Skip the live manifest probe (useful behind a strict proxy)')
  .addHelpText('after', '\nExamples:\n  $ magicpixel doctor\n  $ magicpixel doctor --json | jq .network\n')
  .action(wrap("doctor", async (opts) => doctorCommand(opts as Parameters<typeof doctorCommand>[0])));

program
  .command('repair')
  .description('Self-heal a broken sync: validate key, reset state, re-sync')
  .option('--dry-run', 'Print the plan without writing files')
  .option('-y, --yes', 'Skip the confirmation prompt before resetting state')
  .addHelpText('after', '\nExamples:\n  $ magicpixel repair --dry-run    # see what would change\n  $ magicpixel repair --yes        # non-interactive recovery\n')
  .action(wrap("repair", async (opts) => repairCommand(opts as Parameters<typeof repairCommand>[0])));

program
  .command('sync')
  .description('Two-way sync: pull MagicPixel edits, push your game sprites')
  .option('--no-prune', 'Keep local files not in the manifest (pruning is now on by default)')
  .option('--dry-run', 'Print the plan without writing files')
  .option('--full', 'Ignore lastSync state; re-fetch the full manifest')
  .option('-w, --watch [seconds]', 'Poll for changes (default 2s; auto-slows to 5s after ~1min idle, 10s after ~5min)', parseWatchInterval as (v: string, prev: unknown) => string)
  .option('-q, --quiet', 'Minimal output (for CI)')
  .option('-c, --concurrency <n>', 'Parallel downloads (1–16, default 6)', parseConcurrency)
  .option('--only <folder...>', 'Only sync these game folders (repeatable), e.g. Runtime/Sprites/Entities/decorations')
  .option('--here', 'Download here even if these sprites are connected to another game folder')
  .argument('[extra...]')
  .addHelpText('after', '\nExamples:\n  $ magicpixel sync --watch --only Runtime/Sprites/Enemies   # one folder\n  $ magicpixel sync                # incremental sync\n  $ magicpixel sync --full         # ignore lastSync, re-check everything\n  $ magicpixel sync -w             # watch mode (2s; adaptive idle backoff; exit 2 after 5 auth failures)\n')
  .action(wrap("sync", async (extra: string[], opts) => {
    if (extra.length > 0) {
      throw new Error(
        `sync doesn't take a folder (got "${extra.join(' ')}").\n` +
          `  Fix: ${cmd(`sync --only ${extra[0].replace(/^\/+/, '')}`)}`,
      );
    }
    const o = opts as Parameters<typeof syncCommand>[0];
    return syncCommand(o.only ? { ...o, only: o.only.map((f) => resolveInvokedPath(f)) } : o);
  }));

program
  .command('push')
  .description('Upload local sprite edits back to MagicPixel (two-way sync)')
  .option('--dry-run', 'Print what would be pushed without sending anything')
  .option('--flatten', 'Allow replacing multi-layer artboards with the flat local image')
  .option('--force', 'Keep your local copy when a sprite also changed in MagicPixel (skips files saved in the MagicPixel editor)')
  .option('--overwrite-editor-changes', 'With --force: also replace files saved in the MagicPixel editor')
  .addHelpText('after', '\nExamples:\n  $ magicpixel push --dry-run      # see what changed on disk\n  $ magicpixel push                # send local edits + new sprites\n  $ magicpixel push --force        # your local copy wins on both-sides-changed\n')
  .action(wrap("push", async (opts) => pushCommand(opts as Parameters<typeof pushCommand>[0])));

program
  .command('resync <folder>')
  .description('Make one MagicPixel folder match your local game folder (local wins, missing files go to Trash)')
  .option('-y, --yes', 'Skip the confirmation question')
  .option('--dry-run', 'Show what would change without sending anything')
  .addHelpText('after', '\nExamples:\n  $ magicpixel resync Sprites/Enemies --dry-run\n  $ magicpixel resync Sprites/Enemies\n')
  .action(wrap("resync", async (folder: string, opts) => resyncCommand(resolveInvokedPath(folder), opts as Parameters<typeof resyncCommand>[1])));

program
  .command('connect <glob>')
  .description('Limit which game folders sync (default is all sprites)')
  .addHelpText('after', '\nExamples:\n  $ magicpixel connect \'assets/Sprites/Hero/**\'\n  $ magicpixel connect Runtime/UI/hud.png\n')
  .action(wrap("connect", async (glob: string) => connectCommand(resolveInvokedPath(glob))));

program
  .command('search <query>')
  .description('Search indexed game PNGs (no network)')
  .addHelpText('after', '\nExamples:\n  $ magicpixel search hero\n')
  .action(wrap("search", async (query: string) => searchCommand(query)));


program
  .command('add <glob>')
  .description('Append a glob pattern to include')
  .action(wrap("add", async (glob: string) => addCommand(glob)));

program
  .command('remove <glob>')
  .description('Remove a glob pattern from include')
  .action(wrap("remove", async (glob: string) => removeCommand(glob)));

program
  .command('list')
  .description('List the matching assets in the manifest')
  .addHelpText('after', '\nExamples:\n  $ magicpixel list                # tabular preview of every matching asset\n  $ magicpixel list | head         # quick sanity-check after editing include globs\n')
  .action(wrap("list", async () => listCommand()));

program
  .command('status')
  .description('Show config, last sync, and diff vs remote')
  .action(wrap("status", async () => statusCommand()));

program
  .command('whoami')
  .description('Verify the API key and show what it can see')
  .action(wrap("whoami", async () => whoamiCommand()));

program
  .command('why <path>')
  .description('Explain what the next sync does with the game PNGs under a path')
  .addHelpText('after', '\nExamples:\n  $ magicpixel why .SpineRaw/rabbit\n  $ magicpixel why Assets/Sprites/hero.png\n')
  .action(wrap("why", async (path: string) => whyCommand(path)));

program
  .command('consolidate')
  .description('Merge the MagicPixel setups of several game folders into one at this (monorepo) folder')
  .option('-y, --yes', 'Skip the confirmation question')
  .option('--dry-run', 'Show what would change without changing anything')
  .action(wrap("consolidate", async (opts) => { await consolidateCommand(opts as { yes?: boolean; dryRun?: boolean }); }));

program
  .command('clean-strays')
  .description('Delete copies sync wrote into outDir for sprites that belong to another game folder')
  .option('-y, --yes', 'Skip the confirmation question')
  .option('--dry-run', 'List the copies without deleting anything')
  .action(wrap("clean-strays", async (opts) => cleanStraysCommand(opts as { yes?: boolean; dryRun?: boolean })));

program.parseAsync(process.argv);
