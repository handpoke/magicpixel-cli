import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GAME_SCAN_SKIP_DIRS,
  GAME_SCAN_SKIP_HIDDEN,
  gameScanRoot,
  indexGamePngs,
  matchConnectGlobs,
  searchGameIndex,
  countingSpritesText,
} from '../src/util/gameScan.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'mp-gamescan-'));
}

describe('gameScanRoot', () => {
  it('points at the engine asset tree', () => {
    expect(gameScanRoot('Unity')).toBe('Assets');
    expect(gameScanRoot('Godot')).toBe('assets');
    expect(gameScanRoot('GameMaker')).toBe('datafiles');
    expect(gameScanRoot('Vite')).toBeNull();
  });
});

describe('indexGamePngs', () => {
  it('indexes Unity Assets PNGs and skips Library/Packages without copying', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, 'Assets', 'Library'), { recursive: true });
    mkdirSync(join(cwd, 'Packages'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, 'Assets', 'Library', 'junk.png'), png);
    writeFileSync(join(cwd, 'Packages', 'pkg.png'), png);

    const r = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(r.files.map((f) => f.sourceRel)).toEqual(['Assets/Sprites/hero.png']);
    expect(r.files[0].key).toBe('sprites/hero/hero');
    expect(existsSync(join(cwd, 'Assets', 'MagicPixel'))).toBe(false);
  });

  it('is a no-op for JS projects', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'src', 'assets'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'assets', 'hero.png'), png);
    const r = await indexGamePngs('Vite', cwd, 'src/assets/magicpixel');
    expect(r.files).toEqual([]);
  });

  it('indexes a UPM package including hidden content dirs', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, '.SpineRaw_nonremote'), { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, '.magicpixel'), { recursive: true });
    mkdirSync(join(cwd, 'Editor'), { recursive: true });
    writeFileSync(join(cwd, 'assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, '.SpineRaw_nonremote', 'spine.png'), png);
    writeFileSync(join(cwd, '.git', 'ignored.png'), png);
    writeFileSync(join(cwd, '.magicpixel', 'cache.png'), png);
    writeFileSync(join(cwd, 'Editor', 'gizmo.png'), png);

    const r = await indexGamePngs('Unity', cwd, 'assets/MagicPixel');
    expect(r.files.map((f) => f.key).sort()).toEqual(
      ['editor/gizmo/gizmo', 'spineraw-nonremote/spine/spine', 'sprites/hero/hero'].sort(),
    );
    expect(r.files.some((f) => f.sourceRel.includes('.git'))).toBe(false);
    expect(existsSync(join(cwd, 'assets', 'MagicPixel'))).toBe(false);
  });

  it('walks only Assets in a Unity game project', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, 'ProjectSettings'), { recursive: true });
    mkdirSync(join(cwd, 'Editor'), { recursive: true });
    mkdirSync(join(cwd, 'Builds'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, 'Editor', 'gizmo.png'), png);
    writeFileSync(join(cwd, 'Builds', 'bundle.png'), png);

    const seen: string[] = [];
    const r = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel', {
      onProgress: (p) => { if (p.current) seen.push(p.current); },
    });
    expect(r.files.map((f) => f.sourceRel)).toEqual(['Assets/Sprites/hero.png']);
    expect(seen.some((c) => c === 'Assets' || c.startsWith('Assets/'))).toBe(true);
    expect(seen.some((c) => c === 'Editor' || c.startsWith('Builds'))).toBe(false);
  });

  it('does not index a nested MagicPixel outDir', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, 'pkg', 'assets', 'MagicPixel', 'old'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, 'pkg', 'assets', 'MagicPixel', 'old', 'copy.png'), png);

    const r = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(r.files.map((f) => f.key)).toEqual(['sprites/hero/hero']);
  });

  it('skips Godot imported .godot PNGs', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, '.godot', 'imported'), { recursive: true });
    writeFileSync(join(cwd, 'assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, '.godot', 'imported', 'hero.png'), png);

    const r = await indexGamePngs('Godot', cwd, 'assets/magicpixel');
    expect(r.files.map((f) => f.sourceRel)).toEqual(['assets/Sprites/hero.png']);
  });
});

describe('matchConnectGlobs', () => {
  it('selects only matching paths and leaves the rest unconnected', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites', 'Hero'), { recursive: true });
    mkdirSync(join(cwd, 'Assets', 'UI'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'Hero', 'idle.png'), png);
    writeFileSync(join(cwd, 'Assets', 'UI', 'hud.png'), png);

    const index = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(matchConnectGlobs(index, []).entries).toEqual([]);
    const hero = matchConnectGlobs(index, ['Sprites/Hero/**']);
    expect(hero.entries.map((e) => e.sourceRel)).toEqual(['Assets/Sprites/Hero/idle.png']);
    const exact = matchConnectGlobs(index, ['Assets/UI/hud.png']);
    expect(exact.entries.map((e) => e.sourceRel)).toEqual(['Assets/UI/hud.png']);
  });

  it('exclude wins over connect so excluded files never upload', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'SpineRaw', 'rabbit_nft'), { recursive: true });
    mkdirSync(join(cwd, 'Assets', 'UI'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'SpineRaw', 'rabbit_nft', 'body.png'), png);
    writeFileSync(join(cwd, 'Assets', 'UI', 'hud.png'), png);
    const index = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(matchConnectGlobs(index, ['**'], ['SpineRaw/rabbit_nft/**']).entries.map((e) => e.sourceRel))
      .toEqual(['Assets/UI/hud.png']);
  });

  it('indexes every PNG with no file-count cap', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    for (let i = 0; i < 10_001; i++) writeFileSync(join(cwd, 'Assets', 'Sprites', `s${i}.png`), png);
    const index = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(index.files).toHaveLength(10_001);
    expect(matchConnectGlobs(index, ['**']).entries).toHaveLength(10_001);
  }, 60_000);
});

