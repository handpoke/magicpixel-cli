import kleur from 'kleur';
import { loadConfig, loadState, resolveEndpoint } from '../config.js';
import { fetchAllManifest } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { assetDiskPath } from '../util/paths.js';

export async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  const state = await loadState();

  console.log(kleur.bold('Config'));
  console.log(`  outDir:   ${config.outDir}`);
  console.log(`  include:  ${config.include.join(', ') || '(none)'}`);
  console.log(`  exclude:  ${config.exclude.join(', ') || '(none)'}`);
  console.log(`  endpoint: ${resolveEndpoint(config)}`);
  console.log();

  console.log(kleur.bold('State'));
  console.log(`  lastSync: ${state.lastSync ?? kleur.dim('never')}`);
  console.log();

  console.log(kleur.bold('Auth'));
  const key = process.env.MAGICPIXEL_API_KEY;
  if (!key) {
    console.log(kleur.red('  MAGICPIXEL_API_KEY not set'));
    return;
  }
  console.log(`  key:      ${kleur.green('set')} (${maskKey(key)})`);
  console.log();

  console.log(kleur.bold('Diff vs remote'));
  try {
    const manifest = await fetchAllManifest(config);
    let changed = 0;
    let unchanged = 0;
    let missing = 0;
    for (const entry of manifest) {
      const local = await fileSha256(assetDiskPath(config.outDir, entry));
      if (!local) missing++;
      else if (entry.sha256 && entry.sha256 === local) unchanged++;
      else changed++;
    }
    console.log(`  remote assets: ${manifest.length}`);
    console.log(`  ${kleur.dim('=')} unchanged: ${unchanged}`);
    console.log(`  ${kleur.yellow('~')} changed:   ${changed}`);
    console.log(`  ${kleur.green('+')} missing:   ${missing}`);
  } catch (e) {
    console.log(kleur.red(`  manifest fetch failed: ${(e as Error).message}`));
  }
}

function maskKey(k: string): string {
  if (k.length <= 12) return '***';
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}
