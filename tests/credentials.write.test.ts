import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { writeCredentials, credentialsPath } from '../src/util/credentials.js';

/**
 * Guard the atomic write + 0600 contract for `.magicpixel/credentials`.
 *
 * - Final file must land at mode 0600 (POSIX only; chmod is a no-op on
 *   Windows so the perm check is skipped there).
 * - No stray `.tmp` files left over after a successful write.
 * - Final contents must round-trip JSON cleanly.
 */
describe('writeCredentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-cred-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes credentials atomically and rounds-trips JSON', async () => {
    const key = 'mp_live_' + 'a'.repeat(64);
    const path = await writeCredentials(key, dir);
    expect(path).toBe(credentialsPath(dir));
    expect(existsSync(path)).toBe(true);

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { apiKey: string; savedAt: string };
    expect(parsed.apiKey).toBe(key);
    expect(typeof parsed.savedAt).toBe('string');
    expect(parsed.savedAt.length).toBeGreaterThan(0);
  });

  it('leaves no stray .tmp files in the credentials dir after a successful write', async () => {
    await writeCredentials('mp_live_' + 'a'.repeat(64), dir);
    const files = readdirSync(join(dir, '.magicpixel'));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('sets the final file to mode 0600 on POSIX', async () => {
    if (platform() === 'win32') return; // chmod is best-effort on Windows
    const path = await writeCredentials('mp_live_' + 'a'.repeat(64), dir);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing credentials file in place', async () => {
    const oldKey = 'mp_live_' + 'a'.repeat(64);
    const newKey = 'mp_test_' + 'b'.repeat(64);
    await writeCredentials(oldKey, dir);
    await writeCredentials(newKey, dir);
    const parsed = JSON.parse(readFileSync(credentialsPath(dir), 'utf8')) as { apiKey: string };
    expect(parsed.apiKey).toBe(newKey);
  });
});
