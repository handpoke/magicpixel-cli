import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_SCAN_SKIP_DIRS, gameScanRoot, importNearbyGamePngs } from '../src/util/gameScan.js';

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

describe('importNearbyGamePngs', () => {
  it('copies Unity Assets PNGs into outDir and skips Library/Packages', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, 'Assets', 'Library'), { recursive: true });
    mkdirSync(join(cwd, 'Packages'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, 'Assets', 'Library', 'junk.png'), png);
    writeFileSync(join(cwd, 'Packages', 'pkg.png'), png);

    const r = await importNearbyGamePngs('Assets/MagicPixel', 'Unity', cwd);
    expect(r.copied).toBe(1);
    expect(existsSync(join(cwd, 'Assets', 'MagicPixel', 'Sprites', 'hero.png'))).toBe(true);
    expect(existsSync(join(cwd, 'Assets', 'MagicPixel', 'Library', 'junk.png'))).toBe(false);
    expect(readFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'))).toEqual(png);
  });

  it('does not overwrite a file already in outDir', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'Assets', 'Sprites'), { recursive: true });
    mkdirSync(join(cwd, 'Assets', 'MagicPixel', 'Sprites'), { recursive: true });
    writeFileSync(join(cwd, 'Assets', 'Sprites', 'hero.png'), png);
    writeFileSync(join(cwd, 'Assets', 'MagicPixel', 'Sprites', 'hero.png'), Buffer.from('old'));

    const r = await importNearbyGamePngs('Assets/MagicPixel', 'Unity', cwd);
    expect(r.copied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(readFileSync(join(cwd, 'Assets', 'MagicPixel', 'Sprites', 'hero.png'))).toEqual(Buffer.from('old'));
  });

  it('is a no-op for JS projects', async () => {
    const cwd = tmpProject();
    mkdirSync(join(cwd, 'src', 'assets'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'assets', 'hero.png'), png);
    const r = await importNearbyGamePngs('src/assets/magicpixel', 'Vite', cwd);
    expect(r.copied).toBe(0);
  });
});

describe('GAME_SCAN_SKIP_DIRS', () => {
  it('covers Unity bookkeeping folders', () => {
    expect(GAME_SCAN_SKIP_DIRS.has('library')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('packages')).toBe(true);
    expect(GAME_SCAN_SKIP_DIRS.has('temp')).toBe(true);
  });
});
