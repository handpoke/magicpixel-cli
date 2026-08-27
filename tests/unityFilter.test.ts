import { describe, expect, it } from 'vitest';
import {
  applyUnityPullPolicy,
  filterUnityManifest,
  isWorkingSetEntry,
  workingSetPullKeys,
} from '../src/util/unityFilter.js';

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

describe('applyUnityPullPolicy', () => {
  it('still pulls a connected sprite when the Unity flag is omitted after a save', () => {
    const saved = { key: 'sprites/bomb/bomb', asset_id: 'row-1' };
    const draft = { key: 'drafts/idea/idea' };
    const r = applyUnityPullPolicy([saved, draft], {
      alwaysPull: (e) => e.key === saved.key,
    });
    expect(r.entries.map((e) => e.key)).toEqual(['sprites/bomb/bomb']);
    expect(r.unknown.map((e) => e.key)).toEqual(['drafts/idea/idea']);
    expect(r.noneFlagged).toBe(false);
  });

  it('pulls a working-set sprite whose rebuilt index says unity: false', () => {
    const saved = { key: 'sprites/bomb/bomb', unity: false as const, asset_id: 'row-1' };
    const r = applyUnityPullPolicy([saved], {
      alwaysPull: (e) => e.key === saved.key,
    });
    expect(r.entries).toEqual([saved]);
    expect(r.noneFlagged).toBe(false);
  });

  it('matches via previous_keys or asset_id when the fallback key differs', () => {
    const pull = workingSetPullKeys(
      new Map([['sprites/bomb/mushroom-bomb', 'Assets/bomb.png']]),
      {
        'sprites/bomb/mushroom-bomb': { assetId: 'row-1' },
        'library/draft/draft': { assetId: 'row-draft' },
      },
    );
    expect(pull.keys.has('library/draft/draft')).toBe(false);
    expect(pull.assetIds.has('row-draft')).toBe(false);
    const fallback = {
      key: 'sprites/bomb/bomb',
      previous_keys: ['sprites/bomb/mushroom-bomb'],
      asset_id: 'row-1',
    };
    expect(isWorkingSetEntry(fallback, pull)).toBe(true);
    const r = applyUnityPullPolicy([fallback], {
      alwaysPull: (e) => isWorkingSetEntry(e, pull),
    });
    expect(r.entries).toEqual([fallback]);
  });

  it('does not pull unflagged sibling artboards of a connected document', () => {
    const pull = workingSetPullKeys(
      new Map([['sprites/bomb/bomb', 'Assets/bomb.png']]),
      { 'sprites/bomb/bomb': { assetId: 'row-1' } },
    );
    const sibling = { key: 'sprites/bomb/variant', unity: false as const, asset_id: 'row-1' };
    expect(isWorkingSetEntry(sibling, pull)).toBe(false);
    const r = applyUnityPullPolicy([sibling], {
      alwaysPull: (e) => isWorkingSetEntry(e, pull),
    });
    expect(r.entries).toEqual([]);
    expect(r.noneFlagged).toBe(true);
  });
});
