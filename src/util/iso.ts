/**
 * Strict ISO-8601 with required time and timezone (Z or ±HH:MM). Mirrors the
 * edge function's `ISO_8601_RE` so cursor strings round-trip safely.
 *
 * Why strict: the prior `Date.parse`-based check accepted loose inputs like
 * `"2024/06/01"` which sort lexicographically BEFORE any real ISO string and
 * would silently rewind `lastSync`, re-downloading history on the next tick.
 */
export const STRICT_ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isStrictIso8601(value: unknown): value is string {
  return typeof value === 'string' && STRICT_ISO_8601_RE.test(value);
}

/**
 * Return the lexicographically-greatest valid ISO-8601 timestamp from the
 * input list, or null if none parse. ISO-8601 strings sort correctly as
 * strings, so we don't convert to Date (and avoid timezone round-trip drift).
 * Invalid entries are silently dropped.
 */
export function maxIsoTimestamp(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!isStrictIso8601(v)) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}
