import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  assetDiskPath,
  assetDiskPathFromKey,
  listEmptyDirs,
  pruneEmptyDirs,
} from '../src/util/paths.js';
import type { ManifestEntry } from '../src/api.js';

function entry(over: Partial<ManifestEntry> & Pick<ManifestEntry, 'folder' | 'slug'>): ManifestEntry {
  return {
    id: 'x',
    key: `${over.folder ? `${over.folder}/` : ''}${over.slug}`,
    name: over.slug,
    sha256: null,
    width: null,
    height: null,
    updated_at: '2026-01-01T00:00:00Z',
    size_bytes: null,
    download_url: '',
    previous_keys: [],
    ...over,
  };
}

describe('assetDiskPath (nested folders)', () => {
  it('joins multi-segment folder under outDir', () => {
    const p = assetDiskPath('out', entry({ folder: 'ui/cards', slug: 'stone' }), '/tmp');
    expect(p).toBe(resolve('/tmp/out/ui/cards/stone.png'));
  });

  it('handles deeper nesting', () => {
    const p = assetDiskPath('out', entry({ folder: 'a/b/c/d', slug: 'leaf' }), '/tmp');
    expect(p).toBe(resolve('/tmp/out/a/b/c/d/leaf.png'));
  });

  it('falls back to root for null folder', () => {
    const p = assetDiskPath('out', entry({ folder: null, slug: 'loose' }), '/tmp');
    expect(p).toBe(resolve('/tmp/out/loose.png'));
  });
});

describe('assetDiskPathFromKey (nested previous_keys)', () => {
  it('treats every segment except the last as folder', () => {
    expect(assetDiskPathFromKey('out', 'ui/cards/stone/front', '/tmp'))
      .toBe(resolve('/tmp/out/ui/cards/stone/front.png'));
  });

  it('handles legacy 2-segment keys', () => {
    expect(assetDiskPathFromKey('out', 'tiles/grass', '/tmp'))
      .toBe(resolve('/tmp/out/tiles/grass.png'));
  });
});

describe('listEmptyDirs', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'mp-paths-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns [] for a missing root', async () => {
    await expect(listEmptyDirs(resolve(root, 'does-not-exist'))).resolves.toEqual([]);
  });

  it('returns [] for a root with only files', async () => {
    await writeFile(resolve(root, 'a.png'), 'x');
    await expect(listEmptyDirs(root)).resolves.toEqual([]);
  });

  it('reports a single empty subdir', async () => {
    const empty = resolve(root, 'empty');
    await mkdir(empty);
    await expect(listEmptyDirs(root)).resolves.toEqual([empty]);
  });

  it('reports nested empties in post-order (children before parents)', async () => {
    const parent = resolve(root, 'parent');
    const child = resolve(parent, 'child');
    await mkdir(child, { recursive: true });
    const result = await listEmptyDirs(root);
    expect(result).toEqual([child, parent]);
  });

  it('excludes a directory whose subtree contains any file', async () => {
    const keep = resolve(root, 'keep');
    const sub = resolve(keep, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(resolve(sub, 'a.png'), 'x');
    await expect(listEmptyDirs(root)).resolves.toEqual([]);
  });

  it('never includes the root itself', async () => {
    // root is empty — must not appear in the list.
    await expect(listEmptyDirs(root)).resolves.toEqual([]);
  });
});

describe('pruneEmptyDirs', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'mp-prune-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes empty subtrees but never the root', async () => {
    await mkdir(resolve(root, 'a/b/c'), { recursive: true });
    await pruneEmptyDirs(root);
    await expect(listEmptyDirs(root)).resolves.toEqual([]);
    // Root still exists.
    const { existsSync } = await import('node:fs');
    expect(existsSync(root)).toBe(true);
  });

  it('preserves directories that contain files', async () => {
    await mkdir(resolve(root, 'keep/sub'), { recursive: true });
    await writeFile(resolve(root, 'keep/sub/a.png'), 'x');
    await mkdir(resolve(root, 'drop'));
    await pruneEmptyDirs(root);
    const { existsSync } = await import('node:fs');
    expect(existsSync(resolve(root, 'keep/sub/a.png'))).toBe(true);
    expect(existsSync(resolve(root, 'drop'))).toBe(false);
  });

  it('is idempotent', async () => {
    await mkdir(resolve(root, 'a/b'), { recursive: true });
    await pruneEmptyDirs(root);
    await expect(pruneEmptyDirs(root)).resolves.toBeUndefined();
  });
});
