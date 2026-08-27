import { describe, expect, it } from 'vitest';
import {
  IDLE_BACKOFF_THRESHOLDS,
  needsLocalPngWalk,
  nextBackoffForIdle,
  pushWasActive,
} from '../src/commands/sync.js';

// Regression guard for the 0.4.0 "ticks vs seconds" fix: thresholds are
// elapsed-seconds, not tick counts. A `--watch 10` user should hit the soft
// (5s) backoff after the same wall-clock idle time as a `--watch 2` user.
// Callers now pass wall-clock elapsed seconds directly — ticks × intervalSec
// undercounted once the watcher had already stepped down to 5s/10s ticks.
describe('nextBackoffForIdle', () => {
  it('uses the hot-window thresholds by default', () => {
    expect(IDLE_BACKOFF_THRESHOLDS).toEqual({ softSec: 60, hardSec: 300 });
  });

  it('returns the base interval before the soft threshold', () => {
    expect(nextBackoffForIdle(2, 2)).toBe(2);
    expect(nextBackoffForIdle(58, 2)).toBe(2); // just under 60s
  });

  it('crosses to 5s at the soft threshold regardless of poll interval', () => {
    expect(nextBackoffForIdle(60, 2)).toBe(5); // exactly the threshold
    expect(nextBackoffForIdle(120, 5)).toBe(5);
    expect(nextBackoffForIdle(60, 10)).toBe(10); // intervalSec floor wins
  });

  it('crosses to 10s at the hard threshold', () => {
    expect(nextBackoffForIdle(300, 2)).toBe(10);
    expect(nextBackoffForIdle(600, 5)).toBe(10);
    expect(nextBackoffForIdle(300, 20)).toBe(20); // intervalSec floor wins
  });

  it('never returns below the configured poll interval', () => {
    expect(nextBackoffForIdle(0, 30)).toBe(30);
    expect(nextBackoffForIdle(10_000, 30)).toBe(30);
  });

  it('honors custom thresholds', () => {
    expect(nextBackoffForIdle(10, 2, { softSec: 10, hardSec: 20 })).toBe(5);
    expect(nextBackoffForIdle(20, 2, { softSec: 10, hardSec: 20 })).toBe(10);
  });
});

// A watcher whose user only edits inside their engine pushes bytes up but pulls
// nothing down. Those runs must count as activity, otherwise the poll slides to
// the 10s idle interval while the user is actively saving files.
describe('pushWasActive', () => {
  const idle = { created: 0, updated: 0, unchanged: 7, conflict: 0, error: 0, imported: 0 };

  it('is false when push did not run or moved nothing', () => {
    expect(pushWasActive(null)).toBe(false);
    expect(pushWasActive(undefined)).toBe(false);
    expect(pushWasActive(idle)).toBe(false);
  });

  it('ignores conflicts and errors — they are not successful writes', () => {
    expect(pushWasActive({ ...idle, conflict: 2, error: 1 })).toBe(false);
  });

  it('is true for created, updated or imported sprites', () => {
    expect(pushWasActive({ ...idle, created: 1 })).toBe(true);
    expect(pushWasActive({ ...idle, updated: 1 })).toBe(true);
    expect(pushWasActive({ ...idle, imported: 1 })).toBe(true);
  });
});

// The idle incremental tick must not walk the output tree; a full sync always
// must (skipping there would silently disable pruning).
describe('needsLocalPngWalk', () => {
  it('always walks on a full sync', () => {
    expect(needsLocalPngWalk(undefined, 0)).toBe(true);
    expect(needsLocalPngWalk(undefined, 5)).toBe(true);
  });

  it('skips the walk on an idle incremental tick', () => {
    expect(needsLocalPngWalk('2026-08-27T00:00:00Z', 0)).toBe(false);
  });

  it('walks incrementally when something is download-bound (rename fallback)', () => {
    expect(needsLocalPngWalk('2026-08-27T00:00:00Z', 1)).toBe(true);
  });
});
