import kleur from 'kleur';
import { loadConfig, loadState, resolveEndpoint, type MagicPixelConfig } from '../config.js';
import { fetchAllManifest } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { assetDiskPath } from '../util/paths.js';
import { readKeyForDisplay } from '../util/credentials.js';
import { createLimit } from '../util/limit.js';

export async function statusCommand(): Promise<void> {
  // Config is optional — a brand-new user can `magicpixel status` to inspect
  // their key/env before bothering with init. Mirrors `whoami` / `login`.
  let config: MagicPixelConfig | null = null;
  let configErr: string | null = null;
  try {
    config = await loadConfig();
  } catch (e) {
    configErr = (e as Error).message.split('\n')[0];
  }

  console.log(kleur.bold('Config'));
  if (config) {
    console.log(`  outDir:   ${config.outDir}`);
    console.log(`  include:  ${config.include.join(', ') || '(none)'}`);
    console.log(`  exclude:  ${config.exclude.join(', ') || '(none)'}`);
    console.log(`  endpoint: ${resolveEndpoint(config)}`);
  } else {
    console.log(kleur.yellow(`  magicpixel.json: ${configErr ?? 'missing'}`));
    console.log(kleur.dim(`  Run \`npx magicpixel init\` to create one.`));
  }
  console.log();

  const state = await loadState();
  console.log(kleur.bold('State'));
  console.log(`  lastSync: ${state.lastSync ?? kleur.dim('never')}`);
  if (state.lastError) console.log(`  lastError: ${kleur.yellow(state.lastError)}`);
  console.log();

  console.log(kleur.bold('Auth'));
  // Honors the same precedence as `getApiKey()` (env wins, then file written
  // by `magicpixel login`). The pre-Batch-B implementation only looked at the
  // env var and falsely reported "key not set" for logged-in users.
  const stored = readKeyForDisplay();
  if (!stored) {
    console.log(kleur.red('  no API key — run `magicpixel login` or set MAGICPIXEL_API_KEY'));
    return;
  }
  const sourceLabel = stored.source === 'env' ? 'env (MAGICPIXEL_API_KEY)' : 'file (.magicpixel/credentials)';
  console.log(`  key:      ${kleur.green('set')} (${maskKey(stored.value)}) ${kleur.dim(`— ${sourceLabel}`)}`);
  console.log();

  if (!config) return;  // No config, no diff to compute.

  console.log(kleur.bold('Diff vs remote'));
  try {
    const manifest = await fetchAllManifest(config);
    // Parallelize the SHA pre-check through the same concurrency pool sync
    // uses — on a 1k-asset project a serial loop dominates wall-clock time.
    const limit = createLimit(6);
    let changed = 0;
    let unchanged = 0;
    let missing = 0;
    await Promise.all(
      manifest.map((entry) =>
        limit(async () => {
          const local = await fileSha256(assetDiskPath(config!.outDir, entry));
          if (!local) missing++;
          else if (entry.sha256 && entry.sha256 === local) unchanged++;
          else changed++;
        }),
      ),
    );
    console.log(`  remote assets: ${manifest.length}`);
    console.log(`  ${kleur.dim('=')} unchanged: ${unchanged}`);
    console.log(`  ${kleur.yellow('~')} changed:   ${changed}`);
    console.log(`  ${kleur.green('+')} missing:   ${missing}`);
  } catch (e) {
    console.log(kleur.red(`  manifest fetch failed: ${(e as Error).message.split('\n')[0]}`));
  }
}

function maskKey(k: string): string {
  if (k.length <= 12) return '***';
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}
