import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchAllManifest } from '../src/api.js';
import { assertKeyValid } from '../src/util/auth.js';
import type { MagicPixelConfig } from '../src/config.js';

const VALID_KEY = 'mp_test_' + 'a'.repeat(64);
const config: MagicPixelConfig = {
  outDir: 'tmp',
  include: ['**/*'],
  exclude: [],
  emitIndex: false,
};

const jsonResponse = (body: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

describe('fetchAllManifest shape guard', () => {
  const originalKey = process.env.MAGICPIXEL_API_KEY;
  beforeEach(() => {
    process.env.MAGICPIXEL_API_KEY = VALID_KEY;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = originalKey;
  });

  it('rejects {items: null} with a friendly ApiError', async () => {
    // Fresh response per attempt — retryTransient retries 502, and a single
    // Response body can only be read once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ items: null, nextCursor: null, count: 0 }),
    );
    await expect(fetchAllManifest(config)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/unexpected server response shape/),
    });
  });

  it('rejects a non-object response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(null));
    await expect(fetchAllManifest(config)).rejects.toMatchObject({ status: 502 });
  });
});

describe('assertKeyValid retry behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient 503 and succeeds on the second attempt', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null, count: 0 }));
    await expect(assertKeyValid(VALID_KEY, config)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bubbles 401 immediately without retrying', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(assertKeyValid(VALID_KEY, config)).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
