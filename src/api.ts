import { resolveEndpoint, getApiKey, CLI_VERSION, type MagicPixelConfig } from './config.js';
import {
  etagForSha256,
  MAX_ASSET_BYTES,
  readBodyWithLimit,
  safeFetch,
  validateEndpointUrl,
} from './util/security.js';
import { authHeaders } from './util/authHeaders.js';
import { cmd } from './util/invoke.js';

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
  /** Composite keys this row was previously emitted under. The CLI uses these
   *  to delete stale PNGs left behind after a doc/artboard rename. Optional
   *  for backward compatibility with older edge-function deploys. */
  previous_keys?: string[];
  /** Per-artboard "Sync to Unity" opt-in. Absent on older edge deploys —
   *  callers must treat `undefined` as "unknown", not "off". */
  unity?: boolean;
  /** Row id + artboard index — the address `push` writes a disk edit back to. */
  asset_id?: string;
  layer_idx?: number;
  /** Layer count of the artboard. Absent on stale caches. */
  layer_count?: number;
}


export interface ManifestProjectInfo {
  /** UUID of the project the API key is scoped to. */
  id: string;
  /** Display name at the time of the request (may be null if lookup failed). */
  name: string | null;
  /** Populated only on empty fresh-sync responses: total assets in this project. */
  totalInProject?: number;
  /** Populated only on empty fresh-sync responses when totalInProject === 0. */
  hint?: string;
}

export interface ManifestResponse {
  items: ManifestEntry[];
  nextCursor: string | null;
  count: number;
  project?: ManifestProjectInfo;
}

