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
  .version('0.1.0');

const wrap =
  <T extends unknown[]>(fn: (...a: T) => Promise<void>) =>
  async (...args: T) => {
    try {
      await fn(...args);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // Multi-line messages are already formatted with "Fix:" hints — print as-is.
      console.error(kleur.red(msg));
      process.exit(1);
    }
  };

program
  .command('init')
  .description('Create magicpixel.json (interactive)')
  .option('--force', 'Overwrite existing config')
  .option('-y, --yes', 'Skip prompts, use defaults (CI-friendly)')
  .action(wrap(async (opts) => initCommand(opts)));

program
  .command('sync')
  .description('Download changed assets from MagicPixel')
  .option('--prune', 'Delete local files no longer in the manifest')
  .option('--dry-run', 'Print the plan without writing files')
  .option('--full', 'Ignore lastSync state; re-fetch the full manifest')
  .option('-w, --watch [seconds]', 'Poll for changes (default 10s)', (v) => v ?? true)
  .option('-q, --quiet', 'Minimal output (for CI)')
  .option('-c, --concurrency <n>', 'Parallel downloads (1–16, default 6)', (v) => parseInt(v, 10))
  .action(wrap(async (opts) => syncCommand(opts)));

program
  .command('add <glob>')
  .description('Append a glob pattern to include')
  .action(wrap(async (glob: string) => addCommand(glob)));

program
  .command('remove <glob>')
  .description('Remove a glob pattern from include')
  .action(wrap(async (glob: string) => removeCommand(glob)));

program
  .command('list')
  .description('List the matching assets in the manifest')
  .action(wrap(async () => listCommand()));

program
  .command('status')
  .description('Show config, last sync, and diff vs remote')
  .action(wrap(async () => statusCommand()));

program
  .command('whoami')
  .description('Verify the API key and show what it can see')
  .action(wrap(async () => whoamiCommand()));

program.parseAsync(process.argv);
