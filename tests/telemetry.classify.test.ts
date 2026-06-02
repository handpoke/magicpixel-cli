import { describe, expect, it } from 'vitest';
import { shouldReportCliError } from '../src/util/telemetry.js';
import { ApiError } from '../src/api.js';

describe('shouldReportCliError', () => {
  it('reports 5xx ApiErrors', () => {
    expect(shouldReportCliError(new ApiError(500, 'boom'))).toBe(true);
    expect(shouldReportCliError(new ApiError(503, 'down'))).toBe(true);
  });

  it('skips 4xx ApiErrors (user-fixable)', () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(shouldReportCliError(new ApiError(status, 'nope'))).toBe(false);
    }
  });

  it('skips commander argument errors', () => {
    const e = new Error('expected an integer');
    e.name = 'InvalidArgumentError';
    expect(shouldReportCliError(e)).toBe(false);
    const c = new Error('bad opt');
    c.name = 'CommanderError';
    expect(shouldReportCliError(c)).toBe(false);
  });

  it('skips known user-fixable messages', () => {
    expect(shouldReportCliError(new Error('No magicpixel.json found in /x'))).toBe(false);
    expect(shouldReportCliError(new Error('No MagicPixel API key found.'))).toBe(false);
    expect(shouldReportCliError(new Error('MagicPixel API key does not look right'))).toBe(false);
  });

  it('skips fs perm/missing errors', () => {
    expect(shouldReportCliError(new Error('EACCES: permission denied'))).toBe(false);
    expect(shouldReportCliError(new Error('ENOENT: no such file'))).toBe(false);
    expect(shouldReportCliError(new Error('EPERM: operation not permitted'))).toBe(false);
  });

  it('reports generic unexpected throws', () => {
    expect(shouldReportCliError(new Error('Cannot read properties of undefined'))).toBe(true);
    expect(shouldReportCliError(new TypeError('x is not a function'))).toBe(true);
  });

  it('rejects non-Error values', () => {
    expect(shouldReportCliError('string')).toBe(false);
    expect(shouldReportCliError(null)).toBe(false);
    expect(shouldReportCliError({ message: 'oops' })).toBe(false);
  });
});
