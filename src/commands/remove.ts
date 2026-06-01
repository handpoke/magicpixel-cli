import kleur from 'kleur';
import { loadConfig, saveConfig } from '../config.js';
import { assertSafeGlob } from '../util/security.js';

export async function removeCommand(glob: string): Promise<void> {
  const pattern = assertSafeGlob(glob);
  const config = await loadConfig();
  const before = config.include.length;
  config.include = config.include.filter((g) => g !== pattern);
  if (config.include.length === before) {
    console.log(kleur.yellow(`not found in include: ${pattern}`));
    return;
  }
  await saveConfig(config);
  console.log(kleur.green(`✓ removed include pattern: ${pattern}`));
}
