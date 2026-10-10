import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findForeignOwner, recordProjectRoot } from '../src/util/projectRoots.js';

function gameFolder(synced: Record<string, { sourceRel?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mp-root-'));
  mkdirSync(join(dir, '.magicpixel'));
  writeFileSync(join(dir, '.magicpixel', 'state.json'), JSON.stringify({ synced }));
  return dir;
}

describe('wrong-folder sync guard', () => {
  it('flags downloads whose sprites are connected in another folder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mp-home-'));
    const core = gameFolder({ 'decorations/cactus/cactus': { sourceRel: 'Runtime/Sprites/cactus.png' } });
    const bundles = gameFolder({});
    await recordProjectRoot('p1', core, home);
    const owner = await findForeignOwner('p1', bundles, ['decorations/cactus/cactus', 'other/x/x'], home);
    expect(owner).toEqual({ root: core, count: 1 });
  });

  it('allows a sync from the folder that owns the sprites', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mp-home-'));
    const core = gameFolder({ 'decorations/cactus/cactus': { sourceRel: 'Runtime/Sprites/cactus.png' } });
    await recordProjectRoot('p1', core, home);
    expect(await findForeignOwner('p1', core, ['decorations/cactus/cactus'], home)).toBeNull();
  });

  it('ignores other projects and plain downloads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mp-home-'));
    const core = gameFolder({ 'a/a/a': { sourceRel: 'A.png' }, 'b/b/b': {} });
    await recordProjectRoot('p1', core, home);
    const here = gameFolder({});
    expect(await findForeignOwner('p2', here, ['a/a/a'], home)).toBeNull();
    expect(await findForeignOwner('p1', here, ['b/b/b'], home)).toBeNull();
  });

  it('treats a missing or damaged state file in the other folder as safe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mp-home-'));
    const broken = gameFolder({});
    writeFileSync(join(broken, '.magicpixel', 'state.json'), '{not json');
    await recordProjectRoot('p1', broken, home);
    await recordProjectRoot('p1', mkdtempSync(join(tmpdir(), 'mp-empty-')), home);
    expect(await findForeignOwner('p1', gameFolder({}), ['a/a/a'], home)).toBeNull();
  });
});
