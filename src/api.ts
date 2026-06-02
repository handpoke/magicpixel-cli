import { resolveEndpoint, getApiKey, CLI_VERSION, type MagicPixelConfig } from './config.js';
import {
  etagForSha256,
  MAX_ASSET_BYTES,
  readBodyWithLimit,
  safeFetch,
} from './util/security.js';
import { authHeaders } from './util/authHeaders.js';

export interface ManifestEntry {
  id: string;
  key: string;          // folder/slug or slug
  folder: string | null;
  slug: string;
  name: string;
  sha256: string | null;
  width: number | null;
  height: number | null;
  updated_at: string;
  size_bytes: number | null;
  download_url: string;
}

export interface ManifestResponse {
  items: ManifestEntry[];
  nextCursor: string | null;
  count: number;
}

interface FetchManifestOpts {
  config: MagicPixelConfig;
  since?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Error from the MagicPixel API. `requestId` is the `X-Request-Id` the server
 * echoed (or the one we minted client-side if the server didn't respond) —
 * surface it in user messages so support can correlate against edge logs.
 *
 * `retryAfterMs` is populated when the server sent a `Retry-After` header on
 * a 429/5xx; the retry helper honors it instead of the default backoff.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

function friendly(status: number, body: string, context: string): string {
  if (status === 401 || status === 403) {
    return (
      `${context}: ${status} — API key rejected.\n` +
      `  Fix: regenerate at https://magicpixel.art/settings and re-run \`magicpixel login\`.`
    );
  }
  if (status === 404) {
    return (
      `${context}: 404 — endpoint or asset not found.\n` +
      `  Fix: check the "endpoint" field in magicpixel.json, or remove it to use the default.`
    );
  }
  if (status === 429) {
    return `${context}: 429 — rate limited. Retry shortly.`;
  }
  if (status >= 500) {
    return `${context}: ${status} — MagicPixel server error. Retry shortly; status at https://magicpixel.art.`;
  }
  return `${context}: ${status} — ${body.slice(0, 200)}`;
}

/** Append "(request id: …)" to a friendly message — only when we have one. */
function withRequestId(message: string, requestId?: string): string {
  if (!requestId) return message;
  return `${message}\n  (request id: ${requestId})`;
}

/**
 * Authenticated header bundle for API requests. Re-reads `getApiKey()` on
 * every call so a `magicpixel login` in another terminal is picked up by the
 * next retry tick of a long-running `sync --watch`.
 */
function buildHeaders(extra?: Record<string, string>): { headers: Record<string, string>; requestId: string } {
  return authHeaders(getApiKey(), extra);
}

export async function fetchManifestPage(opts: FetchManifestOpts): Promise<ManifestResponse> {
  const url = new URL(`${resolveEndpoint(opts.config)}/manifest`);
  for (const inc of opts.config.include) url.searchParams.append('include', inc);
  for (const exc of opts.config.exclude) url.searchParams.append('exclude', exc);
  if (opts.since) url.searchParams.set('since', opts.since);
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
  if (opts.limit) url.searchParams.set('limit', String(opts.limit));

  // Reuse the same transient-failure policy as asset downloads: 3 attempts,
  // exponential backoff, honor Retry-After on 429/5xx. Network blips and
  // brief edge restarts otherwise blow up the whole sync mid-pagination.
  return retryTransient(`manifest`, async () => {
    const { headers, requestId } = buildHeaders();
    const res = await safeFetch(url.href, { headers });
    const serverRequestId = res.headers.get('x-request-id') ?? requestId;
    if (res.status >= 200 && res.status < 300) {
      const minCli = res.headers.get('x-magicpixel-min-cli-version');
      if (minCli) maybeWarnStaleCli(minCli);
      const data = (await res.json()) as Partial<ManifestResponse> | null;
      // Shape-guard the response. A malformed edge response (null,
      // {items: null}, nextCursor: 42, etc.) would otherwise either crash
      // inside the pagination loop ("null is not iterable") or get fed back
      // as a bogus ?cursor=42 on the next request. Surface a friendly
      // ApiError carrying the request id so support can grep the edge logs.
      const isObject = !!data && typeof data === 'object' && !Array.isArray(data);
      const cursor = isObject ? (data as Partial<ManifestResponse>).nextCursor : undefined;
      const cursorOk = cursor === null || cursor === undefined || typeof cursor === 'string';
      if (!isObject || !Array.isArray((data as Partial<ManifestResponse>).items) || !cursorOk) {
        throw new ApiError(
          502,
          withRequestId('manifest: unexpected server response shape (items missing or non-string cursor).', serverRequestId),
          serverRequestId,
        );
      }
      return data as ManifestResponse;
    }
    const bodyText = await res.text();
    throw new ApiError(
      res.status,
      withRequestId(friendly(res.status, bodyText, 'manifest'), serverRequestId),
      serverRequestId,
      retryAfterMsFromResponse(res),
    );
  });
}

/**
 * Run `fn` up to 3 times, backing off on network errors, 429, and 5xx.
 * Non-retryable ApiErrors (4xx other than 429) bubble immediately.
 *
 * - `ApiError.retryAfterMs` (populated from a `Retry-After` header on 429/5xx)
 *   wins over the default exponential backoff for the *next* attempt.
 * - Network/transport failures are wrapped once with a friendly hint and the
 *   request-id of the most recent attempt.
 */
export async function retryTransient<T>(context: string, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  let nextDelayMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error;
      if (err instanceof ApiError) {
        if (err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
        nextDelayMs = err.retryAfterMs ?? 0;
      } else {
        // Network/transport failure — wrap once with the existing hint.
        // Preserve the original error as `cause` so `--verbose` consumers
        // and Node's default printer can still surface the underlying stack.
        lastErr = new Error(
          `${context}: network error (${err.message}).\n` +
            `  Fix: check your internet connection and that the MagicPixel API is reachable.`,
          { cause: err },
        );
        nextDelayMs = 0;
      }
      if (attempt < maxAttempts) {
        const backoffMs = 250 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, Math.max(nextDelayMs, backoffMs)));
      }
    }
  }
  throw lastErr ?? new Error(`${context}: unknown error`);
}

