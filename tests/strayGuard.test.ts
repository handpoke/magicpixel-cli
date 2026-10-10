import { describe, expect, it } from 'vitest';
import { libraryFolderOf, splitStrayDownloads } from '../src/util/strayGuard.js';

const deco = (slug: string, game = true) => ({
  key: `runtime/sprites/entities/decorations/${slug}/${slug}`,
  game,
});

describe('stray-copy guard', () => {
  it('skips game sprites with no home in this folder, even with no registry', () => {
    const { keep, foreign } = splitStrayDownloads([deco('cactus-forest'), deco('tree-dead')], []);
    expect(keep).toEqual([]);
    expect(foreign.map((e) => e.key)).toHaveLength(2);
  });

  it('keeps a game sprite whose game file is in this folder', () => {
    const e = deco('cactus-forest');
    expect(splitStrayDownloads([e], [e.key]).keep).toEqual([e]);
  });

  it('keeps a new game sprite saved beside siblings this folder owns', () => {
    const r = splitStrayDownloads([deco('statue-rabbit-gold')], [deco('statue-rabbit').key]);
    expect(r.keep).toHaveLength(1);
    expect(r.foreign).toHaveLength(0);
  });

  it('still downloads art made only in MagicPixel', () => {
    const native = { key: 'untitled-2/wood' };
    expect(splitStrayDownloads([native, deco('x', false)], []).keep).toHaveLength(2);
  });

  it('derives the library folder from a key', () => {
    expect(libraryFolderOf('a/b/doc/art')).toBe('a/b');
    expect(libraryFolderOf('doc/art')).toBe('');
  });
});
