import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unityGuid, writeMissingUnityMetas } from '../src/util/unityMeta.js';

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mpx-unitymeta-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe('unityGuid', () => {
  it('is deterministic and 32 hex chars', () => {
    const a = unityGuid('asset-1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(unityGuid('asset-1')).toBe(a);
    expect(unityGuid('asset-2')).not.toBe(a);
  });
});

describe('writeMissingUnityMetas', () => {
  it('writes a .meta beside each synced PNG with a stable GUID across runs', async () => {
    const dir = tmp();
    const png = join(dir, 'hero.png');
    writeFileSync(png, 'not-really-a-png');

    const first = await writeMissingUnityMetas([{ id: 'abc', pngPath: png }], 32);
    expect(first.written).toBe(1);
    const meta = readFileSync(`${png}.meta`, 'utf8');
    expect(meta).toContain(`guid: ${unityGuid('abc')}`);
    expect(meta).toContain('filterMode: 0');
    expect(meta).toContain('spritePixelsToUnits: 32');

    // Re-sync: existing sidecars are left alone so user importer tweaks survive.
    rmSync(png);
    writeFileSync(png, 'changed-bytes');
    const second = await writeMissingUnityMetas([{ id: 'abc', pngPath: png }], 64);
    expect(second.written).toBe(0);
    expect(readFileSync(`${png}.meta`, 'utf8')).toBe(meta);
  });

  it('skips entries whose PNG is not on disk', async () => {
    const dir = tmp();
    const missing = join(dir, 'ghost.png');
    const result = await writeMissingUnityMetas([{ id: 'x', pngPath: missing }]);
    expect(result.written).toBe(0);
    expect(existsSync(`${missing}.meta`)).toBe(false);
  });
});
