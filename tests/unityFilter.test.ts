import { describe, expect, it } from 'vitest';
import {
  filterUnityManifest,
  isWorkingSetEntry,
  partitionWithheldEntries,
  shouldPruneDeselectedEntry,
  workingSetPullKeys,
} from '../src/util/unityFilter.js';
import { selectFullSyncOrphans } from '../src/util/prunePolicy.js';

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

});

describe('strict working-set isolation', () => {
  it('never pulls a working-set sprite whose rebuilt index says unity: false', () => {
    const saved = { key: 'sprites/bomb/bomb', unity: false as const, asset_id: 'row-1' };
    const r = filterUnityManifest([saved]);
    expect(r.entries).toEqual([]);
    expect(r.noneFlagged).toBe(true);
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
    expect(filterUnityManifest([fallback]).entries).toEqual([]);
  });

  it('does not pull unflagged sibling artboards of a connected document', () => {
    const pull = workingSetPullKeys(
      new Map([['sprites/bomb/bomb', 'Assets/bomb.png']]),
      { 'sprites/bomb/bomb': { assetId: 'row-1' } },
    );
    const sibling = { key: 'sprites/bomb/variant', unity: false as const, asset_id: 'row-1' };
    expect(isWorkingSetEntry(sibling, pull)).toBe(false);
    const r = filterUnityManifest([sibling]);
    expect(r.entries).toEqual([]);
    expect(r.noneFlagged).toBe(true);
  });
});

describe('deselected local cleanup', () => {
  const sourceByKey = new Map([['sprites/tree/variant-1', 'runtime/sprites/tree/variant-1.png']]);

  it('removes a previously downloaded sibling even after it enters the working set', () => {
    expect(shouldPruneDeselectedEntry(
      { key: 'sprites/tree/variant-1', unity: false },
      { sourceByKey, syncedKeys: new Set(['sprites/tree/variant-1']) },
    )).toBe(true);
  });

  it('preserves a game-authored working-set file MagicPixel never downloaded', () => {
    expect(shouldPruneDeselectedEntry(
      { key: 'sprites/tree/variant-1', unity: false },
      { sourceByKey, syncedKeys: new Set() },
    )).toBe(false);
  });

  it('removes an unmarked MagicPixel download outside the working set', () => {
    expect(shouldPruneDeselectedEntry(
      { key: 'sprites/tree/variant-2', unity: false },
      { sourceByKey, syncedKeys: new Set(['sprites/tree/variant-2']) },
    )).toBe(true);
  });

  it('a full reconcile pulls one selected original and prunes 47 tracked variants', () => {
    const original = { key: 'decorations/tree/tree', unity: true as const };
    const variants = Array.from({ length: 47 }, (_, index) => ({
      key: `decorations/tree/variant-${index + 1}`,
      unity: false as const,
    }));
    const filtered = filterUnityManifest([original, ...variants]);
    expect(filtered.entries.map((entry) => entry.key)).toEqual([original.key]);

    const sourceByKey = new Map(
      variants.map((entry) => [entry.key, `runtime/sprites/${entry.key}.png`]),
    );
    const syncedKeys = new Set(variants.map((entry) => entry.key));
    expect(variants.filter((entry) => shouldPruneDeselectedEntry(
      entry,
      { sourceByKey, syncedKeys },
    ))).toHaveLength(47);
  });
});

describe('withheld entries (manual sync release)', () => {
  const withheld = { key: 'library/hut/hut', folder: 'library/hut', unity: true, withheld: true, asset_id: 'row-w' };

  it('partitions withheld entries out of the syncable set', () => {
    const p = partitionWithheldEntries([flagged, withheld]);
    expect(p.entries.map((e) => e.key)).toEqual(['a']);
    expect(p.withheld.map((e) => e.key)).toEqual(['library/hut/hut']);
  });

  it('never pulls a withheld entry, even when flagged', () => {
    expect(filterUnityManifest([withheld]).entries).toEqual([]);
  });

  it('never pulls a withheld entry via the working-set override', () => {
    const pull = workingSetPullKeys(
      new Map([['library/hut/hut', 'Assets/hut.png']]),
      { 'library/hut/hut': { assetId: 'row-w' } },
    );
    expect(isWorkingSetEntry(withheld, pull)).toBe(true);
    const r = filterUnityManifest([withheld]);
    expect(r.entries).toEqual([]);
  });

  it('does not report noneFlagged when the only entry is withheld', () => {
    expect(filterUnityManifest([withheld]).noneFlagged).toBe(false);
  });

  it('keeps a withheld document on disk when its paths are protected', () => {
    const disk = '/game/Assets/Art/library/hut/hut.png';
    const policy = selectFullSyncOrphans({
      localPaths: [disk],
      remoteDiskPaths: new Set<string>(),
      protectedPaths: new Set([disk]),
      isTracked: () => true,
    });
    expect(policy.orphans).toEqual([]);
  });

  it('would prune that same file without the protection (guards the fix)', () => {
    const disk = '/game/Assets/Art/library/hut/hut.png';
    const policy = selectFullSyncOrphans({
      localPaths: [disk],
      remoteDiskPaths: new Set<string>(),
      protectedPaths: new Set<string>(),
      isTracked: () => true,
    });
    expect(policy.orphans).toEqual([disk]);
  });
});
