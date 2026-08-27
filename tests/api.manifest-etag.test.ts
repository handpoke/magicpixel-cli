import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllManifest,
  manifestEtagsSnapshot,
  primeManifestEtags,
  __resetManifestEtagsForTesting,
} from '../src/api.js';
import type { MagicPixelConfig } from '../src/config.js';

const VALID_KEY = 'mp_test_' + 'a'.repeat(64);

const config: MagicPixelConfig = {
  outDir: 'tmp',
  include: ['**/*'],
  exclude: [],
  connect: [],
  emitIndex: false,
};

const entry = {
  id: 'a1',
  key: 'sprites/hero.png',
  name: 'hero',
  updated_at: '2026-01-01T00:00:00.000Z',
  sha256: 'f'.repeat(64),
};

function jsonRes(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Idle `sync --watch` ticks must cost a conditional GET, and a 304 must never
 * be mistaken for "the cloud is empty" (which would let prune delete files).
 */
describe('manifest conditional requests', () => {
  const originalKey = process.env.MAGICPIXEL_API_KEY;
  beforeEach(() => {
    process.env.MAGICPIXEL_API_KEY = VALID_KEY;
    __resetManifestEtagsForTesting();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = originalKey;
  });

  it('replays the cached validator and resolves a 304 as no changes', async () => {
    const seen: Array<string | null> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers.get('If-None-Match'));
      if (seen.length === 1) {
        return Promise.resolve(
          jsonRes({ items: [entry], nextCursor: null, count: 1 }, { ETag: 'W/"abc"' }),
        );
      }
      return Promise.resolve(new Response(null, { status: 304, headers: { ETag: 'W/"abc"' } }));
    });

    const since = '2025-12-31T00:00:00.000Z';
    await expect(fetchAllManifest(config, since)).resolves.toEqual([entry]);
    await expect(fetchAllManifest(config, since)).resolves.toEqual([]);

    expect(seen).toEqual([null, 'W/"abc"']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never sends a validator on a full (non-incremental) fetch', async () => {
    const seen: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers.get('If-None-Match'));
      return Promise.resolve(
        jsonRes({ items: [entry], nextCursor: null, count: 1 }, { ETag: 'W/"abc"' }),
      );
    });

    await fetchAllManifest(config);
    await fetchAllManifest(config);
    expect(seen).toEqual([null, null]);
  });
});

/**
 * A one-shot `sync` (CI, cron, manual run) is a fresh process, so the only way
 * it can answer with a 304 is by replaying a validator persisted in state.json.
 */
describe('manifest validator persistence', () => {
  const originalKey = process.env.MAGICPIXEL_API_KEY;
  beforeEach(() => {
    process.env.MAGICPIXEL_API_KEY = VALID_KEY;
    __resetManifestEtagsForTesting();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MAGICPIXEL_API_KEY;
    else process.env.MAGICPIXEL_API_KEY = originalKey;
  });

  it('round-trips through snapshot/prime so a fresh run sends the validator', async () => {
    const seen: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers.get('If-None-Match'));
      if (seen.length === 1) {
        return Promise.resolve(
          jsonRes({ items: [entry], nextCursor: null, count: 1 }, { ETag: 'W/"abc"' }),
        );
      }
      return Promise.resolve(new Response(null, { status: 304, headers: { ETag: 'W/"abc"' } }));
    });

    const since = '2025-12-31T00:00:00.000Z';
    await fetchAllManifest(config, since);
    const persisted = manifestEtagsSnapshot();
    expect(Object.values(persisted)).toEqual(['W/"abc"']);

    // Simulate a brand-new process that loaded state.json.
    __resetManifestEtagsForTesting();
    primeManifestEtags(persisted);
    await expect(fetchAllManifest(config, since)).resolves.toEqual([]);
    expect(seen).toEqual([null, 'W/"abc"']);
  });

  it('ignores junk from a hand-edited state.json', () => {
    primeManifestEtags(null);
    primeManifestEtags([1, 2, 3]);
    primeManifestEtags({ 'https://x/manifest?a=1': 42, 'https://x/manifest?b=1': '' });
    expect(manifestEtagsSnapshot()).toEqual({});
  });

  it('never replays a validator against a different endpoint', async () => {
    const seen: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers.get('If-None-Match'));
      return Promise.resolve(
        jsonRes({ items: [entry], nextCursor: null, count: 1 }, { ETag: 'W/"abc"' }),
      );
    });

    const since = '2025-12-31T00:00:00.000Z';
    await fetchAllManifest(config, since);
    await fetchAllManifest({ ...config, endpoint: 'https://staging.example.com/api' }, since);
    expect(seen).toEqual([null, null]);
  });

  it('never replays a validator after the globs change', async () => {
    const seen: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers.get('If-None-Match'));
      return Promise.resolve(
        jsonRes({ items: [entry], nextCursor: null, count: 1 }, { ETag: 'W/"abc"' }),
      );
    });

    const since = '2025-12-31T00:00:00.000Z';
    await fetchAllManifest(config, since);
    await fetchAllManifest({ ...config, include: ['sprites/**'] }, since);
    await fetchAllManifest({ ...config, exclude: ['raw/**'] }, since);
    expect(seen).toEqual([null, null, null]);
  });
});
