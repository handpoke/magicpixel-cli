import kleur from 'kleur';
import { loadConfig } from '../config.js';
import { fetchAllManifest } from '../api.js';

export async function listCommand(): Promise<void> {
  const config = await loadConfig();
  const entries = await fetchAllManifest(config);
  if (entries.length === 0) {
    console.log(kleur.yellow('No matching assets.'));
    return;
  }
  const widthKey = Math.max(3, ...entries.map((e) => e.key.length));
  const widthSize = 8;
  console.log(
    kleur.bold('KEY'.padEnd(widthKey)) + '  ' +
    kleur.bold('SIZE'.padEnd(widthSize)) + '  ' +
    kleur.bold('SHA256'),
  );
  for (const e of entries) {
    const size = e.size_bytes != null ? `${e.size_bytes}B` : '-';
    const sha = e.sha256 ? e.sha256.slice(0, 12) : '-';
    console.log(`${e.key.padEnd(widthKey)}  ${size.padEnd(widthSize)}  ${sha}`);
  }
  console.log();
  console.log(kleur.dim(`${entries.length} asset${entries.length === 1 ? '' : 's'}`));
}
