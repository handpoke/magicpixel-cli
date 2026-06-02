import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDoctorReport } from '../src/commands/doctor.js';

/**
 * doctor must not fire a guaranteed-401 manifest probe when no API key is
 * configured. The pre-0.5.1 behavior surfaced a misleading "API rejected the
 * key" suggestion on top of the correct "run login" one.
 */
describe('doctor with no API key', () => {
  let dir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mp-doc-'));
    originalCwd = process.cwd();
    originalEnv = process.env.MAGICPIXEL_API_KEY;
    delete process.env.MAGICPIXEL_API_KEY;
    process.chdir(dir);
    await writeFile(
      join(dir, 'magicpixel.json'),
      JSON.stringify({ outDir: 'src/assets/mp', include: ['**/*'] }),
      'utf8',
    );
    await mkdir(join(dir, '.magicpixel'), { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = originalEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it('skips the probe and does NOT emit a redundant "API rejected" suggestion', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const report = await collectDoctorReport({});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.key.source).toBe('none');
    // Discriminated shape: probe was skipped, not failed. JSON consumers
    // branch on `'skipped' in network` rather than mis-reading ok:false.
    expect(report.network).toEqual({ skipped: 'no-api-key' });
    // The "run login" suggestion is present exactly once; the misleading
    // "API rejected the key" one must NOT appear.
    expect(report.suggestions.some((s) => /magicpixel login/.test(s))).toBe(true);
    expect(report.suggestions.some((s) => /API rejected the key/.test(s))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('--offline yields network.skipped="offline" regardless of key', async () => {
    const report = await collectDoctorReport({ offline: true });
    expect(report.network).toEqual({ skipped: 'offline' });
  });
});
