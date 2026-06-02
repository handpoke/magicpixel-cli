import { describe, expect, it } from 'vitest';
import { friendlyFsError, isFsPermissionError } from '../src/util/errors.js';

function makeErrnoError(code: string, msg = 'mock fs error'): NodeJS.ErrnoException {
  const e = new Error(msg) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('isFsPermissionError', () => {
  it('recognizes EACCES / EPERM / EROFS / EBUSY / ETXTBSY', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'ETXTBSY']) {
      expect(isFsPermissionError(makeErrnoError(code))).toBe(true);
    }
  });

  it('rejects unrelated errors', () => {
    expect(isFsPermissionError(makeErrnoError('ENOENT'))).toBe(false);
    expect(isFsPermissionError(new Error('not errno'))).toBe(false);
    expect(isFsPermissionError(null)).toBe(false);
    expect(isFsPermissionError(undefined)).toBe(false);
    expect(isFsPermissionError('string')).toBe(false);
  });
});

describe('friendlyFsError', () => {
  const ctx = { operation: 'Writing asset', path: '/tmp/foo.png', hint: 'extra hint here' };

  it('wraps EACCES with a chmod hint and the call-site hint', () => {
    const wrapped = friendlyFsError(makeErrnoError('EACCES'), ctx);
    expect(wrapped.message).toContain('Writing asset failed (EACCES):');
    expect(wrapped.message).toContain('chmod -R u+w');
    expect(wrapped.message).toContain('extra hint here');
  });

  it('wraps EROFS with a read-only filesystem hint', () => {
    const wrapped = friendlyFsError(makeErrnoError('EROFS'), ctx);
    expect(wrapped.message).toContain('read-only filesystem');
    expect(wrapped.message).not.toContain('chmod');
  });

  it('wraps EBUSY with a "close editor" hint', () => {
    const wrapped = friendlyFsError(makeErrnoError('EBUSY'), ctx);
    expect(wrapped.message).toContain('close any editor');
    expect(wrapped.message).toContain('OneDrive/Dropbox');
  });

  it('passes non-FS errors through unchanged', () => {
    const plain = new Error('totally unrelated');
    expect(friendlyFsError(plain, ctx)).toBe(plain);
  });

  it('coerces non-Error throws to an Error', () => {
    const wrapped = friendlyFsError('something weird', ctx);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('something weird');
  });

  it('omits the call-site hint when not provided', () => {
    const wrapped = friendlyFsError(makeErrnoError('EACCES'), { operation: 'Op', path: '/x' });
    expect(wrapped.message).toContain('Op failed (EACCES):');
    expect(wrapped.message).not.toContain('undefined');
  });
});
