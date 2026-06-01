import kleur from 'kleur';
import { loadConfig, saveConfig } from '../config.js';
import { assertSafeGlob } from '../util/security.js';

export async function addCommand(glob: string): Promise<void> {
  const pattern = assertSafeGlob(glob);
  const config = await loadConfig();
  if (config.include.includes(pattern)) {
    console.log(kleur.yellow(`already included: ${pattern}`));
    return;
  }
  config.include.push(pattern);
  await saveConfig(config);
  console.log(kleur.green(`✓ added include pattern: ${pattern}`));
}
