import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllManifest } from '../src/api.js';
import type { MagicPixelConfig } from '../src/config.js';

const VALID_KEY = 'mp_test_' + 'a'.repeat(64);

const config: MagicPixelConfig = {
  outDir: 'tmp',
  include: ['**/*'],
  exclude: [],
  emitIndex: false,
};

describe('fetchAllManifest cursor-loop guard', () => {
  const originalKey = process.env.MAGICPIXEL_API_KEY;
  beforeEach(() => {
    process.env.MAGICPIXEL_API_KEY = VALID_KEY;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = originalKey;
  });

  it('aborts when the server returns the same cursor twice in a row', async () => {
    // Two calls: both return the same nextCursor ("stuck"). The guard should
    // throw on the second iteration rather than burn the 200-page budget.
    const body = (cursor: string | null) =>
      new Response(JSON.stringify({ items: [], nextCursor: cursor, count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(body('stuck'))
      .mockResolvedValueOnce(body('stuck'));

    await expect(fetchAllManifest(config)).rejects.toThrow(/repeating cursor/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('terminates normally when nextCursor advances and then ends', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: 'c1', count: 0 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null, count: 0 }), { status: 200 }),
      );

    await expect(fetchAllManifest(config)).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
