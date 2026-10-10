/**
 * Common commands shown after `start`, in `--help`, and hinted after `sync`.
 * One list so the three places never drift apart.
 */
import kleur from 'kleur';
import { cmd } from './invoke.js';

export interface CommandTip {
  /** Subcommand and arguments, e.g. `sync --watch`. */
  run: string;
  what: string;
}

export const COMMAND_TIPS: readonly CommandTip[] = [
  { run: 'sync --watch', what: 'keep sprites fresh while you work' },
  { run: "connect '<folder>/**'", what: 'add a folder to sync (hidden ones like .SpineRaw/... too)' },
  { run: 'sync --only <folder>', what: 'sync just one folder' },
  { run: 'why <folder>', what: "see why files aren't uploading" },
  { run: 'resync <folder>', what: 'local files win for one folder' },
  { run: 'clean-strays', what: 'remove copies in the wrong place' },
  { run: 'status', what: 'check your setup and last sync' },
  { run: 'doctor', what: 'diagnose problems' },
];

const width = Math.max(...COMMAND_TIPS.map((t) => t.run.length));

/** "Useful commands" block for the end of `start`. */
export function formatTipsBlock(tips: readonly CommandTip[] = COMMAND_TIPS): string {
  const prefix = cmd('').trimEnd();
  return [
    kleur.bold('  Useful commands'),
    ...tips.map((t) => `    ${kleur.cyan(`${prefix} ${t.run.padEnd(width)}`)}  ${kleur.dim(t.what)}`),
  ].join('\n');
}

/** "Common tasks" section for `magicpixel --help` (no colors: commander prints raw). */
export function formatHelpTips(): string {
  return ['', 'Common tasks:', ...COMMAND_TIPS.map((t) => `  $ magicpixel ${t.run.padEnd(width)}  # ${t.what}`), ''].join('\n');
}

/** One-line hint after a one-shot sync. */
export function syncFooterHint(): string {
  return `  Not seeing a folder? Run \`${cmd('why')} <folder>\`. All commands: \`${cmd('--help')}\`.`;
}
