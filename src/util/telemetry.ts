/**
 * Fire-and-forget CLI error reporter. POSTs to the `log-cli-error` edge
 * function so unexpected failures show up on `/admin/errors` alongside
 * browser crashes.
 *
 * Design contract (matches `src/utils/errorReporter.ts` semantics):
 *   - Never throws. Never blocks. 2s hard timeout via AbortController.
 *   - Skipped when no API key, when env opt-out is set, or when the endpoint
 *     is not the canonical magicpixel host (avoids spamming during local
 *     edge-function dev).
 *   - Per-category 5s throttle + per-message 60s LRU dedupe (capacity 50).
 *   - Reports a single `category='cli_error'`; meaningful taxonomy lives in
 *     `context.command`.
 */
import { resolveEndpoint, loadConfig, type MagicPixelConfig } from '../config.js';
import { readCredentialsSync } from './credentials.js';
import { CLI_VERSION, CLI_USER_AGENT } from '../version.js';
import { ApiError } from '../api.js';

export interface CliErrorContext {
  command?: string;
  request_id?: string;
  status?: number;
  stack?: string;
}

const THROTTLE_MS = 5_000;
const DEDUPE_MS = 60_000;
const DEDUPE_LRU_MAX = 50;
const REPORT_TIMEOUT_MS = 2_000;

let lastReportedAt = 0;
const dedupeMap = new Map<string, number>(); // insertion order = LRU order

function dedupeKey(message: string): string {
  return message.slice(0, 80);
}

function isCanonicalEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    // Only report when hitting the production Supabase edge host. Local
    // `supabase functions serve` and forks fall through silently.
    return u.hostname === 'sddsilidjhvtvejzvolx.supabase.co';
  } catch {
    return false;
  }
}

/** Decide whether an error is worth reporting. Pure — exported for tests. */
export function shouldReportCliError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ApiError) {
    // User/config issues have actionable fix hints already; don't add noise.
    return err.status >= 500;
  }
  const msg = err.message ?? '';
  // Commander argument validation — user typed something wrong.
  if (err.name === 'InvalidArgumentError' || err.name === 'CommanderError') return false;
  // Known user-fixable surfaces (config missing, perms, not logged in, key
  // shape) — these come out of `loadConfig`/`getApiKey` with friendly "Fix:"
  // hints; logging them just floods /admin/errors with self-inflicted noise.
  if (/No magicpixel\.json found|No MagicPixel API key found|API key does not look right/.test(msg)) return false;
  if (/\b(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR)\b/.test(msg)) return false;
  return true;
}

/**
 * Resolve API key without touching `getApiKey()` (which throws when missing).
 * Mirrors its precedence: env first, then credentials file.
 */
function readApiKeySilently(): string | null {
  const env = process.env.MAGICPIXEL_API_KEY?.trim();
  if (env) return env;
  const stored = readCredentialsSync();
  return stored?.apiKey ?? null;
}

/**
 * Report an unexpected CLI error. Safe to call from any catch — silently
 * skips when telemetry can't or shouldn't run. Returns a promise only so
 * tests can await; production callers may ignore it.
 */
export async function reportCliError(
  err: Error,
  context: CliErrorContext,
  config?: MagicPixelConfig,
): Promise<void> {
  try {
    if (process.env.MAGICPIXEL_TELEMETRY === '0') return;
    if (!shouldReportCliError(err)) return;

    const apiKey = readApiKeySilently();
    if (!apiKey) return;

    // Decide the report URL:
    //   - No config OR canonical endpoint → POST to canonical log-cli-error.
    //   - Config explicitly points at a non-canonical host → user is on a
    //     fork / proxy / local edge stack; don't silently leak errors back
    //     to magicpixel.art.
    let reportUrl: string;
    if (!config) {
      reportUrl = 'https://sddsilidjhvtvejzvolx.supabase.co/functions/v1/log-cli-error';
    } else {
      const endpoint = resolveEndpoint(config);
      if (!isCanonicalEndpoint(endpoint)) return;
      reportUrl = endpoint.replace(/\/integration-assets\/?$/, '/log-cli-error');
    }

    if (!/\/log-cli-error$/.test(reportUrl)) return;

    const message = err.message ?? String(err);
    const now = Date.now();

    // Per-message dedupe.
    const key = dedupeKey(message);
    const lastSeen = dedupeMap.get(key);
    if (lastSeen !== undefined && now - lastSeen < DEDUPE_MS) {
      dedupeMap.delete(key);
      dedupeMap.set(key, lastSeen);
      return;
    }
    // Per-category throttle (single category, so global).
    if (now - lastReportedAt < THROTTLE_MS) return;
    lastReportedAt = now;

    dedupeMap.set(key, now);
    if (dedupeMap.size > DEDUPE_LRU_MAX) {
      const oldest = dedupeMap.keys().next().value;
      if (oldest !== undefined) dedupeMap.delete(oldest);
    }

    const apiErr = err instanceof ApiError ? err : null;
    const payload = {
      category: 'cli_error',
      message: message.slice(0, 500),
      context: {
        command: context.command,
        cli_version: CLI_VERSION,
        node_version: process.version,
        platform: process.platform,
        request_id: context.request_id ?? apiErr?.requestId,
        status: context.status ?? apiErr?.status,
        stack: (context.stack ?? err.stack)?.slice(0, 2000),
      },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REPORT_TIMEOUT_MS);
    try {
      await fetch(reportUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': CLI_USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never affect the user-visible failure.
  }
}

/**
 * Shared "report this error then exit" helper. Used by:
 *   - `wrap()` in `src/index.ts` (top-level command failure, exit 1)
 *   - the watch-loop give-up branch in `sync.ts` (persistent auth fail, exit 2)
 *
 * Loads config best-effort so the fork-endpoint guard in `reportCliError`
 * can keep non-canonical deployments off the canonical /admin/errors stream.
 * Awaits the report so it flushes before process exit. Never throws —
 * telemetry must not change the user-visible failure mode.
 */
export async function reportAndExit(
  err: Error,
  command: string,
  exitCode: number,
): Promise<never> {
  try {
    const config = await loadConfig().catch(() => undefined);
    await reportCliError(err, { command }, config);
  } catch {
    // never block exit
  }
  process.exit(exitCode);
}

/** Test-only: reset module-singleton state between vitest runs. */
export function __resetTelemetryForTesting(): void {
  lastReportedAt = 0;
  dedupeMap.clear();
}
