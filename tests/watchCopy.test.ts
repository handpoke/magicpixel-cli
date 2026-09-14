import { describe, expect, it } from 'vitest';
import { formatSlowTickLine, formatWatchSpriteLine, SLOW_TICK_HEARTBEAT_MS } from '../src/util/watchCopy.js';

describe('formatWatchSpriteLine', () => {
  it('returns null when both counts are empty', () => {
    expect(formatWatchSpriteLine({ workingSet: 0, lastPulled: 0 })).toBeNull();
  });

  it('shows a single count when only a last pull exists', () => {
    expect(formatWatchSpriteLine({ workingSet: 0, lastPulled: 469 })).toBe(
      '   Sprites:  469',
    );
  });

  it('shows the game sprite count when nothing has been pulled yet', () => {
    expect(formatWatchSpriteLine({ workingSet: 2147, lastPulled: 0 })).toBe(
      '   Sprites:  2,147 in your game',
    );
  });

  it('shows both when the working set is larger than the last pull', () => {
    expect(formatWatchSpriteLine({ workingSet: 2147, lastPulled: 469 })).toBe(
      '   Sprites:  2,147 in your game  ·  469 last pulled from MagicPixel',
    );
  });

  it('collapses to one number when they match', () => {
    expect(formatWatchSpriteLine({ workingSet: 469, lastPulled: 469 })).toBe(
      '   Sprites:  469 in your game',
    );
  });
});

describe('formatSlowTickLine', () => {
  it('names what is slow when a status is known', () => {
    expect(formatSlowTickLine(62, 'Fetching your sprites from MagicPixel…')).toBe(
      'Fetching your sprites from MagicPixel — still working (62s)',
    );
  });

  it('keeps a trailing count without a stray ellipsis', () => {
    expect(formatSlowTickLine(70, 'Fetching your sprites from MagicPixel… (1,200)')).toBe(
      'Fetching your sprites from MagicPixel (1,200) — still working (70s)',
    );
  });

  it('falls back to a generic line with no status', () => {
    expect(formatSlowTickLine(60)).toBe('Still working (60s)');
    expect(formatSlowTickLine(60, '   ')).toBe('Still working (60s)');
  });

  it('switches to minutes past two minutes and never shows negatives', () => {
    expect(formatSlowTickLine(180)).toBe('Still working (3m)');
    expect(formatSlowTickLine(-5)).toBe('Still working (0s)');
  });

  it('heartbeat fires no sooner than a minute', () => {
    expect(SLOW_TICK_HEARTBEAT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
