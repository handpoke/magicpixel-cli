import kleur from 'kleur';
import { loadConfig, saveConfig } from '../config.js';

export async function addCommand(glob: string): Promise<void> {
  const config = await loadConfig();
  if (config.include.includes(glob)) {
    console.log(kleur.yellow(`already included: ${glob}`));
    return;
  }
  config.include.push(glob);
  await saveConfig(config);
  console.log(kleur.green(`✓ added include pattern: ${glob}`));
}
