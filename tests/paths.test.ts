import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { listEmptyDirs, pruneEmptyDirs } from '../src/util/paths.js';

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
