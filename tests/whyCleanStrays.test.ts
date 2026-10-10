import { describe, expect, it } from 'vitest';
import { explainSprite } from '../src/commands/why.js';
import { findStrayCopies } from '../src/commands/cleanStrays.js';
import { fitStatusLine } from '../src/commands/sync.js';

const rabbit = {
  abs: '/g/.SpineRaw/rabbit_nft/poseidon/body_front.png',
  sourceRel: '.SpineRaw/rabbit_nft/poseidon/body_front.png',
  adoptRel: '.SpineRaw/rabbit_nft/poseidon/body_front.png',
  key: 'spineraw/rabbit-nft/poseidon/body-front',
};

describe('why', () => {
  it('names the exclude rule that skipped a file', () => {
    const v = explainSprite(rabbit, { connect: ['**'], exclude: ['**/rabbit_nft/**'] }, {}, null);
    expect(v).toEqual({ kind: 'excluded', rule: '**/rabbit_nft/**' });
  });

  it('reports a locally changed file as an upload', () => {
    const v = explainSprite(
      rabbit,
      { connect: ['**'], exclude: [] },
      { [rabbit.key]: { assetId: 'a', layerIdx: 0, sha256: 'c', diskSha256: 'old' } },
      'new',
    );
    expect(v.kind).toBe('changed');
  });
});

describe('clean-strays', () => {
  it('lists only outDir copies of game-owned sprites without a home here', () => {
    const disk = [
      { abs: '/o/runtime/deco/cactus/cactus.png', folder: 'runtime/deco/cactus', slug: 'cactus', key: 'runtime/deco/cactus/cactus' },
      { abs: '/o/untitled/wood.png', folder: 'untitled', slug: 'wood', key: 'untitled/wood' },
    ];
    const manifest = [
      { key: 'runtime/deco/cactus/cactus', game: true },
      { key: 'untitled/wood' },
    ];
    expect(findStrayCopies(disk, manifest, []).map((d) => d.key)).toEqual(['runtime/deco/cactus/cactus']);
  });
});

describe('watch status line', () => {
  it('is cut to the terminal width so it never wraps', () => {
    const line = fitStatusLine('x'.repeat(200), 80);
    expect(line.length).toBe(79);
  });
});
