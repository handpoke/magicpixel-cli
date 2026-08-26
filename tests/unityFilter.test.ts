import { describe, expect, it } from 'vitest';
import { filterUnityManifest } from '../src/util/unityFilter.js';

const flagged = { key: 'a', unity: true };
const unflagged = { key: 'b', unity: false };
const unknown = { key: 'c' };

describe('filterUnityManifest', () => {
  it('keeps only flagged artboards', () => {
    const r = filterUnityManifest([flagged, unflagged]);
    expect(r.entries.map((e) => e.key)).toEqual(['a']);
    expect(r.noneFlagged).toBe(false);
  });

  it('excludes unknown flags and reports them', () => {
    const r = filterUnityManifest([unknown, flagged]);
    expect(r.entries.map((e) => e.key)).toEqual(['a']);
    expect(r.unknown.map((e) => e.key)).toEqual(['c']);
  });

  it('reports noneFlagged when nothing is opted in', () => {
    const r = filterUnityManifest([unflagged, unknown]);
    expect(r.entries).toEqual([]);
    expect(r.noneFlagged).toBe(true);
  });

  it('does not report noneFlagged on an empty manifest', () => {
    expect(filterUnityManifest([]).noneFlagged).toBe(false);
  });

  it('bypasses filtering with unitySyncAll', () => {
    const r = filterUnityManifest([flagged, unflagged, unknown], { syncAll: true });
    expect(r.entries).toHaveLength(3);
    expect(r.noneFlagged).toBe(false);
    expect(r.unknown).toEqual([]);
  });
});
