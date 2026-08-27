import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, pushSpritesAdaptive } from '../src/api.js';

const VALID_KEY = 'mp_test_' + 'a'.repeat(64);
const instant = { sleep: async () => {} };

function sprite(key: string) {
  return {
    key,
    pngBase64: 'eA==',
    diskSha256: 'a'.repeat(64),
    path: ['sprites', key, key],
    pathNames: ['sprites', key, key],
    name: key,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pushSpritesAdaptive', () => {
  const originalKey = process.env.MAGICPIXEL_API_KEY;
  beforeEach(() => {
    process.env.MAGICPIXEL_API_KEY = VALID_KEY;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = originalKey;
  });

  it('splits a 502 batch and continues with smaller requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.sprites.length > 1) {
        return new Response('bad gateway', { status: 502, headers: { 'x-request-id': 'split' } });
      }
      return jsonResponse({
        results: body.sprites.map((s: { key: string }) => ({
          key: s.key,
          status: 'created',
          assetId: '00000000-0000-0000-0000-000000000001',
          layerIdx: 0,
          sha256: 'b'.repeat(64),
        })),
      });
    });
    const results = await pushSpritesAdaptive([sprite('a'), sprite('b')], instant);
    expect(results.map((r) => r.key).sort()).toEqual(['a', 'b']);
    expect(results.every((r) => r.status === 'created')).toBe(true);
  }, 15_000);

  it('records a single-sprite 502 as an error instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad gateway', { status: 502 }));
    const results = await pushSpritesAdaptive([sprite('only')], instant);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: 'only', status: 'error' });
  }, 15_000);

  it('does not swallow a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 401 }));
    await expect(pushSpritesAdaptive([sprite('a')], instant)).rejects.toBeInstanceOf(ApiError);
  });
});
