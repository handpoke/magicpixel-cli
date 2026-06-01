import kleur from 'kleur';
import { loadConfig, resolveEndpoint, getApiKey } from '../config.js';
import { CLI_USER_AGENT } from '../version.js';
import { safeFetch } from '../util/security.js';

export async function whoamiCommand(): Promise<void> {
  const config = await loadConfig();
  // Ask for a full page (server caps at 1000) so `count` is honest for any
  // project with ≤1000 assets — the previous `limit=1` always reported "1+".
  const url = new URL(`${resolveEndpoint(config)}/manifest`);
  url.searchParams.set('limit', '1000');

  const res = await safeFetch(url.href, {
    headers: { Authorization: `Bearer ${getApiKey()}`, 'User-Agent': CLI_USER_AGENT },
  });

  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    console.log(kleur.red('✗ API key rejected (401/403).'));
    console.log(kleur.dim('  Generate a new key at MagicPixel → Settings → API Keys.'));
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    console.log(kleur.red(`✗ ${res.status}: ${body.slice(0, 200)}`));
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as {
    count: number;
    items: Array<{ key: string }>;
    nextCursor: string | null;
  };
  const more = body.nextCursor ? '+' : '';
  console.log(kleur.green('✓ key valid'));
  console.log(`  endpoint: ${resolveEndpoint(config)}`);
  if (body.count === 0) {
    console.log(`  visible:  ${kleur.yellow('0 assets — is the key bound to a project with content?')}`);
  } else {
    console.log(
      `  visible:  ${body.count}${more} asset${body.count === 1 && !more ? '' : 's'}` +
        ` (first: ${body.items[0]?.key ?? '-'})`,
    );
  }
}
