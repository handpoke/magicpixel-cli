import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetTelemetryForTesting, reportCliError } from '../src/util/telemetry.js';

const VALID_KEY = 'mp_live_' + 'a'.repeat(64);

function seedCredsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mp-telemetry-'));
  mkdirSync(join(dir, '.magicpixel'), { recursive: true });
  writeFileSync(
    join(dir, '.magicpixel/credentials'),
    JSON.stringify({ apiKey: VALID_KEY, savedAt: new Date().toISOString() }),
  );
  return dir;
}

describe('reportCliError', () => {
  const origCwd = process.cwd();
  const origFetch = globalThis.fetch;
  const origTelemetryEnv = process.env.MAGICPIXEL_TELEMETRY;
  const origKeyEnv = process.env.MAGICPIXEL_API_KEY;
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetTelemetryForTesting();
    dir = seedCredsDir();
    process.chdir(dir);
    delete process.env.MAGICPIXEL_TELEMETRY;
    delete process.env.MAGICPIXEL_API_KEY;
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = origFetch;
    if (origTelemetryEnv === undefined) delete process.env.MAGICPIXEL_TELEMETRY;
    else process.env.MAGICPIXEL_TELEMETRY = origTelemetryEnv;
    if (origKeyEnv === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = origKeyEnv;
  });

  it('POSTs to the canonical log-cli-error endpoint with the API key', async () => {
    await reportCliError(new Error('boom'), { command: 'sync' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/log-cli-error$/);
    expect(url).toContain('sddsilidjhvtvejzvolx.supabase.co');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${VALID_KEY}`);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.category).toBe('cli_error');
    expect(body.message).toBe('boom');
    expect(body.context.command).toBe('sync');
    expect(body.context.cli_version).toBeTruthy();
    expect(body.context.node_version).toBe(process.version);
  });

  it('skips when no API key is available', async () => {
    rmSync(join(dir, '.magicpixel/credentials'));
    await reportCliError(new Error('boom'), { command: 'sync' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when MAGICPIXEL_TELEMETRY=0', async () => {
    process.env.MAGICPIXEL_TELEMETRY = '0';
    await reportCliError(new Error('boom'), { command: 'sync' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips user-fixable errors (filtered by shouldReportCliError)', async () => {
    await reportCliError(new Error('No magicpixel.json found in /x'), { command: 'sync' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes identical messages within the dedupe window', async () => {
    await reportCliError(new Error('boom'), { command: 'sync' });
    await reportCliError(new Error('boom'), { command: 'sync' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throttles distinct messages within the throttle window', async () => {
    await reportCliError(new Error('first failure'), { command: 'sync' });
    await reportCliError(new Error('second failure'), { command: 'sync' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(reportCliError(new Error('boom'), { command: 'sync' })).resolves.toBeUndefined();
  });

  it('skips reporting to a custom (non-canonical) endpoint', async () => {
    await reportCliError(
      new Error('boom'),
      { command: 'sync' },
      { outDir: 'x', include: ['**/*'], exclude: [], endpoint: 'https://my-proxy.example.com/integration-assets', emitIndex: true },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