interface FetchManifestOpts {
  config: MagicPixelConfig;
  since?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Last-seen project metadata from any manifest response this process made.
 * Populated as a side-effect of `fetchManifestPage`; read by `whoami`,
 * `status`, and `sync` to surface `project: <name>` diagnostics.
 *
 * Never null after the first successful manifest call. Module-level so the
 * three commands don't have to thread it through every helper.
 */
let lastProjectInfo: ManifestProjectInfo | null = null;
export function getLastProjectInfo(): ManifestProjectInfo | null {
  return lastProjectInfo;
}
export function __resetLastProjectInfoForTesting(): void {
  lastProjectInfo = null;
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
      `  Fix: regenerate at https://magicpixel.art/settings and re-run \`${cmd('login')}\`.`
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
  if (status === 546) {
    // Supabase Edge Runtime platform code — worker boot / CPU / wall-time.
    // Not one of ours; typically clears in seconds.
    return `${context}: 546 — MagicPixel edge worker restarting. Retried automatically; if this persists, retry in ~30s.`;
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

  // Reuse the same transient-failure policy as asset downloads, with extra
  // 546 attempts so first-run can ride out a worker recycle without stalling
  // every PNG download for ~30s.
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
      // Capture the bound project's name/id from response headers (always
      // present on 2xx). The body may also carry a richer `project` payload
      // (empty fresh-sync case, includes totalInProject + hint). Prefer the
      // body when present so `whoami`/`sync` can print the "0 assets in this
      // project" nudge without another round-trip.
      const projectId = res.headers.get('x-magicpixel-project-id');
      const projectName = res.headers.get('x-magicpixel-project-name');
      const bodyProject = (data as Partial<ManifestResponse>).project;
      if (bodyProject && typeof bodyProject === 'object' && typeof bodyProject.id === 'string') {
        lastProjectInfo = {
          id: bodyProject.id,
          name: typeof bodyProject.name === 'string' ? bodyProject.name : (projectName ?? null),
          totalInProject: typeof (bodyProject as ManifestProjectInfo).totalInProject === 'number'
            ? (bodyProject as ManifestProjectInfo).totalInProject
            : undefined,
          hint: typeof (bodyProject as ManifestProjectInfo).hint === 'string'
            ? (bodyProject as ManifestProjectInfo).hint
            : undefined,
        };
      } else if (projectId) {
        lastProjectInfo = { id: projectId, name: projectName };
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
  }, { max546Attempts: 7 });
}

type RetrySleep = (ms: number) => Promise<void>;
export interface RetryOpts {
  sleep?: RetrySleep;
  /** 546-only attempt cap. Defaults to the same 5 as other 5xx so PNG
   *  downloads don't stall ~30s each during a recycle. Manifest fetches
   *  pass 7 so first-run can ride out a worker boot. */
  max546Attempts?: number;
}

const defaultRetrySleep: RetrySleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with exponential backoff on network errors, 429, and 5xx.
 * Non-retryable ApiErrors (4xx other than 429) bubble immediately.
 *
 * - `ApiError.retryAfterMs` (populated from a `Retry-After` header on 429/5xx)
 *   wins over the default exponential backoff for the *next* attempt.
 * - Network/transport failures are wrapped once with a friendly hint and the
 *   request-id of the most recent attempt.
 *
 * The 3rd argument may be a sleep function (tests) or an options bag.
 */
export async function retryTransient<T>(
  context: string,
  fn: () => Promise<T>,
  opts: RetrySleep | RetryOpts = {},
): Promise<T> {
  const sleep = (typeof opts === 'function' ? opts : opts.sleep) ?? defaultRetrySleep;
  const maxAttempts = 5;
  const max546Attempts =
    typeof opts === 'function' ? maxAttempts : (opts.max546Attempts ?? maxAttempts);
  let lastErr: Error | null = null;
  let nextDelayMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error;
      if (err instanceof ApiError) {
        if (err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
        nextDelayMs = err.retryAfterMs ?? 0;
      } else {
        lastErr = new Error(
          `${context}: network error (${err.message}).\n` +
            `  Fix: check your internet connection and that the MagicPixel API is reachable.`,
          { cause: err },
        );
        nextDelayMs = 0;
      }
      const allowed =
        lastErr instanceof ApiError && lastErr.status === 546 ? max546Attempts : maxAttempts;
      if (attempt >= allowed) break;
      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 16_000);
      await sleep(Math.max(nextDelayMs, backoffMs));
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

// ---------- disk → cloud ingest (two-way Unity sync) ------------------------

/** Sprite payload for `POST /api/public/integration/ingest`. */
export interface PushSprite {
  key: string;
  pngBase64: string;
  diskSha256: string;
  /** UPDATE form: write back into a known artboard. */
  assetId?: string;
  layerIdx?: number;
  baseSha256?: string | null;
  flatten?: boolean;
  /** ADOPT form: [...libraryFolders, docSlug, artboardSlug]. */
  path?: string[];
  pathNames?: string[];
  name?: string;
}

export type PushStatus = 'created' | 'updated' | 'unchanged' | 'conflict' | 'error';

export interface PushResult {
  key: string;
  status: PushStatus;
  reason?: string;
  message?: string;
  assetId?: string;
  layerIdx?: number;
  /** Composite sha the cloud now reports — store it as the next baseline. */
  sha256?: string;
  /** Adopt only: the key the manifest will use. Differs from the disk key when
   *  the server's slug/collision handling renamed the document. */
  cloudKey?: string;

}

/** CLI send size. The server allows 20; smaller batches survive Worker 502s. */
export const PUSH_BATCH_SIZE = 8;

const DEFAULT_INGEST_ENDPOINT = 'https://magicpixel.art/api/public/integration/ingest';

export function resolveIngestEndpoint(): string {
  const override = process.env.MAGICPIXEL_INGEST_ENDPOINT?.trim();
  return override ? validateEndpointUrl(override) : DEFAULT_INGEST_ENDPOINT;
}

/** Post one batch of sprites. Shares the transient-retry policy with pulls. */
export async function pushSprites(
  sprites: PushSprite[],
  retryOpts?: RetryOpts,
): Promise<PushResult[]> {
  const url = resolveIngestEndpoint();
  return retryTransient('push', async () => {
    const { headers, requestId } = buildHeaders({ 'Content-Type': 'application/json' });
    const res = await safeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sprites }),
    });
    const serverRequestId = res.headers.get('x-request-id') ?? requestId;
    if (res.ok) {
      const data = (await res.json()) as { results?: unknown } | null;
      const results = data && typeof data === 'object' ? (data as { results?: unknown }).results : undefined;
      if (!Array.isArray(results)) {
        throw new ApiError(
          502,
          withRequestId('push: unexpected server response shape (results missing).', serverRequestId),
          serverRequestId,
        );
      }
      return results as PushResult[];
    }
    const bodyText = await res.text();
    throw new ApiError(
      res.status,
      withRequestId(friendly(res.status, bodyText, 'push'), serverRequestId),
      serverRequestId,
      retryAfterMsFromResponse(res),
    );
  }, retryOpts);
}

function isTransientPushError(e: unknown): boolean {
  return e instanceof ApiError && (e.status >= 500 || e.status === 429);
}

/**
 * Push a batch, splitting in half on persistent 502/5xx so one fat request
 * cannot abort the rest of a connect/sync.
 */
export async function pushSpritesAdaptive(
  sprites: PushSprite[],
  retryOpts?: RetryOpts,
): Promise<PushResult[]> {
  if (sprites.length === 0) return [];
  try {
    return await pushSprites(sprites, retryOpts);
  } catch (e) {
    if (!isTransientPushError(e)) throw e;
    if (sprites.length === 1) {
      return [{ key: sprites[0].key, status: 'error', message: (e as Error).message }];
    }
    const mid = Math.ceil(sprites.length / 2);
    const left = await pushSpritesAdaptive(sprites.slice(0, mid), retryOpts);
    try {
      const right = await pushSpritesAdaptive(sprites.slice(mid), retryOpts);
      return [...left, ...right];
    } catch (rightErr) {
      // Left half already landed — don't drop those results when the rest fails.
      const right = sprites.slice(mid).map((s) => ({
        key: s.key,
        status: 'error' as const,
        message: (rightErr as Error).message,
      }));
      return [...left, ...right];
    }
  }
}
