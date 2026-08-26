import { describe, expect, it } from 'vitest';
import { planPush, pushSlug, type PushCandidate } from '../src/util/pushPlan.js';

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
