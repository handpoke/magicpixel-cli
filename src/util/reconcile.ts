/**
 * When to promote an incremental sync to a full reconcile.
 *
 * `removed_keys` can only describe rows that still exist (trashed /
 * componentized). A permanent delete ("Empty Trash") leaves nothing to report,
 * so an incremental client keeps the PNG in the game project indefinitely. A
 * periodic full pass — the manifest itself is the truth there — closes that
 * without tombstone tables or per-tick cost.
 */

/** 15 minutes: bounded orphan lifetime, ~4 full manifests/hour worst case. */
export const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

export function shouldReconcile(
  lastReconcile: string | undefined,
  nowMs: number,
  intervalMs: number = RECONCILE_INTERVAL_MS,
): boolean {
  if (!lastReconcile) return true;
  const then = Date.parse(lastReconcile);
  if (!Number.isFinite(then)) return true;
  // Clock moved backwards (machine sleep / NTP step): reconcile rather than
  // waiting out a bogus future timestamp.
  if (then > nowMs) return true;
  return nowMs - then >= intervalMs;
}
