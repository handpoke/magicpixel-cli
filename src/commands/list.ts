import kleur from 'kleur';
import { loadConfig } from '../config.js';
import { fetchAllManifest } from '../api.js';
import { formatBytes } from '../util/format.js';

export async function listCommand(): Promise<void> {
  const config = await loadConfig();
  const entries = await fetchAllManifest(config);
  if (entries.length === 0) {
    console.log(kleur.yellow('No matching assets.'));
    return;
  }
  const widthKey = Math.max(3, ...entries.map((e) => e.key.length));
  const sizes = entries.map((e) => (e.size_bytes != null ? formatBytes(e.size_bytes) : '-'));
  const widthSize = Math.max(4, ...sizes.map((s) => s.length));
  console.log(
    kleur.bold('KEY'.padEnd(widthKey)) + '  ' +
    kleur.bold('SIZE'.padEnd(widthSize)) + '  ' +
    kleur.bold('SHA256'),
  );
  entries.forEach((e, i) => {
    const sha = e.sha256 ? e.sha256.slice(0, 12) : '-';
    console.log(`${e.key.padEnd(widthKey)}  ${sizes[i].padEnd(widthSize)}  ${sha}`);
  });
  console.log();
  console.log(kleur.dim(`${entries.length} asset${entries.length === 1 ? '' : 's'}`));
}