// ----- Stale-CLI nudge ------------------------------------------------------
// Cheap version comparison: split on dots, compare numerically. Pre-release
// tags are ignored (treated as equal to their base) to avoid spamming devs
// running unpublished builds.
let staleWarned = false;
function maybeWarnStaleCli(minVersion: string): void {
  if (staleWarned) return;
  const current = (CLI_VERSION || '').split('-')[0];
  const min = (minVersion || '').split('-')[0];
  if (!current || !min) return;
  if (compareSemver(current, min) >= 0) return;
  staleWarned = true;
  // Use stderr so the message survives piping but doesn't pollute structured
  // stdout consumers.
  console.warn(
    `\n[magicpixel] CLI ${current} is older than the recommended ${min}.\n` +
      `  Fix: npm i -D @magicpixelart/cli@latest (or @magicpixelart/vite)\n`,
  );
}

/** Test-only: reset the module-singleton warn-once flag between vitest runs. */
export function __resetStaleWarnedForTesting(): void {
  staleWarned = false;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchAllManifest(
  config: MagicPixelConfig,
  since?: string,
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  let cursor: string | undefined;
  // Cycle guard: caps total pages so a buggy server cursor can't hang the CLI.
  // At 500 entries/page this is 100k assets — well past any realistic project.
  const MAX_PAGES = 200;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchManifestPage({ config, since, cursor, limit: 500 });
    out.push(...res.items);
    const nextCursor = res.nextCursor ?? undefined;
    if (!nextCursor) return out;
    // Detect a stuck cursor (server returns the same token it just received)
    // in O(1) round-trips instead of burning the full page budget.
    if (nextCursor === cursor) {
      throw new Error(
        `manifest: server returned a repeating cursor — possible server cursor loop.\n` +
          `  Fix: re-run with --full, or report at https://github.com/magicpixel/cli/issues.`,
      );
    }
    cursor = nextCursor;
  }
  throw new Error(
    `manifest: pagination exceeded ${MAX_PAGES} pages — possible server cursor loop.\n` +
      `  Fix: re-run with --full, or report at https://github.com/magicpixel/cli/issues.`,
  );
}

/**
 * Download a single asset by key. Returns null on 304 (not modified).
 * Shares the retryTransient policy with manifest fetches — including
 * Retry-After honoring and request-id propagation on failures.
 */
export async function fetchAssetBytes(
  config: MagicPixelConfig,
  key: string,
  knownSha?: string | null,
): Promise<Uint8Array | null> {
  const url = new URL(resolveEndpoint(config));
  url.searchParams.set('key', key);

  const conditional = knownSha ? { 'If-None-Match': etagForSha256(knownSha) } : undefined;

  return retryTransient(`download ${key}`, async () => {
    const { headers, requestId } = buildHeaders(conditional);
    const res = await safeFetch(url.href, { headers });
    const serverRequestId = res.headers.get('x-request-id') ?? requestId;
    if (res.status === 304) {
      // Drain so undici can return the socket to the keep-alive pool.
      await res.body?.cancel();
      return null;
    }
    if (res.ok) return await readBodyWithLimit(res, MAX_ASSET_BYTES);
    const bodyText = await res.text();
    throw new ApiError(
      res.status,
      withRequestId(friendly(res.status, bodyText, `download ${key}`), serverRequestId),
      serverRequestId,
      retryAfterMsFromResponse(res),
    );
  });
}

/**
 * Parse a `Retry-After` header (seconds or HTTP-date per RFC 7231) into ms.
 * Capped at 60s so a bogus header can't hang the CLI. Returns 0 when absent
 * or invalid (caller falls back to its default backoff).
 */
export function retryAfterMsFromResponse(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (!raw) return 0;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 60_000);
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), 60_000);
  }
  return 0;
}
