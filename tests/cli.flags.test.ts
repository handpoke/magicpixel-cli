import { describe, expect, it } from 'vitest';
import { parseWatchInterval, parseConcurrency } from '../src/util/flagValidators.js';

/**
 * Pin the commander validator contract for `sync --watch` and `sync -c`.
 * Previously the watch min disagreed with the loop's internal floor (1 vs
 * 2), silently coercing `--watch 1` to 2 without a warning. Both now say 2.
 */

describe('parseWatchInterval', () => {
  it('accepts the lower bound (2)', () => {
    expect(parseWatchInterval('2')).toBe('2');
  });

  it('accepts the upper bound (3600)', () => {
    expect(parseWatchInterval('3600')).toBe('3600');
  });

  it('rejects 1 with a 2–3600 message', () => {
    expect(() => parseWatchInterval('1')).toThrow(/expected an integer/);
    try {
      parseWatchInterval('1');
    } catch (e) {
      expect((e as Error).message).toMatch(/2.{0,3}3600/);
    }
  });

  it('rejects 0 and negative values', () => {
    expect(() => parseWatchInterval('0')).toThrow(/expected an integer/);
    expect(() => parseWatchInterval('-1')).toThrow(/expected an integer/);
  });

  it('rejects 3601 (out of range)', () => {
    expect(() => parseWatchInterval('3601')).toThrow(/expected an integer/);
  });

  it('rejects non-integers', () => {
    expect(() => parseWatchInterval('abc')).toThrow(/expected an integer/);
    expect(() => parseWatchInterval('2.5')).toThrow(/expected an integer/);
    expect(() => parseWatchInterval(' 2 ')).not.toThrow();  // trimmed
  });

  it('passes booleans through (bare `-w` form)', () => {
    expect(parseWatchInterval(true)).toBe(true);
  });
});

describe('parseConcurrency', () => {
  it('accepts 1 and 16', () => {
    expect(parseConcurrency('1')).toBe(1);
    expect(parseConcurrency('16')).toBe(16);
  });

  it('rejects 0 and 17', () => {
    expect(() => parseConcurrency('0')).toThrow(/expected an integer/);
    expect(() => parseConcurrency('17')).toThrow(/expected an integer/);
  });

  it('rejects non-integers', () => {
    expect(() => parseConcurrency('abc')).toThrow(/expected an integer/);
  });
});
