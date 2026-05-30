import kleur from 'kleur';
import { loadConfig, saveConfig } from '../config.js';

export async function removeCommand(glob: string): Promise<void> {
  const config = await loadConfig();
  const before = config.include.length;
  config.include = config.include.filter((g) => g !== glob);
  if (config.include.length === before) {
    console.log(kleur.yellow(`not found in include: ${glob}`));
    return;
  }
  await saveConfig(config);
  console.log(kleur.green(`✓ removed include pattern: ${glob}`));
}
