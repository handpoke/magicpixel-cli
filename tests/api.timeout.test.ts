import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchManifestSnapshot, retryTransient } from '../src/api.js';
import { safeFetch } from '../src/util/security.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('safeFetch request deadline', () => {
  it('aborts a request that never settles and reports a timeout', async () => {
    // Honour the abort signal the way undici does: a stalled socket only ever
    // ends because the deadline fires.
    globalThis.fetch = ((_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      })) as typeof fetch;

    await expect(
      safeFetch('https://example.com/manifest', {}, { timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after/i);
  });

  it('leaves a caller-supplied signal alone', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit = {}) => {
      seen = init.signal ?? undefined;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;

    await safeFetch('https://example.com/manifest', { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it('retries a timeout as a transient network failure', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const result = await retryTransient(
      'manifest',
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("timed out after 45s — MagicPixel didn't respond in time.");
        return 'ok';
      },
      sleep,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('fetchManifestSnapshot progress', () => {
  it('reports a running entry count per page', async () => {
    vi.stubEnv('MAGICPIXEL_API_KEY', 'mp_test_' + 'a'.repeat(64));
    const pages = [
      { items: [{ key: 'a' }, { key: 'b' }], nextCursor: 'c1' },
      { items: [{ key: 'c' }], nextCursor: null },
    ];
    let call = 0;
    globalThis.fetch = (() => {
      const body = JSON.stringify(pages[Math.min(call++, pages.length - 1)]);
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }) as typeof fetch;

    const seen: number[] = [];
    const snapshot = await fetchManifestSnapshot(
      { outDir: 'tmp', include: ['**/*'], exclude: [], connect: [], emitIndex: false },
      undefined,
      (n) => seen.push(n),
    );
    expect(snapshot.entries).toHaveLength(3);
    expect(seen).toEqual([2, 3]);
  });
});
