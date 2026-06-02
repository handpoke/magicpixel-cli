import { resolveEndpoint, type MagicPixelConfig } from '../config.js';
import { ApiError, retryTransient } from '../api.js';
import { safeFetch, readBodyWithLimit } from './security.js';
import { authHeaders } from './authHeaders.js';

/**
 * Validate an API key against `/manifest?limit=1`. Throws a friendly error on
 * rejection / network failure; resolves silently on success. Used by `login`
 * (post-prompt) and `repair` (step 1).
 *
 * Wrapped in `retryTransient` so a single 503 or network blip during
 * onboarding doesn't kick the user back to "paste your key again". Carries
 * `X-Request-Id` so a rejection is grep-able in the edge function logs
 * (mem://integration/cli-request-id-contract).
 */
export async function assertKeyValid(key: string, config: MagicPixelConfig): Promise<void> {
  const url = new URL(`${resolveEndpoint(config)}/manifest`);
  url.searchParams.set('limit', '1');
  await retryTransient('validate key', async () => {
    const { headers, requestId } = authHeaders(key);
    const res = await safeFetch(url.href, { headers });
    const serverRequestId = res.headers.get('x-request-id') ?? requestId;
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      // 4xx auth — non-retryable. Throw as ApiError so retryTransient bubbles
      // immediately rather than burning two extra attempts.
      throw new ApiError(
        res.status,
        `Key was rejected (${res.status}). Generate a fresh one at https://magicpixel.art/settings.\n` +
          `  (request id: ${serverRequestId})`,
        serverRequestId,
      );
    }
    if (!res.ok) {
      // Cap body read so a misbehaving endpoint returning a multi-MB error
      // page can't balloon CLI memory. 16 KB is plenty for the 120-char slice
      // we ultimately surface.
      const bodyBytes = await readBodyWithLimit(res, 16 * 1024).catch(() => new Uint8Array());
      const body = new TextDecoder().decode(bodyBytes);
      // 5xx + 429 retry through retryTransient; other 4xx bubble immediately.
      throw new ApiError(
        res.status,
        `Server returned ${res.status}: ${body.slice(0, 120)}\n` +
          `  (request id: ${serverRequestId})`,
        serverRequestId,
      );
    }
    await res.body?.cancel();
  });
}
