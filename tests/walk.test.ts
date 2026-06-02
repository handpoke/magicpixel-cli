import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { walkOutDirPngs } from '../src/util/paths.js';

/**
 * walkOutDirPngs is the single canonical disk walker shared by sync's orphan
 * scan and the typed-index emitter. The contract is:
 *   - returns one DiskAsset per `*.png` under outDir
 *   - skips dot-prefixed subdirectories
 *   - skips symlinks (both file and directory) — defense against an attacker
 *     dropping a symlink into outDir to read files outside it
 *   - returns [] for a missing outDir
 */
describe('walkOutDirPngs', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'mp-walk-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns [] when outDir does not exist yet', async () => {
    const got = await walkOutDirPngs('does/not/exist', cwd);
    expect(got).toEqual([]);
  });

  it('enumerates PNGs at root and nested folders with the right key shape', async () => {
    const root = join(cwd, 'assets');
    await mkdir(join(root, 'items'), { recursive: true });
    await writeFile(join(root, 'standalone.png'), 'x');
    await writeFile(join(root, 'items', 'tree.png'), 'x');
    await writeFile(join(root, 'items', 'rock.png'), 'x');
    await writeFile(join(root, 'README.md'), 'ignored');  // non-png

    const got = await walkOutDirPngs('assets', cwd);
    const keys = got.map((e) => e.key).sort();
    expect(keys).toEqual(['items/rock', 'items/tree', 'standalone']);

    const standalone = got.find((e) => e.key === 'standalone')!;
    expect(standalone.folder).toBeNull();
    expect(standalone.slug).toBe('standalone');

    const tree = got.find((e) => e.key === 'items/tree')!;
    expect(tree.folder).toBe('items');
    expect(tree.slug).toBe('tree');
  });

  it('skips dot-prefixed subdirectories', async () => {
    const root = join(cwd, 'assets');
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeFile(join(root, '.cache', 'secret.png'), 'x');
    await writeFile(join(root, 'real.png'), 'x');

    const got = await walkOutDirPngs('assets', cwd);
    expect(got.map((e) => e.key)).toEqual(['real']);
  });

  it('skips symlinked files and directories', async () => {
    const root = join(cwd, 'assets');
    await mkdir(root, { recursive: true });
    const outside = join(cwd, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'leaked.png'), 'x');

    try {
      await symlink(outside, join(root, 'linkdir'));
      await symlink(join(outside, 'leaked.png'), join(root, 'leaked.png'));
    } catch {
      // Filesystem may not support symlinks (Windows w/o privileges) — skip silently.
      return;
    }

    await writeFile(join(root, 'real.png'), 'x');
    const got = await walkOutDirPngs('assets', cwd);
    expect(got.map((e) => e.key)).toEqual(['real']);
  });
});
