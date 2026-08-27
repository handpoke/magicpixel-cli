import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveConfig, loadConfig } from '../src/config.js';
import { ensureEngineConnect, nextConnectGlobs } from '../src/util/engineConnect.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mp-engconn-'));
}

describe('ensureEngineConnect', () => {
  it('fills ** for a Unity game with an empty connect list', async () => {
    const cwd = tmpDir();
    mkdirSync(join(cwd, 'Assets'), { recursive: true });
    mkdirSync(join(cwd, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(cwd, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3\n');
    await saveConfig(
      { outDir: 'Assets/MagicPixel', include: ['**/*'], exclude: [], connect: [], emitIndex: false },
      cwd,
    );
    const next = await ensureEngineConnect(await loadConfig(cwd), cwd);
    expect(next.connect).toEqual(['**']);
    expect(JSON.parse(readFileSync(join(cwd, 'magicpixel.json'), 'utf8')).connect).toEqual(['**']);
  });

  it('leaves an explicit connect glob alone', async () => {
    const cwd = tmpDir();
    mkdirSync(join(cwd, 'Assets'), { recursive: true });
    mkdirSync(join(cwd, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(cwd, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3\n');
    await saveConfig(
      { outDir: 'Assets/MagicPixel', include: ['**/*'], exclude: [], connect: ['Sprites/**'], emitIndex: false },
      cwd,
    );
    const next = await ensureEngineConnect(await loadConfig(cwd), cwd);
    expect(next.connect).toEqual(['Sprites/**']);
  });

  it('does not invent connect globs for a JS project', async () => {
    const cwd = tmpDir();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { vite: '5.0.0' } }));
    await saveConfig(
      { outDir: 'src/assets/magicpixel', include: ['**/*'], exclude: [], connect: [], emitIndex: true },
      cwd,
    );
    const next = await ensureEngineConnect(await loadConfig(cwd), cwd);
    expect(next.connect).toEqual([]);
  });
});

describe('nextConnectGlobs', () => {
  it('replaces a default ** when the user names a folder', () => {
    expect(nextConnectGlobs(['**'], 'Sprites/**')).toEqual(['Sprites/**']);
  });

  it('drops a leftover ** so OR-matching cannot keep everything', () => {
    expect(nextConnectGlobs(['**', 'Sprites/**'], 'UI/**')).toEqual(['Sprites/**', 'UI/**']);
  });

  it('accumulates specific folders', () => {
    expect(nextConnectGlobs(['Sprites/**'], 'UI/**')).toEqual(['Sprites/**', 'UI/**']);
  });

  it('restores all sprites when the user passes **', () => {
    expect(nextConnectGlobs(['Sprites/**'], '**')).toEqual(['**']);
  });

  it('is a no-op when the glob is already present', () => {
    expect(nextConnectGlobs(['Sprites/**'], 'Sprites/**')).toEqual(['Sprites/**']);
  });
});
