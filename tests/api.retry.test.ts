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

  it('retries 5xx up to 3 attempts then throws the last error', async () => {
    const err = new ApiError(503, 'down', 'req-2');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryTransient('ctx', fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries 429 and eventually returns success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, 'slow down', 'req-3'))
      .mockResolvedValueOnce('ok');
    await expect(retryTransient('ctx', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors retryAfterMs over the default backoff', async () => {
    const err = new ApiError(429, 'slow', 'req-4', 500);
    let attempts = 0;
    const start = Date.now();
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw err;
      return 'ok';
    });
    await expect(retryTransient('ctx', fn)).resolves.toBe('ok');
    // retryAfterMs (500) wins over the default 250ms backoff on attempt 1.
    expect(Date.now() - start).toBeGreaterThanOrEqual(450);
  });

  it('wraps non-ApiError network failures with a friendly hint', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(retryTransient('manifest', fn)).rejects.toThrow(/network error/);
    await expect(retryTransient('manifest', fn)).rejects.toThrow(/Fix:/);
    // 3 attempts × 2 invocations above = 6 total.
    expect(fn).toHaveBeenCalledTimes(6);
  });
});
