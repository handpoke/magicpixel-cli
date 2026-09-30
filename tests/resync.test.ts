import { describe, expect, it } from 'vitest';
import { keyInFolder, parseFolderArg } from '../src/commands/resync.js';
import { collectKeptAssetIds } from '../src/commands/push.js';

describe('resync scope', () => {
  it('slugifies the folder argument like library folders', () => {
    expect(parseFolderArg('Sprites/My Enemies/')).toEqual(['sprites', 'my-enemies']);
    expect(parseFolderArg('')).toEqual([]);
  });

  it('matches only keys whose folder part is inside the folder', () => {
    expect(keyInFolder('sprites/enemies/bat/bat', ['sprites', 'enemies'])).toBe(true);
    expect(keyInFolder('sprites/enemies/boss/big/big', ['sprites', 'enemies'])).toBe(true);
    // A document named like the folder, sitting beside it, is out of scope.
    expect(keyInFolder('sprites/enemies/enemies', ['sprites', 'enemies'])).toBe(false);
    expect(keyInFolder('sprites/heroes/hero/hero', ['sprites', 'enemies'])).toBe(false);
  });
});

describe('collectKeptAssetIds', () => {
  const synced = { 'a/doc/x': { assetId: 'id-known', layerIdx: 0, sha256: 's', layers: 1 } };
  it('keeps pushed results and unchanged known files, drops failures', () => {
    const kept = collectKeptAssetIds(
      [{ key: 'a/doc/x' }, { key: 'a/doc/y' }],
      synced as never,
      [
        { key: 'a/doc/y', status: 'created', assetId: 'id-new' },
        { key: 'a/doc/z', status: 'error', assetId: 'id-bad' },
      ],
    );
    expect(kept.sort()).toEqual(['id-known', 'id-new']);
  });
});
