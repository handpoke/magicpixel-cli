import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { loadConfig, loadState, resolveEndpoint, defaultConfig, type MagicPixelConfig } from '../config.js';
import { describeKeySource } from '../util/credentials.js';
import { detectFramework, hasPackageJson } from '../util/framework.js';
import { CLI_VERSION } from '../version.js';

/**
 * Single-page diagnostic that a non-technical user can paste to their AI agent
 * when something breaks. Read-only — never mutates state or hits the network.
 */
export async function doctorCommand(): Promise<void> {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(kleur.bold('MagicPixel CLI — doctor'));
  push(kleur.dim(`  Paste this to your AI agent if something isn't working.`));
  push();

  push(`CLI version:        ${CLI_VERSION}`);
  push(`Node version:       ${process.versions.node}`);
  push(`Platform:           ${process.platform}`);
  push(`cwd:                ${process.cwd()}`);
  push();

  // Framework + package.json
  const framework = await detectFramework();
  push(`package.json:       ${hasPackageJson() ? 'found' : kleur.yellow('missing')}`);
  push(`Framework detected: ${framework ?? kleur.dim('none')}`);

  // Config
  let config: MagicPixelConfig | null = null;
  try {
    config = await loadConfig();
    push(`magicpixel.json:    found`);
    push(`  outDir:           ${config.outDir}`);
    push(`  emitIndex:        ${config.emitIndex === false ? 'false' : 'true'}`);
    push(`  include:          ${config.include.join(', ')}`);
    if (config.exclude.length) push(`  exclude:          ${config.exclude.join(', ')}`);
    if (config.endpoint) push(`  endpoint:         ${kleur.yellow(config.endpoint)} (custom)`);
  } catch (e) {
    push(`magicpixel.json:    ${kleur.yellow('missing')} (${(e as Error).message.split('\n')[0]})`);
  }
  push(`API endpoint:       ${resolveEndpoint(config ?? { ...defaultConfig })}`);

  // Key source
  const keySource = describeKeySource();
  const sourceLabel =
    keySource === 'env'
      ? 'environment variable (MAGICPIXEL_API_KEY)'
      : keySource === 'credentials-file'
        ? '.magicpixel/credentials'
        : kleur.yellow('none — run `magicpixel login`');
  push(`API key source:     ${sourceLabel}`);

  // Watch script
  let watchScript: string | null = null;
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      watchScript = pkg.scripts?.['magicpixel:watch'] ?? null;
    }
  } catch {
    // ignore
  }
  push(`Watch script:       ${watchScript ? `"${watchScript}"` : kleur.dim('not configured')}`);

  // State
  const state = await loadState();
  push(`Last sync:          ${state.lastSync ? new Date(state.lastSync).toLocaleString() : kleur.dim('never')}`);
  push(`Assets in state:    ${state.assets ? Object.keys(state.assets).length : 0}`);
  if (state.lastError) push(`Last error:         ${kleur.yellow(state.lastError)}`);

  // outDir contents (approximate)
  if (config) {
    const out = resolve(process.cwd(), config.outDir);
    if (existsSync(out)) {
      push(`outDir on disk:     ${relative(process.cwd(), out)} (exists)`);
    } else {
      push(`outDir on disk:     ${kleur.dim('not created yet')}`);
    }
  }

  push();
  push(kleur.dim('Next steps:'));
  if (keySource === 'none') push(kleur.dim('  • Run `magicpixel login` to store your API key.'));
  if (!config) push(kleur.dim('  • Run `magicpixel start` (or `magicpixel init`) to bootstrap.'));
  if (!watchScript && hasPackageJson()) {
    push(kleur.dim('  • Run `npm run magicpixel:watch` after init for live sync.'));
  }

  console.log(lines.join('\n'));
}
