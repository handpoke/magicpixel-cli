import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findKeyInDotenv } from '../src/util/credentials.js';

/**
 * Regression coverage for the unanchored-regex bug where a sibling env var
 * (`MAGICPIXEL_API_KEY_OLD`, `_BACKUP`, …) would match and return the wrong
 * value. The fix anchors on the exact key name and also accepts an optional
 * `export` prefix plus a trailing `# comment`.
 */
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mpx-dotenv-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe('findKeyInDotenv', () => {
  it('returns the exact MAGICPIXEL_API_KEY value', async () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'MAGICPIXEL_API_KEY=mp_live_abc\n');
    expect(await findKeyInDotenv(d)).toEqual({ file: '.env', value: 'mp_live_abc' });
  });

  it('ignores sibling keys like MAGICPIXEL_API_KEY_OLD / _BACKUP', async () => {
    const d = tmp();
    writeFileSync(
      join(d, '.env'),
      [
        'MAGICPIXEL_API_KEY_OLD=mp_live_should_not_match',
        'MAGICPIXEL_API_KEY_BACKUP=mp_live_should_not_match_either',
      ].join('\n') + '\n',
    );
    expect(await findKeyInDotenv(d)).toBeNull();
  });

  it('returns the real key when both real and sibling are present', async () => {
    const d = tmp();
    writeFileSync(
      join(d, '.env'),
      [
        'MAGICPIXEL_API_KEY_OLD=mp_live_old',
        'MAGICPIXEL_API_KEY=mp_live_real',
      ].join('\n') + '\n',
    );
    expect(await findKeyInDotenv(d)).toEqual({ file: '.env', value: 'mp_live_real' });
  });

  it('tolerates `export ` prefix and trailing inline comment', async () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'export MAGICPIXEL_API_KEY=mp_live_abc # local dev\n');
    expect(await findKeyInDotenv(d)).toEqual({ file: '.env', value: 'mp_live_abc' });
  });

  it('tolerates quoted value and spaces around `=`', async () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'MAGICPIXEL_API_KEY = "mp_live_abc"\n');
    expect(await findKeyInDotenv(d)).toEqual({ file: '.env', value: 'mp_live_abc' });
  });

  it('prefers .env.local over .env', async () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'MAGICPIXEL_API_KEY=mp_live_from_env\n');
    writeFileSync(join(d, '.env.local'), 'MAGICPIXEL_API_KEY=mp_live_from_local\n');
    expect(await findKeyInDotenv(d)).toEqual({ file: '.env.local', value: 'mp_live_from_local' });
  });
});
