import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `whoami` must shape-guard the manifest response the same way
 * `fetchAllManifest` does — a malformed `{ items: null }` body used to
 * throw TypeError on `body.items[0]?.key`. Now it reports "0 assets".
 */

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.MAGICPIXEL_API_KEY;

beforeEach(() => {
  process.env.MAGICPIXEL_API_KEY = 'mp_live_' + 'a'.repeat(64);
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.MAGICPIXEL_API_KEY;
  else process.env.MAGICPIXEL_API_KEY = ORIG_KEY;
  vi.restoreAllMocks();
});

function mockJson(body: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'rid-test' },
    }),
  ) as typeof fetch;
}

describe('whoami shape guard', () => {
  it('tolerates items: null without throwing', async () => {
    mockJson({ count: 0, items: null, nextCursor: null });
    const { whoamiCommand } = await import('../src/commands/whoami.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    await whoamiCommand();
    spy.mockRestore();
    expect(process.exitCode === 1).toBe(false);
    expect(logs.join('\n')).toMatch(/key valid/);
  });

  it('tolerates entries missing a `key` field', async () => {
    mockJson({ count: 2, items: [{ key: 'sprites/hero.png' }, { foo: 'bar' }], nextCursor: null });
    const { whoamiCommand } = await import('../src/commands/whoami.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    await whoamiCommand();
    spy.mockRestore();
    expect(logs.join('\n')).toMatch(/sprites\/hero\.png/);
  });

  it('coerces non-string nextCursor to null', async () => {
    mockJson({ count: 1, items: [{ key: 'a.png' }], nextCursor: 12345 });
    const { whoamiCommand } = await import('../src/commands/whoami.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    await whoamiCommand();
    spy.mockRestore();
    // No trailing "+" since nextCursor was discarded.
    expect(logs.join('\n')).not.toMatch(/1\+/);
  });



  it('clamps a negative count to 0 (defensive — a malformed server response must not print "visible: -5")', async () => {
    mockJson({ count: -5, items: [], nextCursor: null });
    const { whoamiCommand } = await import('../src/commands/whoami.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    await whoamiCommand();
    spy.mockRestore();
    const joined = logs.join('\n');
    expect(joined).not.toMatch(/-\d/);
    expect(joined).toMatch(/0 assets/);
  });
});
