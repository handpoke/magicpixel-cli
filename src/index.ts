#!/usr/bin/env node
import { Command } from 'commander';
import kleur from 'kleur';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
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
import { parseWatchInterval, parseConcurrency } from './util/flagValidators.js';
import { CLI_VERSION } from './version.js';

// Node version guard
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(kleur.red(`magicpixel requires Node.js >= 18 (you have ${process.versions.node}).`));
  process.exit(1);
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
      console.error(kleur.red(msg));
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
  .action(wrap("doctor", async (opts) => doctorCommand(opts)));

program
  .command('repair')
  .description('Self-heal a broken sync: validate key, reset state, re-sync')
  .option('--dry-run', 'Print the plan without writing files')
  .option('-y, --yes', 'Skip the confirmation prompt before resetting state')
  .addHelpText('after', '\nExamples:\n  $ magicpixel repair --dry-run    # see what would change\n  $ magicpixel repair --yes        # non-interactive recovery\n')
  .action(wrap("repair", async (opts) => repairCommand(opts)));

program
  .command('sync')
  .description('Download changed assets from MagicPixel')
  .option('--no-prune', 'Keep local files not in the manifest (pruning is now on by default)')
  .option('--dry-run', 'Print the plan without writing files')
  .option('--full', 'Ignore lastSync state; re-fetch the full manifest')
  .option('-w, --watch [seconds]', 'Poll for changes (default 2s; auto-slows to 5s after ~3min idle, 10s after ~15min)', parseWatchInterval as (v: string, prev: unknown) => string)
  .option('-q, --quiet', 'Minimal output (for CI)')
  .option('-c, --concurrency <n>', 'Parallel downloads (1–16, default 6)', parseConcurrency)
  .addHelpText('after', '\nExamples:\n  $ magicpixel sync                # incremental sync\n  $ magicpixel sync --full         # ignore lastSync, re-check everything\n  $ magicpixel sync -w             # watch mode (2s; adaptive idle backoff; exit 2 after 5 auth failures)\n')
  .action(wrap("sync", async (opts) => syncCommand(opts)));

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

program.parseAsync(process.argv);
