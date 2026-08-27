/**
 * Watch-mode header copy. `state.assets` is only the last *successful* pull,
 * so a connected working set of 2k sprites used to show as "Sprites: 469"
 * while catch-up was still pending. Show both numbers when they differ.
 */

export interface WatchSpriteCounts {
  /** PNGs matching `connect` globs (or 0 when none / scan skipped). */
  workingSet: number;
  /** Keys in `state.assets` — last completed pull from MagicPixel. */
  lastPulled: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** One header line, or null when we have nothing useful to print. */
export function formatWatchSpriteLine(c: WatchSpriteCounts): string | null {
  const set = c.workingSet > 0 ? c.workingSet : 0;
  const pulled = c.lastPulled > 0 ? c.lastPulled : 0;
  if (set === 0 && pulled === 0) return null;
  if (set > 0 && pulled > 0 && set !== pulled) {
    return `   Sprites:  ${fmt(set)} in your game  ·  ${fmt(pulled)} last pulled from MagicPixel`;
  }
  if (set > 0) return `   Sprites:  ${fmt(set)} in your working set`;
  return `   Sprites:  ${fmt(pulled)}`;
}
