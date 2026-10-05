import { describe, expect, it } from 'vitest';
import { fitStatusLine, formatSlowTickLine, formatWatchSpriteLine, SLOW_TICK_HEARTBEAT_MS } from '../src/util/watchCopy.js';

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

describe('fitStatusLine', () => {
  const line = '[12:25:14] Looking through your game sprites…  3,114 sprites · 414 folders  ·  Runtime/Sprites';

  it('clips a long status to one row so the next status overwrites it', () => {
    const out = fitStatusLine(line, 60);
    expect(Array.from(out)).toHaveLength(59);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('[12:25:14] Looking through')).toBe(true);
  });

  it('leaves a short status alone', () => {
    expect(fitStatusLine('[12:25:14] Waiting for edits… (228 up to date)', 80)).toBe(
      '[12:25:14] Waiting for edits… (228 up to date)',
    );
  });

  it('leaves the line alone when there is no terminal width', () => {
    expect(fitStatusLine(line, undefined)).toBe(line);
  });
});
