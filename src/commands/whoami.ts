import kleur from 'kleur';
import { loadConfig, resolveEndpoint, getApiKey } from '../config.js';

export async function whoamiCommand(): Promise<void> {
  const config = await loadConfig();
  const url = new URL(`${resolveEndpoint(config)}/manifest`);
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  if (res.status === 401 || res.status === 403) {
    console.log(kleur.red('✗ API key rejected (401/403).'));
    console.log(kleur.dim('  Generate a new key at MagicPixel → Settings → API Keys.'));
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.log(kleur.red(`✗ ${res.status}: ${await res.text()}`));
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as { count: number; items: Array<{ key: string }> };
  console.log(kleur.green('✓ key valid'));
  console.log(`  endpoint: ${resolveEndpoint(config)}`);
  console.log(`  visible:  ${body.count > 0 ? `${body.count}+ asset${body.count === 1 ? '' : 's'} (first: ${body.items[0]?.key ?? '-'})` : kleur.yellow('0 assets — is the key bound to a project with content?')}`);
}
