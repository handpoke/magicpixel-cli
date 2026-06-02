import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepTmpFiles, runTmpJanitor } from '../src/util/tmpJanitor.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-tmpj-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeOldTmp(rel: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
  // Backdate 5 minutes — comfortably past the 30s safety floor.
  const oldTime = new Date(Date.now() - 5 * 60_000);
  utimesSync(full, oldTime, oldTime);
  return full;
}

describe('sweepTmpFiles', () => {
  it('removes files matching <basename>.<pid>.<16-hex>.tmp', async () => {
    const a = makeOldTmp('state.json.12345.0123456789abcdef.tmp');
    const b = makeOldTmp('asset.png.999.deadbeefcafebabe.tmp');
    const removed = await sweepTmpFiles(root);
    expect(removed.sort()).toEqual([a, b].sort());
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it('does NOT touch fresh tmp files (race-safety floor)', async () => {
    const full = join(root, 'state.json.12345.0123456789abcdef.tmp');
    writeFileSync(full, '');
    // Fresh mtime — should be kept.
    const removed = await sweepTmpFiles(root);
    expect(removed).toEqual([]);
    expect(existsSync(full)).toBe(true);
  });

  it('does NOT touch user files that lack the strict suffix pattern', async () => {
    const keep1 = makeOldTmp('notes.tmp');                     // no pid/hex
    const keep2 = makeOldTmp('config.12345.tmp');              // missing hex
    const keep3 = makeOldTmp('state.json.12345.xyz.tmp');      // non-hex
    const keep4 = makeOldTmp('state.json.12345.0123456789abcdef.bak'); // wrong ext
    const removed = await sweepTmpFiles(root);
    expect(removed).toEqual([]);
    for (const f of [keep1, keep2, keep3, keep4]) expect(existsSync(f)).toBe(true);
  });

  it('recurses one level into subfolders (outDir/<slug>/) and prunes there', async () => {
    const nested = makeOldTmp('cards/tree.png.12345.0123456789abcdef.tmp');
    const removed = await sweepTmpFiles(root);
    expect(removed).toEqual([nested]);
  });

  it('returns [] for a non-existent directory', async () => {
    const removed = await sweepTmpFiles(join(root, 'does-not-exist'));
    expect(removed).toEqual([]);
  });
});

describe('runTmpJanitor', () => {
  it('sweeps outDir, .magicpixel/, and cwd', async () => {
    const outDir = join(root, 'src/assets/mp');
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(root, '.magicpixel'), { recursive: true });

    const a = makeOldTmp('src/assets/mp/cards/tree.png.12345.0123456789abcdef.tmp');
    const b = makeOldTmp('.magicpixel/state.json.12345.deadbeefcafebabe.tmp');
    const c = makeOldTmp('package.json.12345.feedfacedeadbeef.tmp');

    const removed = await runTmpJanitor(outDir, root);
    expect(removed.sort()).toEqual([a, b, c].sort());
  });
});
