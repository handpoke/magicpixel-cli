import { randomUUID } from 'node:crypto';
import { CLI_USER_AGENT } from '../version.js';

/**
 * Build the standard request-header bundle used by every CLI → API call.
 * Enforces the cross-cutting contract documented in
 * mem://integration/cli-request-id-contract: every request carries a fresh
 * `X-Request-Id` so the edge function can echo it back and support can
 * correlate any failure against the edge function logs in one grep.
 *
 * Single shared helper instead of inlining the same three headers at every
 * call site (`api.ts`, `auth.ts`, `whoami.ts`, `doctor.ts`).
 */
export function authHeaders(
  apiKey: string,
  extra?: Record<string, string>,
): { headers: Record<string, string>; requestId: string } {
  const requestId = randomUUID();
  return {
    requestId,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': CLI_USER_AGENT,
      'X-Request-Id': requestId,
      ...extra,
    },
  };
}
