import kleur from 'kleur';
import { loadConfig, defaultConfig, resolveEndpoint, getApiKey, type MagicPixelConfig } from '../config.js';
import { ApiError, retryTransient, retryAfterMsFromResponse } from '../api.js';
import { safeFetch } from '../util/security.js';
import { authHeaders } from '../util/authHeaders.js';

interface WhoamiBody {
  count: number;
  items: Array<{ key: string }>;
  nextCursor: string | null;
}

type WhoamiResult =
  | { kind: 'ok'; body: WhoamiBody; serverRequestId: string }
  | { kind: 'rejected'; status: number; serverRequestId: string }
  | { kind: 'error'; status: number; bodyText: string; serverRequestId: string };

export async function whoamiCommand(): Promise<void> {
  // Config is optional for `whoami` — a brand-new user runs it before `init`
  // to verify their key works at all. Mirror the same fallback `login` uses.
  let config: MagicPixelConfig;
  try {
    config = await loadConfig();
  } catch {
    config = { ...defaultConfig };
  }
  // Ask for a full page (server caps at 1000) so `count` is honest for any
  // project with ≤1000 assets — the previous `limit=1` always reported "1+".
  const url = new URL(`${resolveEndpoint(config)}/manifest`);
  url.searchParams.set('limit', '1000');

  // Wrap in retryTransient so a transient 503 / network blip doesn't make
  // `whoami` falsely report "key rejected" — the same recovery the rest of
  // the API surface gets.
  const result = await retryTransient<WhoamiResult>('whoami', async () => {
    const { headers, requestId } = authHeaders(getApiKey());
    const res = await safeFetch(url.href, { headers });
    const serverRequestId = res.headers.get('x-request-id') ?? requestId;
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      // Non-retryable: surface as a structured result rather than throwing,
      // so retryTransient doesn't burn extra attempts on a hard rejection.
      return { kind: 'rejected', status: res.status, serverRequestId };
    }
    if (res.status >= 500 || res.status === 429) {
      const bodyText = await res.text();
      // Pass Retry-After through so retryTransient honours server back-pressure
      // (matches fetchManifestPage / fetchAssetBytes).
      throw new ApiError(res.status, bodyText.slice(0, 200), serverRequestId, retryAfterMsFromResponse(res));
    }
    if (!res.ok) {
      const bodyText = await res.text();
      return { kind: 'error', status: res.status, bodyText, serverRequestId };
    }
    const raw = (await res.json()) as Partial<WhoamiBody>;
    // Shape-guard: mirror fetchManifestPage's contract so a malformed server
    // body (e.g. items missing or not an array) reports cleanly instead of
    // throwing TypeError on `body.items[0]?.key` below.
    const body: WhoamiBody = {
      count: typeof raw.count === 'number' && raw.count > 0 ? Math.floor(raw.count) : 0,
      items: Array.isArray(raw.items) ? raw.items.filter((i): i is { key: string } => !!i && typeof i.key === 'string') : [],
      nextCursor: typeof raw.nextCursor === 'string' && raw.nextCursor ? raw.nextCursor : null,
    };
    return { kind: 'ok', body, serverRequestId };
  });

  if (result.kind === 'rejected') {
    console.log(kleur.red(`✗ API key rejected (${result.status}).`));
    console.log(kleur.dim('  Generate a new key at MagicPixel → Settings → API Keys.'));
    console.log(kleur.dim(`  (request id: ${result.serverRequestId})`));
    process.exitCode = 1;
    return;
  }
  if (result.kind === 'error') {
    console.log(kleur.red(`✗ ${result.status}: ${result.bodyText.slice(0, 200)}`));
    console.log(kleur.dim(`  (request id: ${result.serverRequestId})`));
    process.exitCode = 1;
    return;
  }
  const { body } = result;
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
