import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aliasCollisionKeys,
  collectSourceRelMap,
  isPathInside,
  remapAbsToCloudKeys,
  resolveProjectRel,
  sanitizeSourceRel,
  stripDocCollisionSuffix,
  syncDiskPathFromKey,
} from '../src/util/syncPath.js';

describe('sanitizeSourceRel', () => {
  it('accepts a relative png and rejects traversal, absolute, and non-png', () => {
    expect(sanitizeSourceRel('Assets/Sprites/hero.png')).toBe('Assets/Sprites/hero.png');
    expect(sanitizeSourceRel('./Assets/hero.png')).toBe('Assets/hero.png');
    expect(sanitizeSourceRel('../outside.png')).toBeNull();
    expect(sanitizeSourceRel('Assets/../package.json')).toBeNull();
    expect(sanitizeSourceRel('Assets/../evil.png')).toBeNull();
    expect(sanitizeSourceRel('Assets/Scripts/Player.cs')).toBeNull();
    expect(sanitizeSourceRel('/tmp/x.png')).toBeNull();
    expect(sanitizeSourceRel('C:\\Windows\\x.png')).toBeNull();
    expect(sanitizeSourceRel('foo//bar.png')).toBeNull();
    expect(sanitizeSourceRel('')).toBeNull();
  });
});

describe('syncDiskPathFromKey', () => {
  it('writes connected sprites to sourceRel, not outDir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mp-syncpath-'));
    const sourceByKey = new Map([['sprites/hero/hero', 'Assets/Sprites/hero.png']]);
    const abs = syncDiskPathFromKey('Assets/MagicPixel', 'sprites/hero/hero', sourceByKey, cwd);
    expect(abs).toBe(join(cwd, 'Assets', 'Sprites', 'hero.png'));
    const native = syncDiskPathFromKey('Assets/MagicPixel', 'untitled-2/wood', sourceByKey, cwd);
    expect(native).toBe(join(cwd, 'Assets', 'MagicPixel', 'untitled-2', 'wood.png'));
  });

  it('refuses a sourceRel that escapes the project or is not a png', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mp-syncpath-'));
    expect(() => resolveProjectRel('../outside.png', cwd)).toThrow(/unsafe game path/);
    expect(() => resolveProjectRel('Assets/../package.json', cwd)).toThrow(/unsafe game path/);
    expect(() => resolveProjectRel('Assets/Scripts/Player.cs', cwd)).toThrow(/unsafe game path/);
  });
});

describe('collectSourceRelMap', () => {
  it('uses only the live working set and ignores tampered state paths', () => {
    const connected = [
      { abs: '/x', sourceRel: 'Assets/UI/hud.png', adoptRel: 'UI/hud.png', key: 'ui/hud/hud' },
      { abs: '/y', sourceRel: 'Assets/../secrets.png', adoptRel: 'secrets.png', key: 'secrets/secrets' },
    ];
    const map = collectSourceRelMap(connected, {
      'ui/hud/hud': { sourceRel: 'Assets/Scripts/Player.cs' },
      'evil/evil': { sourceRel: 'Assets/../package.json' },
    });
    expect(map.get('ui/hud/hud')).toBe('Assets/UI/hud.png');
    expect(map.has('secrets/secrets')).toBe(false);
    expect(map.has('evil/evil')).toBe(false);
  });

  it('aliases a cloud key onto a live indexed PNG', () => {
    const map = collectSourceRelMap(
      [{ abs: '/x', sourceRel: 'Assets/Sprites/hero.png', adoptRel: 'Sprites/hero.png', key: 'sprites/hero/hero' }],
      { 'sprites/hero/hero-2': { sourceRel: 'Assets/Sprites/hero.png' } },
    );
    expect(map.get('sprites/hero/hero')).toBe('Assets/Sprites/hero.png');
    expect(map.get('sprites/hero/hero-2')).toBe('Assets/Sprites/hero.png');
  });
});

describe('aliasCollisionKeys', () => {
  it('maps an ingest collision slug onto the original game file', () => {
    expect(stripDocCollisionSuffix('runtime/prebaked/spine/ground-ice-snow-4/ground-ice-snow')).toBe(
      'runtime/prebaked/spine/ground-ice-snow/ground-ice-snow',
    );
    const map = new Map([['runtime/prebaked/spine/ground-ice-snow/ground-ice-snow', 'Assets/Runtime/ground_ice_snow.png']]);
    aliasCollisionKeys(map, ['runtime/prebaked/spine/ground-ice-snow-4/ground-ice-snow']);
    expect(map.get('runtime/prebaked/spine/ground-ice-snow-4/ground-ice-snow')).toBe(
      'Assets/Runtime/ground_ice_snow.png',
    );
  });

  it('does not invent a working-set path when the unsuffixed key is absent', () => {
    const map = new Map<string, string>();
    aliasCollisionKeys(map, ['sprites/hero-2/hero']);
    expect(map.size).toBe(0);
  });
});

describe('remapAbsToCloudKeys', () => {
  it('pushes under the cloud key so a collision does not re-adopt', () => {
    const absByKey = new Map([['sprites/hero/hero', '/proj/Assets/Sprites/hero.png']]);
    remapAbsToCloudKeys(
      absByKey,
      [{ abs: '/proj/Assets/Sprites/hero.png', sourceRel: 'Assets/Sprites/hero.png', adoptRel: 'Sprites/hero.png', key: 'sprites/hero/hero' }],
      { 'sprites/hero/hero-2': { sourceRel: 'Assets/Sprites/hero.png' } },
    );
    expect(absByKey.get('sprites/hero/hero-2')).toBe('/proj/Assets/Sprites/hero.png');
    expect(absByKey.has('sprites/hero/hero')).toBe(false);
  });
});

describe('isPathInside', () => {
  it('is true only for descendants of root', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mp-inside-'));
    expect(isPathInside(join(cwd, 'Assets', 'MagicPixel', 'a.png'), join(cwd, 'Assets', 'MagicPixel'))).toBe(true);
    expect(isPathInside(join(cwd, 'Assets', 'Sprites', 'a.png'), join(cwd, 'Assets', 'MagicPixel'))).toBe(false);
  });
});
