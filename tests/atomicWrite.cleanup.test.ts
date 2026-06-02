import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/util/atomicWrite.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-atomic-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const tmpFiles = (dir: string): string[] =>
  readdirSync(dir).filter((n) => /\.\d+\.[0-9a-f]{16}\.tmp$/.test(n));

describe('atomicWrite', () => {
  it('happy path writes string contents and leaves no tmp file', async () => {
    const target = join(root, 'state.json');
    await atomicWrite(target, '{"ok":true}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    expect(tmpFiles(root)).toEqual([]);
  });

  it('happy path writes Uint8Array contents (asset bytes)', async () => {
    const target = join(root, 'asset.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await atomicWrite(target, bytes);
    const back = readFileSync(target);
    expect(back.equals(Buffer.from(bytes))).toBe(true);
    expect(tmpFiles(root)).toEqual([]);
  });

  it('honors mode option on a created file', async () => {
    const target = join(root, 'creds');
    await atomicWrite(target, 'secret', { mode: 0o600 });
    expect(readFileSync(target, 'utf8')).toBe('secret');
    expect(tmpFiles(root)).toEqual([]);
  });

  it('cleans up the staged tmp file when rename fails and rethrows', async () => {
    // Organic rename failure: target is a non-empty directory. `rename(tmp,
    // target)` then throws (EISDIR / ENOTEMPTY depending on platform), which
    // is exactly the kind of intermittent failure the cleanup guards against.
    const target = join(root, 'dir-target');
    mkdirSync(target);
    writeFileSync(join(target, 'sentinel'), 'x');
    await expect(atomicWrite(target, 'hello')).rejects.toThrow();
    // The tmp file must have been cleaned up.
    expect(tmpFiles(root)).toEqual([]);
    // And the original target directory + its sentinel must still exist.
    expect(existsSync(join(target, 'sentinel'))).toBe(true);
  });

  it('does not leak when the parent dir is missing (writeFile throws)', async () => {
    // writeFile fails at the very first syscall — no tmp gets created. The
    // catch-block unlink will ENOENT; the caller must still see the writeFile
    // error, and no stray files must remain.
    const target = join(root, 'nonexistent-parent', 'state.json');
    await expect(atomicWrite(target, 'x')).rejects.toThrow();
    // root itself remains empty.
    expect(readdirSync(root)).toEqual([]);
  });
});
