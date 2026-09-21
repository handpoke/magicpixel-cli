import { describe, it, expect } from 'vitest';
import {
  classifyTickError,
  formatQuotaReset,
  QUOTA_RECHECK_MAX_SEC,
  type TickErrorState,
} from '../src/commands/sync.js';
import { ApiError, DAILY_QUOTA_ERROR_CODE } from '../src/api.js';

const base: TickErrorState = {
  backoffSec: 2,
  pausedForAuth: false,
  pausedForNetwork: false,
  pausedForQuota: false,
  consecutiveAuthFailures: 0,
  maxAuthFailures: 5,
};

describe('classifyTickError', () => {
  it('classifies 401 as auth and increments the counter', () => {
    const d = classifyTickError(new ApiError(401, 'nope', 'rid-1'), base);
    expect(d.kind).toBe('auth');
    if (d.kind !== 'auth') throw new Error('unreachable');
    expect(d.consecutiveAuthFailures).toBe(1);
    expect(d.nextBackoffSec).toBe(30);
    expect(d.giveUp).toBe(false);
  });

  it('flags giveUp on the Nth consecutive auth failure', () => {
    const d = classifyTickError(new ApiError(403, 'forbidden', 'rid-2'), {
      ...base,
      consecutiveAuthFailures: 4, // next tick will be the 5th
    });
    if (d.kind !== 'auth') throw new Error('unreachable');
    expect(d.consecutiveAuthFailures).toBe(5);
    expect(d.giveUp).toBe(true);
  });

  it('treats ENOTFOUND-style errors as network and doubles backoff', () => {
    const d = classifyTickError(new Error('manifest: network error (ENOTFOUND magicpixel.art)'), {
      ...base,
      backoffSec: 4,
    });
    expect(d.kind).toBe('network');
    if (d.kind !== 'network') throw new Error('unreachable');
    expect(d.nextBackoffSec).toBe(8);
    expect(d.printMessage).toBe(true); // first offline tick
  });

  it('suppresses the network message when paused and backoff has plateaued at 60s', () => {
    const d = classifyTickError(new Error('fetch failed'), {
      ...base,
      backoffSec: 60,
      pausedForNetwork: true,
    });
    if (d.kind !== 'network') throw new Error('unreachable');
    expect(d.nextBackoffSec).toBe(60);
    expect(d.printMessage).toBe(false);
  });

  it('prints the network message on every backoff transition (not just the first)', () => {
    const d = classifyTickError(new Error('ECONNRESET'), {
      ...base,
      backoffSec: 8,
      pausedForNetwork: true,
    });
    if (d.kind !== 'network') throw new Error('unreachable');
    expect(d.nextBackoffSec).toBe(16);
    expect(d.printMessage).toBe(true);
  });

  it('classifies arbitrary errors as "other" without touching the auth counter', () => {
    const d = classifyTickError(new Error('something went sideways'), {
      ...base,
      backoffSec: 4,
      consecutiveAuthFailures: 3,
    });
    expect(d.kind).toBe('other');
    expect(d.nextBackoffSec).toBe(8);
  });

  it('caps backoff at 60 seconds', () => {
    const d = classifyTickError(new Error('fetch failed'), { ...base, backoffSec: 45 });
    if (d.kind !== 'network') throw new Error('unreachable');
    expect(d.nextBackoffSec).toBe(60);
  });

  const quotaErr = (retryAfterMs: number) =>
    new ApiError(429, 'Daily API allowance reached.', 'rid-q', retryAfterMs, DAILY_QUOTA_ERROR_CODE);

  it('classifies the daily allowance as quota and waits quietly, capped at the recheck ceiling', () => {
    const d = classifyTickError(quotaErr(4 * 60 * 60 * 1000), base);
    expect(d.kind).toBe('quota');
    if (d.kind !== 'quota') throw new Error('unreachable');
    expect(d.nextBackoffSec).toBe(QUOTA_RECHECK_MAX_SEC);
    expect(d.resetSec).toBe(4 * 60 * 60);
    expect(d.printMessage).toBe(true); // first exhausted tick
  });

  it('never waits past the reset moment', () => {
    const d = classifyTickError(quotaErr(120_000), base);
    if (d.kind !== 'quota') throw new Error('unreachable');
    expect(d.nextBackoffSec).toBe(120);
  });

  it('says it once — repeat ticks stay silent', () => {
    const d = classifyTickError(quotaErr(3_600_000), { ...base, pausedForQuota: true });
    if (d.kind !== 'quota') throw new Error('unreachable');
    expect(d.printMessage).toBe(false);
  });
});

describe('formatQuotaReset', () => {
  it('renders minutes under an hour and h/mm above it', () => {
    expect(formatQuotaReset(90)).toBe('2 min');
    expect(formatQuotaReset(42 * 60)).toBe('42 min');
    expect(formatQuotaReset(3 * 3600 + 5 * 60)).toBe('3h 05m');
  });

  it('never reports zero', () => {
    expect(formatQuotaReset(0)).toBe('1 min');
  });
});
