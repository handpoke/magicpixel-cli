/**
 * Validators for `commander` `.option()` parsers, extracted so they can be
 * unit-tested without spawning a subprocess. Keep these pure — they take
 * the raw string commander hands us and either return the parsed value or
 * throw with a user-facing message.
 *
 * We throw a plain `Error` (with `code = 'commander.invalidArgument'`)
 * instead of importing `InvalidArgumentError` from commander. Commander's
 * runtime checks the `code` field, not `instanceof`, so the formatting is
 * identical — and this keeps the validators trivially unit-testable
 * without dragging commander's CJS/ESM interop into the test loader.
 */

class FlagValidationError extends Error {
  // Matches commander's own `InvalidArgumentError` so it gets the same
  // "error: invalid argument for option …" presentation.
  code = 'commander.invalidArgument';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * `sync --watch [seconds]`. Bare `-w` (boolean) is short-circuited by
 * commander before this is invoked; we only see string values here.
 *
 * Floor is 2 because the watch loop polls aggressively (every 2s by
 * default) and faster polling thrashes the manifest endpoint without
 * measurably improving perceived latency. Ceiling 3600 is a sanity bound
 * (1h covers any reasonable "slow background sync" use case; users that
 * want a daily sync should run `magicpixel sync` from cron instead).
 */
export function parseWatchInterval(v: string | true): string | true {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || String(n) !== trimmed || n < 2 || n > 3600) {
    throw new FlagValidationError(`expected an integer 2–3600 (seconds), got "${v}".`);
  }
  return String(n);
}

/** `sync -c <n>` — parallel downloads, 1–16 inclusive. */
export function parseConcurrency(v: string): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || String(n) !== v.trim() || n < 1 || n > 16) {
    throw new FlagValidationError(`expected an integer 1–16, got "${v}".`);
  }
  return n;
}
