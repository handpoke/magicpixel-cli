import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectProjectKind,
  isEngineKind,
  suggestOutDir,
  supportsTypedIndex,
} from '../src/util/framework.js';

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mpx-framework-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe('detectProjectKind', () => {
  it('prefers JS when package.json and project.godot both exist', async () => {
    const d = tmp();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { vite: '^5.0.0' } }));
    writeFileSync(join(d, 'project.godot'), '; Godot 4 Project\n');
    expect(await detectProjectKind(d)).toBe('Vite');
  });

  it('detects engine when package.json exists but has no framework deps', async () => {
    const d = tmp();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'tools', private: true }));
    mkdirSync(join(d, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(d, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
    expect(await detectProjectKind(d)).toBe('Unity');
  });

  it('detects Godot from project.godot', async () => {
    const d = tmp();
    writeFileSync(join(d, 'project.godot'), '; Godot 4 Project\n');
    expect(await detectProjectKind(d)).toBe('Godot');
    expect(suggestOutDir('Godot', d)).toBe('assets/magicpixel');
  });

  it('detects Unity from ProjectSettings/ProjectVersion.txt', async () => {
    const d = tmp();
    mkdirSync(join(d, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(d, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
    expect(await detectProjectKind(d)).toBe('Unity');
    expect(suggestOutDir('Unity', d)).toBe('Assets/MagicPixel');
  });

  it('detects GameMaker from a root *.yyp file', async () => {
    const d = tmp();
    writeFileSync(join(d, 'Foo.yyp'), '{}');
    expect(await detectProjectKind(d)).toBe('GameMaker');
    expect(suggestOutDir('GameMaker', d)).toBe('datafiles/magicpixel');
  });

  it('returns null when no markers are present', async () => {
    const d = tmp();
    expect(await detectProjectKind(d)).toBeNull();
    expect(suggestOutDir(null, d)).toBe('assets/magicpixel');
  });
});

describe('supportsTypedIndex', () => {
  it('returns false for engine kinds', () => {
    for (const kind of ['Unity', 'Godot', 'GameMaker'] as const) {
      expect(isEngineKind(kind)).toBe(true);
      expect(supportsTypedIndex(kind)).toBe(false);
    }
  });

  it('returns true for JS kinds', () => {
    expect(supportsTypedIndex('Vite')).toBe(true);
    expect(supportsTypedIndex(null)).toBe(true);
  });
});
