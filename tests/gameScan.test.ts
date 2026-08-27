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

  it('does not index a nested MagicPixel outDir', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, 'pkg', 'assets', 'MagicPixel', 'old'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, 'pkg', 'assets', 'MagicPixel', 'old', 'copy.png'), png);

    const r = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    expect(r.files.map((f) => f.key)).toEqual(['sprites/hero/hero']);
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
    expect(exact.total).toBe(1);
    expect(exact.capped).toBe(false);
  });

  it('reports the true match count when the ingest cap truncates', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'a.png'), png);
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'b.png'), png);
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'c.png'), png);
    const index = await indexGamePngs('Unity', cwd, 'Assets/MagicPixel');
    const r = matchConnectGlobs(index, ['Assets/Sprites/**'], 2);
    expect(r.total).toBe(3);
    expect(r.entries).toHaveLength(2);
    expect(r.capped).toBe(true);
  });
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
  it('starts without a count and then includes a running total', () => {
    expect(countingSpritesText(0)).toBe('Counting sprites in your game…');
    expect(countingSpritesText(2147)).toBe('Counting sprites in your game…  2,147');
  });
});

describe('indexGamePngs progress', () => {
  it('reports a running found count', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'a.png'), png);
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'b.png'), png);
    const seen: number[] = [];
    await indexGamePngs('Unity', cwd, 'Assets/MagicPixel', { onProgress: (n) => seen.push(n) });
    expect(seen[seen.length - 1]).toBe(2);
    expect(Math.max(...seen)).toBe(2);
  });
});

describe('GAME_SCAN_SKIP_DIRS', () => {
  it('covers Unity bookkeeping folders', () => {
    expect(GAME_SCAN_SKIP_DIRS.has('library')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('packages')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('temp')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('magicpixel')).toBe(true);
  });
});

describe('GAME_SCAN_SKIP_HIDDEN', () => {
  it('skips tooling dirs but not content-hidden folders', () => {
    expect(GAME_SCAN_SKIP_HIDDEN.has('.git')).toBe(true);
    expect(GAME_SCAN_SKIP_HIDDEN.has('.magicpixel')).toBe(true);
    expect(GAME_SCAN_SKIP_HIDDEN.has('.SpineRaw_nonremote')).toBe(false);
  });
});
