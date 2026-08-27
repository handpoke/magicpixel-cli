import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasUnpushedLocalEdit, isLocalEdit } from '../src/util/localEdit.js';
import { fileSha256 } from '../src/util/hash.js';

describe('isLocalEdit', () => {
  it('is an edit when the disk sha diverges from the recorded baseline', () => {
    expect(isLocalEdit('a'.repeat(64), 'b'.repeat(64))).toBe(true);
  });

  it('is not an edit when the bytes still match the baseline', () => {
    expect(isLocalEdit('a'.repeat(64), 'a'.repeat(64))).toBe(false);
  });

  it('is not an edit without a baseline (never synced by us)', () => {
    expect(isLocalEdit(undefined, 'b'.repeat(64))).toBe(false);
  });

  it('is not an edit when the file is gone', () => {
    expect(isLocalEdit('a'.repeat(64), null)).toBe(false);
  });
});

describe('hasUnpushedLocalEdit', () => {
  it('detects an edited PNG against the recorded baseline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-localedit-'));
    const abs = join(dir, 'sprite.png');
    await writeFile(abs, 'original');
    const baselineDiskSha256 = (await fileSha256(abs))!;
    expect(await hasUnpushedLocalEdit({ absPath: abs, baselineDiskSha256 })).toBe(false);

    await writeFile(abs, 'edited-in-unity');
    expect(await hasUnpushedLocalEdit({ absPath: abs, baselineDiskSha256 })).toBe(true);
  });

  it('never hashes (and never reports an edit) without a baseline', async () => {
    expect(
      await hasUnpushedLocalEdit({
        absPath: '/nonexistent/never-read.png',
        baselineDiskSha256: undefined,
      }),
    ).toBe(false);
  });

  it('reuses a sha the caller already computed', async () => {
    expect(
      await hasUnpushedLocalEdit({
        absPath: '/nonexistent/never-read.png',
        baselineDiskSha256: 'a'.repeat(64),
        knownSha256: 'a'.repeat(64),
      }),
    ).toBe(false);
  });
});
