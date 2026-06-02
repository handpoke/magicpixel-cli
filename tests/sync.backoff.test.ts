import { describe, expect, it } from 'vitest';
import { nextBackoffForIdle } from '../src/commands/sync.js';

// Regression guard for the 0.4.0 "ticks vs seconds" fix: thresholds are
// elapsed-seconds, not tick counts. A `--watch 10` user should hit the soft
// (5s) backoff after ~3 minutes of idle, not after 30 minutes.
describe('nextBackoffForIdle', () => {
  it('returns the base interval before the soft threshold', () => {
    expect(nextBackoffForIdle(1, 2)).toBe(2);
    expect(nextBackoffForIdle(89, 2)).toBe(2); // 178s, just under 180s
  });

  it('crosses to 5s at the soft threshold regardless of poll interval', () => {
    // default: --watch 2 → 90 ticks * 2s = 180s
    expect(nextBackoffForIdle(90, 2)).toBe(5);
    // --watch 10 → 18 ticks * 10s = 180s — same elapsed-time UX
    expect(nextBackoffForIdle(18, 10)).toBe(10); // intervalSec floor wins
    expect(nextBackoffForIdle(36, 5)).toBe(5);   // 180s, exactly threshold
  });

  it('crosses to 10s at the hard threshold', () => {
    expect(nextBackoffForIdle(450, 2)).toBe(10);   // 900s
    expect(nextBackoffForIdle(180, 5)).toBe(10);   // 900s
    expect(nextBackoffForIdle(45, 20)).toBe(20);   // intervalSec floor wins
  });

  it('never returns below the configured poll interval', () => {
    expect(nextBackoffForIdle(0, 30)).toBe(30);
    expect(nextBackoffForIdle(1000, 30)).toBe(30);
  });

  it('honors custom thresholds', () => {
    expect(nextBackoffForIdle(5, 2, { softSec: 10, hardSec: 20 })).toBe(5);
    expect(nextBackoffForIdle(15, 2, { softSec: 10, hardSec: 20 })).toBe(10);
  });
});
