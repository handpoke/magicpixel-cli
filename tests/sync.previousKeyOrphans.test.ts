import { describe, it, expect } from 'vitest';
import { computePreviousKeyOrphans } from '../src/util/previousKeyOrphans.js';
import type { ManifestEntry } from '../src/api.js';

function entry(over: Partial<ManifestEntry> & Pick<ManifestEntry, 'id' | 'key'>): ManifestEntry {
  return {
    folder: null,
    slug: over.key.split('/').pop() ?? '',
    name: over.key,
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

const resolve = (key: string) => `/out/${key}.png`;

describe('computePreviousKeyOrphans', () => {
  it('returns empty result when no previous_keys present', () => {
    const r = computePreviousKeyOrphans({
      manifest: [entry({ id: 'a', key: 'tiles/grass' })],
      remoteDiskPaths: new Set(['/out/tiles/grass.png']),
      resolveDiskPath: resolve,
      fileExists: () => true,
    });
    expect(r).toEqual({ orphanPaths: [], renames: [] });
  });

  it('adds orphan + rename hint when prior key file exists and is not shadowed', () => {
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'tiles/grass',
          previous_keys: ['untitled-19/untitled-19'],
        }),
      ],
      remoteDiskPaths: new Set(['/out/tiles/grass.png']),
      resolveDiskPath: resolve,
      fileExists: (p) => p === '/out/untitled-19/untitled-19.png',
    });
    expect(r.orphanPaths).toEqual(['/out/untitled-19/untitled-19.png']);
    expect(r.renames).toEqual([
      { id: 'a', oldKey: 'untitled-19/untitled-19', newKey: 'tiles/grass' },
    ]);
  });

  it('skips when prior key is shadowed by another live entry', () => {
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'tiles/grass',
          previous_keys: ['shared/grass'],
        }),
        entry({ id: 'b', key: 'shared/grass' }),
      ],
      remoteDiskPaths: new Set(['/out/tiles/grass.png', '/out/shared/grass.png']),
      resolveDiskPath: resolve,
      fileExists: () => true,
    });
    expect(r.orphanPaths).toEqual([]);
    expect(r.renames).toEqual([]);
  });

  it('skips when prior key file does not exist on disk', () => {
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'tiles/grass',
          previous_keys: ['gone/gone'],
        }),
      ],
      remoteDiskPaths: new Set(['/out/tiles/grass.png']),
      resolveDiskPath: resolve,
      fileExists: () => false,
    });
    expect(r.orphanPaths).toEqual([]);
    expect(r.renames).toEqual([]);
  });

  it('dedupes when the same prev key appears on multiple entries from one row', () => {
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'tiles/grass',
          previous_keys: ['untitled/untitled'],
        }),
        entry({
          id: 'a',
          key: 'tiles/dirt',
          previous_keys: ['untitled/untitled'],
        }),
      ],
      remoteDiskPaths: new Set(),
      resolveDiskPath: resolve,
      fileExists: () => true,
    });
    expect(r.orphanPaths).toEqual(['/out/untitled/untitled.png']);
    expect(r.renames).toHaveLength(1);
    expect(r.renames[0].oldKey).toBe('untitled/untitled');
  });

  it('skips when prev key equals the entry’s own key (slug unchanged)', () => {
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'tiles/grass',
          previous_keys: ['tiles/grass'],
        }),
      ],
      remoteDiskPaths: new Set(),
      resolveDiskPath: resolve,
      fileExists: () => true,
    });
    expect(r.orphanPaths).toEqual([]);
    expect(r.renames).toEqual([]);
  });



  it('handles nested-folder previous keys (folder rename/move case)', () => {
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'ui/tiles/stone/front',
          previous_keys: ['ui/cards/stone/front'],
        }),
      ],
      remoteDiskPaths: new Set(['/out/ui/tiles/stone/front.png']),
      resolveDiskPath: resolve,
      fileExists: (p) => p === '/out/ui/cards/stone/front.png',
    });
    expect(r.orphanPaths).toEqual(['/out/ui/cards/stone/front.png']);
    expect(r.renames).toEqual([
      { id: 'a', oldKey: 'ui/cards/stone/front', newKey: 'ui/tiles/stone/front' },
    ]);
  });

  it('prunes deep ancestor moves (folder moved two levels deep)', () => {
    // Folder `cards` was moved from `ui/` to `game/ui/decks/`; every asset
    // beneath it records its pre-move composite key.
    const r = computePreviousKeyOrphans({
      manifest: [
        entry({
          id: 'a',
          key: 'game/ui/decks/cards/stone/front',
          previous_keys: ['ui/cards/stone/front'],
        }),
      ],
      remoteDiskPaths: new Set(['/out/game/ui/decks/cards/stone/front.png']),
      resolveDiskPath: resolve,
      fileExists: (p) => p === '/out/ui/cards/stone/front.png',
    });
    expect(r.orphanPaths).toEqual(['/out/ui/cards/stone/front.png']);
    expect(r.renames[0].newKey).toBe('game/ui/decks/cards/stone/front');
  });
});