describe('searchGameIndex', () => {
  it('substring-matches path and key', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    const index = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(searchGameIndex(index, 'hero').map((e) => e.sourceRel)).toEqual(['Assets/Sprites/hero.png']);
    expect(searchGameIndex(index, 'nope')).toEqual([]);
  });
});

describe('countingSpritesText', () => {
  it('starts without a count and then includes running totals', () => {
    expect(countingSpritesText(0)).toBe('Counting sprites in your game…');
    expect(countingSpritesText({ pngs: 0, folders: 12 })).toBe(
      'Counting sprites in your game…  0 sprites · 12 folders',
    );
    expect(countingSpritesText({ pngs: 2147, folders: 890 })).toBe(
      'Counting sprites in your game…  2,147 sprites · 890 folders',
    );
    expect(countingSpritesText({ pngs: 0, folders: 1, current: 'Assets' })).toBe(
      'Counting sprites in your game…  0 sprites · 1 folder · Assets',
    );
    expect(countingSpritesText(2147)).toBe('Counting sprites in your game…  2,147 sprites');
  });
});

describe('indexGamePngs progress', () => {
  it('reports folder visits before any PNGs are found', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Empty', 'Nested'), { recursive: true });
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'a.png'), png);
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'b.png'), png);
    const seen: { pngs: number; folders: number }[] = [];
    await indexGamePngs('Unity', cwd, 'Assets/MagicPixel', { onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.pngs === 0 && p.folders > 0)).toBe(true);
    expect(seen[seen.length - 1].pngs).toBe(2);
    expect(seen[seen.length - 1].folders).toBeGreaterThan(0);
  });
});

describe('GAME_SCAN_SKIP_DIRS', () => {
  it('covers Unity bookkeeping folders', () => {
    expect(GAME_SCAN_SKIP_DIRS.has('library')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('packages')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('temp')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('magicpixel')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('builds')).toBe(true);
  });
});

describe('GAME_SCAN_SKIP_HIDDEN', () => {
  it('skips tooling dirs but not content-hidden folders', () => {
    expect(GAME_SCAN_SKIP_HIDDEN.has('.git')).toBe(true);
    expect(GAME_SCAN_SKIP_HIDDEN.has('.magicpixel')).toBe(true);
    expect(GAME_SCAN_SKIP_HIDDEN.has('.SpineRaw_nonremote')).toBe(false);
  });
});

import { mkdirSync as mk2, mkdtempSync as mkt2, writeFileSync as wf2 } from 'node:fs';
import { tmpdir as td2 } from 'node:os';
import { join as j2 } from 'node:path';
import { describeExcluded as dx2, indexGamePngs as idx2, matchConnectGlobs as mc2 } from '../src/util/gameScan.js';

describe('Unity root sprite dot-folders + exclude report', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  function unityProject(): string {
    const d = mkt2(j2(td2(), 'mp-unity-'));
    for (const p of ['Assets/Sprites/a.png', '.SpineRaw/rabbit_nft/poseidon/body_front.png', 'Library/x.png', '.git/y.png']) {
      const abs = j2(d, p);
      mk2(j2(abs, '..'), { recursive: true });
      wf2(abs, png);
    }
    mk2(j2(d, 'ProjectSettings'), { recursive: true });
    return d;
  }

  it('indexes .SpineRaw next to Assets but still skips Library and .git', async () => {
    const idx = await idx2('Unity', unityProject());
    const rels = idx.files.map((f) => f.sourceRel).sort();
    expect(rels).toContain('.SpineRaw/rabbit_nft/poseidon/body_front.png');
    expect(rels).toContain('Assets/Sprites/a.png');
    expect(rels.some((r) => r.startsWith('Library/') || r.startsWith('.git/'))).toBe(false);
  });

  it('counts and names the exclude rule that skipped files', async () => {
    const idx = await idx2('Unity', unityProject());
    const r = mc2(idx, ['**'], ['.SpineRaw/rabbit_nft/**']);
    expect(r.excluded).toBe(1);
    expect(r.topExclude).toBe('.SpineRaw/rabbit_nft/**');
    expect(dx2(r)).toContain('1 PNG skipped by exclude rules (.SpineRaw/rabbit_nft/**)');
    expect(dx2(mc2(idx, ['**'], []))).toBeNull();
  });
});
