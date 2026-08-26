import { describe, expect, it } from 'vitest';
import { applyDiskFingerprints, planPush, pushSlug, gameImportDiskRel, type PushCandidate } from '../src/util/pushPlan.js';

const candidate = (key: string, sha: string): PushCandidate => ({
  key,
  segments: key.split('/'),
  diskSha256: sha,
});

const synced = {
  'characters/hero/idle': { assetId: 'a1', layerIdx: 0, sha256: 'old', layers: 1 },
  'characters/hero/walk': { assetId: 'a1', layerIdx: 1, sha256: 'same', layers: 3 },
};

describe('planPush', () => {
  it('skips unchanged sprites', () => {
    const [a] = planPush([candidate('characters/hero/walk', 'same')], synced);
    expect(a.kind).toBe('skip');
  });

  it('skips connected originals when the game file is unchanged but the cloud composite sha differs', () => {
    const connected = {
      'sprites/hero/hero': {
        assetId: 'a1',
        layerIdx: 0,
        sha256: 'cloud-composite',
        diskSha256: 'original',
        layers: 1,
        sourceRel: 'Runtime/Sprites/hero.png',
      },
    };
    const [a] = planPush([candidate('sprites/hero/hero', 'original')], connected);
    expect(a).toEqual({ kind: 'skip', key: 'sprites/hero/hero', reason: 'unchanged' });
  });

  it('does not re-upload connected originals when state only has a cloud composite sha', () => {
    const connected = {
      'sprites/hero/hero': {
        assetId: 'a1',
        layerIdx: 0,
        sha256: 'cloud-composite',
        layers: 1,
        sourceRel: 'Runtime/Sprites/hero.png',
      },
    };
    const [a] = planPush([candidate('sprites/hero/hero', 'original')], connected);
    expect(a).toEqual({ kind: 'skip', key: 'sprites/hero/hero', reason: 'unchanged' });
  });

  it('skips connected originals even when sourceRel was never persisted', () => {
    const connected = {
      'sprites/hero/hero': { assetId: 'a1', layerIdx: 0, sha256: 'cloud-composite', layers: 1 },
    };
    const [a] = planPush([candidate('sprites/hero/hero', 'original')], connected, {
      folderTreeKeys: new Set(['sprites/hero/hero']),
    });
    expect(a).toEqual({ kind: 'skip', key: 'sprites/hero/hero', reason: 'unchanged' });
  });

  it('still updates an outDir edit when sourceRel is absent', () => {
    const [a] = planPush([candidate('characters/hero/idle', 'new')], synced);
    expect(a.kind).toBe('update');
  });

  it('resolves a connected sprite whose state is keyed by a cloud slug', () => {
    const connected = {
      'sprites/hero-2/hero-2': {
        assetId: 'a1',
        layerIdx: 0,
        sha256: 'cloud-composite',
        diskSha256: 'original',
        layers: 1,
        sourceRel: 'Runtime/Sprites/hero.png',
      },
    };
    const [a] = planPush(
      [{ key: 'sprites/hero/hero', segments: ['Sprites', 'hero'], diskSha256: 'original', sourceRel: 'Runtime/Sprites/hero.png' }],
      connected,
    );
    expect(a).toEqual({ kind: 'skip', key: 'sprites/hero/hero', reason: 'unchanged' });
  });

  it('pushes when a connected original changed after a disk baseline was recorded', () => {
    const connected = {
      'sprites/hero/hero': {
        assetId: 'a1',
        layerIdx: 0,
        sha256: 'cloud-composite',
        diskSha256: 'original',
        layers: 1,
        sourceRel: 'Runtime/Sprites/hero.png',
      },
    };
    const [a] = planPush([candidate('sprites/hero/hero', 'edited')], connected);
    expect(a).toEqual({
      kind: 'update',
      key: 'sprites/hero/hero',
      assetId: 'a1',
      layerIdx: 0,
      baseSha256: 'cloud-composite',
    });
  });

  it('updates a changed sprite with the last-pulled sha as baseline', () => {
    const [a] = planPush([candidate('characters/hero/idle', 'new')], synced);
    expect(a).toEqual({
      kind: 'update',
      key: 'characters/hero/idle',
      assetId: 'a1',
      layerIdx: 0,
      baseSha256: 'old',
    });
  });

  it('refuses to flatten a multi-layer artboard unless asked', () => {
    const [a] = planPush([candidate('characters/hero/walk', 'changed')], synced);
    expect(a).toEqual({ kind: 'needs-flatten', key: 'characters/hero/walk', layers: 3 });
    const [b] = planPush([candidate('characters/hero/walk', 'changed')], synced, { flatten: true });
    expect(b.kind).toBe('update');
  });

  it('adopts unknown disk sprites with slugified path + display names', () => {
    const [a] = planPush([{ key: 'My Props/Big Rock', segments: ['My Props', 'Big Rock'], diskSha256: 's' }], synced);
    expect(a).toEqual({
      kind: 'adopt',
      key: 'My Props/Big Rock',
      path: ['my-props', 'big-rock'],
      pathNames: ['My Props', 'Big Rock'],
      name: 'Big Rock',
    });
  });

  it('adopts a root-level PNG as a single-artboard document', () => {
    const [a] = planPush([candidate('loose', 's')], {});
    expect(a).toEqual({
      kind: 'adopt',
      key: 'loose',
      path: ['loose', 'loose'],
      pathNames: ['loose', 'loose'],
      name: 'loose',
    });
  });

  it('adopts Unity-mirrored PNGs as Connected folders, not root documents', () => {
    const [a] = planPush(
      [{ key: 'Sprites/hero', segments: ['Sprites', 'hero'], diskSha256: 's' }],
      {},
      { folderTreeKeys: new Set(['Sprites/hero']) },
    );
    expect(a).toEqual({
      kind: 'adopt',
      key: 'Sprites/hero',
      path: ['sprites', 'hero', 'hero'],
      pathNames: ['Sprites', 'hero', 'hero'],
      name: 'hero',
    });
  });

  it('wraps a scan-root Unity PNG under Game so it still lands in Connected', () => {
    const [a] = planPush(
      [candidate('loose', 's')],
      {},
      { folderTreeKeys: new Set(['loose']) },
    );
    expect(a).toEqual({
      kind: 'adopt',
      key: 'loose',
      path: ['game', 'loose', 'loose'],
      pathNames: ['Game', 'loose', 'loose'],
      name: 'loose',
    });
  });

  it('writes Unity imports to the same relative path the manifest will emit', () => {
    expect(gameImportDiskRel(['Sprites', 'hero'])).toBe('sprites/hero/hero.png');
    expect(gameImportDiskRel(['hero'])).toBe('game/hero/hero.png');
  });

  it('caps adopt paths at the server segment limit', () => {
    const segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const [a] = planPush([{ key: segments.join('/'), segments, diskSha256: 's' }], {});
    expect(a.kind).toBe('adopt');
    if (a.kind === 'adopt') expect(a.path).toEqual(['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('slugifies to the server-accepted shape', () => {
    expect(pushSlug('Hero_Idle 01!')).toBe('hero-idle-01');
  });
});

describe('planPush — legacy rows', () => {
  const legacySynced = {
    'props/rocks': { assetId: 'legacy1', layerIdx: 0, sha256: 'old', legacy: true },
  };

  it('skips a changed legacy sprite instead of adopting a duplicate', () => {
    const [a] = planPush([candidate('props/rocks', 'new')], legacySynced);
    expect(a).toEqual({ kind: 'skip', key: 'props/rocks', reason: 'legacy' });
  });

  it('still reports unchanged legacy sprites as unchanged', () => {
    const [a] = planPush([candidate('props/rocks', 'old')], legacySynced);
    expect(a).toEqual({ kind: 'skip', key: 'props/rocks', reason: 'unchanged' });
  });

  it('tags unusable adopt paths with a distinct reason', () => {
    const [a] = planPush([{ key: '!!!', segments: ['!!!'], diskSha256: 's' }], {});
    expect(a).toEqual({ kind: 'skip', key: '!!!', reason: 'unusable-path' });
  });
});

describe('applyDiskFingerprints', () => {
  it('records disk sha256 onto existing synced rows', () => {
    const synced = {
      'sprites/hero/hero': {
        assetId: 'a1',
        layerIdx: 0,
        sha256: 'cloud-composite',
        layers: 1,
        sourceRel: 'Runtime/Sprites/hero.png',
      },
    };
    const { next, changed } = applyDiskFingerprints(synced, [
      { key: 'sprites/hero/hero', diskSha256: 'original' },
    ]);
    expect(changed).toBe(true);
    expect(next['sprites/hero/hero'].diskSha256).toBe('original');
    expect(next['sprites/hero/hero'].sha256).toBe('cloud-composite');
    expect(synced['sprites/hero/hero'].diskSha256).toBeUndefined();
  });

  it('is a no-op when fingerprints already match', () => {
    const synced = {
      'sprites/hero/hero': { assetId: 'a1', layerIdx: 0, sha256: 'c', diskSha256: 'original' },
    };
    const { next, changed } = applyDiskFingerprints(synced, [
      { key: 'sprites/hero/hero', diskSha256: 'original' },
    ]);
    expect(changed).toBe(false);
    expect(next).toBe(synced);
  });

  it('writes the fingerprint onto the cloud-keyed row when the candidate uses the index key', () => {
    const synced = {
      'sprites/hero-2/hero-2': {
        assetId: 'a1',
        layerIdx: 0,
        sha256: 'c',
        sourceRel: 'Runtime/Sprites/hero.png',
      },
    };
    const { next, changed } = applyDiskFingerprints(synced, [
      { key: 'sprites/hero/hero', sourceRel: 'Runtime/Sprites/hero.png', diskSha256: 'original', diskMtimeMs: 1, diskSize: 2 },
    ]);
    expect(changed).toBe(true);
    expect(next['sprites/hero-2/hero-2'].diskSha256).toBe('original');
    expect(next['sprites/hero-2/hero-2'].diskMtimeMs).toBe(1);
    expect(next['sprites/hero/hero']).toBeUndefined();
  });
});
