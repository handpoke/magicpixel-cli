import { describe, expect, it } from 'vitest';
import { validateEndpointUrl } from '../src/util/security.js';

/**
 * `validateEndpointUrl` is the gate on every user-supplied custom endpoint.
 * It must:
 *   - require HTTPS in production
 *   - reject embedded credentials (no `user:pass@host`)
 *   - normalize the base: strip query/hash, strip trailing slashes
 *   - allow http://localhost only with MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1
 */
describe('validateEndpointUrl', () => {
  it('accepts plain HTTPS URLs unchanged', () => {
    expect(validateEndpointUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('strips trailing slashes from the pathname (preserves the empty root)', () => {
    expect(validateEndpointUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(validateEndpointUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
    expect(validateEndpointUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(validateEndpointUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  it('strips query strings and fragments', () => {
    expect(validateEndpointUrl('https://api.example.com/v1?token=x#frag')).toBe('https://api.example.com/v1');
  });

  it('rejects embedded credentials', () => {
    expect(() => validateEndpointUrl('https://user:pass@api.example.com')).toThrow(/credentials/i);
  });

  it('rejects non-HTTPS unless MAGICPIXEL_ALLOW_INSECURE_ENDPOINT is set', () => {
    const prior = process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
    delete process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
    try {
      expect(() => validateEndpointUrl('http://api.example.com')).toThrow(/HTTPS/);
      expect(() => validateEndpointUrl('http://localhost:54321')).toThrow(/HTTPS/);
    } finally {
      if (prior !== undefined) process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT = prior;
    }
  });

  it('allows http://localhost when MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1', () => {
    const prior = process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
    process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT = '1';
    try {
      expect(validateEndpointUrl('http://localhost:54321/api')).toBe('http://localhost:54321/api');
      expect(validateEndpointUrl('http://127.0.0.1:54321/api/')).toBe('http://127.0.0.1:54321/api');
      // Non-localhost http still rejected even with the escape hatch.
      expect(() => validateEndpointUrl('http://api.example.com')).toThrow(/HTTPS/);
    } finally {
      if (prior === undefined) delete process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
      else process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT = prior;
    }
  });

  it('rejects malformed input', () => {
    expect(() => validateEndpointUrl('not a url')).toThrow(/valid URL/);
    expect(() => validateEndpointUrl('')).toThrow();
  });

  it('rejects non-http(s) schemes with a clear message', () => {
    // Explicit allowlist — file:, data:, javascript:, ws: should be rejected
    // up-front rather than falling through the generic HTTPS branch.
    expect(() => validateEndpointUrl('file:///etc/passwd')).toThrow(/not allowed/i);
    expect(() => validateEndpointUrl('data:text/plain,hello')).toThrow(/not allowed/i);
    expect(() => validateEndpointUrl('javascript:alert(1)')).toThrow(/not allowed/i);
    expect(() => validateEndpointUrl('ws://api.example.com')).toThrow(/not allowed/i);
  });
});
