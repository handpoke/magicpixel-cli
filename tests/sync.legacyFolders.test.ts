import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLegacySuffixFolders } from '../src/commands/sync.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-legacy-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}
function file(rel: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
}

describe('findLegacySuffixFolders', () => {
  it('returns [] when no known slugs are passed', async () => {
    dir('cards-2');
    const r = await findLegacySuffixFolders(root, new Set(), root);
    expect(r).toEqual([]);
  });

  it('returns [] when outDir does not exist', async () => {
    const r = await findLegacySuffixFolders('nope-does-not-exist', new Set(['cards']), root);
    expect(r).toEqual([]);
  });

  it('detects <slug>-<n> when base slug is known and full name is not', async () => {
    dir('cards');
    dir('cards-2');
    const r = await findLegacySuffixFolders(root, new Set(['cards']), root);
    expect(r).toHaveLength(1);
    expect(r[0].legacyName).toBe('cards-2');
    expect(r[0].currentSlug).toBe('cards');
  });

  it('does NOT delete a sibling slug that is itself known (incremental-mode safety)', async () => {
    // Scenario: user legitimately has both `tiles/` and `tiles-2/`. An
    // incremental tick where only `tiles` changed must NOT sweep `tiles-2/`.
    dir('tiles');
    dir('tiles-2');
    // `knownFolderSlugs` is the union of manifest + previousAssets, so both
    // slugs are present even if the tick's manifest only had `tiles`.
    const r = await findLegacySuffixFolders(root, new Set(['tiles', 'tiles-2']), root);
    expect(r).toEqual([]);
  });

  it('ignores folders without a -<digits> suffix', async () => {
    dir('cards');
    dir('cards-foo');
    dir('cards-v2beta');
    const r = await findLegacySuffixFolders(root, new Set(['cards']), root);
    expect(r).toEqual([]);
  });

  it('ignores dotfile folders', async () => {
    dir('.cards-2');
    const r = await findLegacySuffixFolders(root, new Set(['cards']), root);
    expect(r).toEqual([]);
  });

  it('only scans the top level (nested matches are user content)', async () => {
    dir('chars', 'heroes-2');
    const r = await findLegacySuffixFolders(root, new Set(['chars', 'heroes']), root);
    expect(r).toEqual([]);
  });

  it('skips files even when named like a legacy folder', async () => {
    file('cards-2');
    const r = await findLegacySuffixFolders(root, new Set(['cards']), root);
    expect(r).toEqual([]);
  });

  it('does not match when base slug is unknown', async () => {
    dir('unrelated-2');
    const r = await findLegacySuffixFolders(root, new Set(['cards']), root);
    expect(r).toEqual([]);
  });
});
