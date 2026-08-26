import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { clearFileHashCache, hashFile } from '../src/util/hash.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('hashFile', () => {
  beforeEach(() => {
    clearFileHashCache();
  });

  it('hashes a PNG and reuses the cache when mtime and size are unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-hash-'));
    const path = join(dir, 'a.png');
    writeFileSync(path, png);

    const first = await hashFile(path);
    expect(first?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const second = await hashFile(path);
    expect(second).toEqual(first);
  });

  it('re-reads after the file contents change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-hash-'));
    const path = join(dir, 'a.png');
    writeFileSync(path, png);
    const first = await hashFile(path);
    writeFileSync(path, Buffer.concat([png, Buffer.from([1])]));
    const second = await hashFile(path);
    expect(second?.sha256).toBeTruthy();
    expect(second?.sha256).not.toBe(first?.sha256);
  });

  it('reuses a persisted mtime/size hint without depending on the in-memory cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-hash-'));
    const path = join(dir, 'a.png');
    writeFileSync(path, png);
    const first = await hashFile(path);
    expect(first).toBeTruthy();
    clearFileHashCache();
    const hinted = await hashFile(path, first!);
    expect(hinted).toEqual(first);
  });
});
