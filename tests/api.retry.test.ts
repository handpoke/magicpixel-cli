import { describe, expect, it, vi } from 'vitest';
import { ApiError, retryTransient } from '../src/api.js';

describe('retryTransient', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retryTransient('ctx', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('bubbles non-retryable 4xx ApiErrors immediately', async () => {
    const err = new ApiError(404, 'not found', 'req-1');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryTransient('ctx', fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx up to 5 attempts then throws the last error', async () => {
    const err = new ApiError(503, 'down', 'req-2');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryTransient('ctx', fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(5);
  }, 15_000);

  it('retries 429 and eventually returns success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, 'slow down', 'req-3'))
      .mockResolvedValueOnce('ok');
    await expect(retryTransient('ctx', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors retryAfterMs over the default backoff', async () => {
    // Default backoff on attempt 1 is now 500ms; use a retryAfterMs above that
    // so we can prove the header wins.
    const err = new ApiError(429, 'slow', 'req-4', 900);
    let attempts = 0;
    const start = Date.now();
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw err;
      return 'ok';
    });
    await expect(retryTransient('ctx', fn)).resolves.toBe('ok');
    expect(Date.now() - start).toBeGreaterThanOrEqual(850);
  });

  it('absorbs a transient 546 edge-worker blip and returns success', async () => {
    // Simulates a Supabase edge worker recycle: two 546s then healthy.
    const start = Date.now();
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts <= 2) throw new ApiError(546, 'boot', 'req-546');
      return 'ok';
    });
    await expect(retryTransient('manifest', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    // Backoff of 500ms + 1000ms = 1500ms minimum before the 3rd attempt.
    expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
  }, 15_000);

  it('wraps non-ApiError network failures with a friendly hint', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(retryTransient('manifest', fn)).rejects.toThrow(/network error/);
    await expect(retryTransient('manifest', fn)).rejects.toThrow(/Fix:/);
    // 5 attempts × 2 invocations above = 10 total.
    expect(fn).toHaveBeenCalledTimes(10);
  }, 30_000);

  it('gives a persistent 546 extra attempts only when asked (manifest)', async () => {
    const noop = async () => {};
    const boot = new ApiError(546, 'boot', 'req-546-long');
    const fn546 = vi.fn().mockRejectedValue(boot);
    await expect(retryTransient('manifest', fn546, { sleep: noop, max546Attempts: 7 })).rejects.toBe(boot);
    expect(fn546).toHaveBeenCalledTimes(7);

    const fn546default = vi.fn().mockRejectedValue(boot);
    await expect(retryTransient('download', fn546default, noop)).rejects.toBe(boot);
    expect(fn546default).toHaveBeenCalledTimes(5);

    const down = new ApiError(503, 'down', 'req-503');
    const fn503 = vi.fn().mockRejectedValue(down);
    await expect(retryTransient('ctx', fn503, noop)).rejects.toBe(down);
    expect(fn503).toHaveBeenCalledTimes(5);
  });
});
