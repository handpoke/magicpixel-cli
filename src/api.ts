import { resolveEndpoint, getApiKey, CLI_USER_AGENT, type MagicPixelConfig } from './config.js';

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

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function friendly(status: number, body: string, context: string): string {
  if (status === 401 || status === 403) {
    return (
      `${context}: ${status} — API key rejected.\n` +
      `  Fix: regenerate at https://magicpixel.art/settings and re-export MAGICPIXEL_API_KEY.`
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

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'User-Agent': CLI_USER_AGENT,
  };
}

export async function fetchManifestPage(opts: FetchManifestOpts): Promise<ManifestResponse> {
  const url = new URL(`${resolveEndpoint(opts.config)}/manifest`);
  for (const inc of opts.config.include) url.searchParams.append('include', inc);
  for (const exc of opts.config.exclude) url.searchParams.append('exclude', exc);
  if (opts.since) url.searchParams.set('since', opts.since);
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
  if (opts.limit) url.searchParams.set('limit', String(opts.limit));

  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    throw new Error(
      `manifest: network error (${(e as Error).message}).\n` +
        `  Fix: check your internet connection and that ${url.host} is reachable.`,
    );
  }
  if (!res.ok) {
    throw new ApiError(res.status, friendly(res.status, await res.text(), 'manifest'));
  }
  return (await res.json()) as ManifestResponse;
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
    cursor = res.nextCursor ?? undefined;
    if (!cursor) return out;
  }
  throw new Error(
    `manifest: pagination exceeded ${MAX_PAGES} pages — possible server cursor loop.\n` +
      `  Fix: re-run with --full, or report at https://github.com/magicpixel/cli/issues.`,
  );
}

/**
 * Download a single asset by key. Returns null on 304 (not modified).
 * Retries transient failures (network errors, 429, 5xx) with backoff.
 */
export async function fetchAssetBytes(
  config: MagicPixelConfig,
  key: string,
  knownSha?: string | null,
): Promise<Uint8Array | null> {
  const url = new URL(resolveEndpoint(config));
  url.searchParams.set('key', key);

  const headers = authHeaders();
  if (knownSha) headers['If-None-Match'] = `"${knownSha}"`;

  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 304) return null;
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ApiError(res.status, friendly(res.status, await res.text(), `download ${key}`));
      } else {
        throw new ApiError(res.status, friendly(res.status, await res.text(), `download ${key}`));
      }
    } catch (e) {
      lastErr = e as Error;
      if (e instanceof ApiError && e.status < 500 && e.status !== 429) throw e;
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr ?? new Error(`download ${key}: unknown error`);
}
