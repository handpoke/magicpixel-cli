import { describe, expect, it } from 'vitest';
import { formatWatchSpriteLine } from '../src/util/watchCopy.js';

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
