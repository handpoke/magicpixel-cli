import { describe, expect, it } from 'vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPathInsideRoot,
  assertSafeAssetSegments,
  assertSafeGlob,
  assertSafeIoPath,
  assertSafeOutDir,
  safeFetch,
  sanitizeSourceRel,
  validateEndpointUrl,
} from '../src/util/security.js';

describe('assertSafeAssetSegments', () => {
  it('accepts normal folder/slug', () => {
    expect(() => assertSafeAssetSegments('items', 'tree', 'items/tree')).not.toThrow();
    expect(() => assertSafeAssetSegments('items/sub', 'tree', 'items/sub/tree')).not.toThrow();
    expect(() => assertSafeAssetSegments(null, 'tree', 'tree')).not.toThrow();
  });
  it('rejects parent-traversal segments', () => {
    expect(() => assertSafeAssetSegments('..', 'tree', '../tree')).toThrow(/unsafe/);
    expect(() => assertSafeAssetSegments('items', '..', 'items/..')).toThrow(/unsafe/);
    expect(() => assertSafeAssetSegments('a/../b', 'tree', 'a/../b/tree')).toThrow(/unsafe/);
  });
  it('rejects empty / dot / backslash / null-byte segments', () => {
    expect(() => assertSafeAssetSegments('', 'tree', '/tree')).toThrow(/unsafe/);
    expect(() => assertSafeAssetSegments('.', 'tree', './tree')).toThrow(/unsafe/);
    expect(() => assertSafeAssetSegments('items', 'bad\\name', 'items/bad\\name')).toThrow(/unsafe/);
    expect(() => assertSafeAssetSegments('items', 'bad\0name', 'items/bad\0name')).toThrow(/unsafe/);
  });
});

describe('validateEndpointUrl', () => {
  const originalAllow = process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
  afterEach(() => {
    if (originalAllow === undefined) delete process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
    else process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT = originalAllow;
  });

  it('accepts https URLs and strips trailing slash + query', () => {
    expect(validateEndpointUrl('https://example.com/api/')).toBe('https://example.com/api');
    expect(validateEndpointUrl('https://x.test/a?b=1#c')).toBe('https://x.test/a');
  });
  it('rejects http URLs by default', () => {
    expect(() => validateEndpointUrl('http://example.com')).toThrow(/HTTPS/);
  });
  it('rejects URLs with embedded credentials', () => {
    expect(() => validateEndpointUrl('https://user:pass@example.com')).toThrow(/credentials/);
  });
  it('accepts http://localhost only when MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1', () => {
    delete process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT;
    expect(() => validateEndpointUrl('http://localhost:54321')).toThrow(/HTTPS/);
    process.env.MAGICPIXEL_ALLOW_INSECURE_ENDPOINT = '1';
    expect(validateEndpointUrl('http://localhost:54321')).toBe('http://localhost:54321');
    expect(validateEndpointUrl('http://127.0.0.1:54321/api')).toBe('http://127.0.0.1:54321/api');
    expect(() => validateEndpointUrl('http://evil.example.com')).toThrow(/HTTPS/);
  });
  it('rejects malformed URLs with a friendly message', () => {
    expect(() => validateEndpointUrl('not a url')).toThrow(/not a valid URL/);
  });
});

describe('assertPathInsideRoot', () => {
  it('accepts paths inside the root (including the root itself)', () => {
    expect(() => assertPathInsideRoot('/tmp/proj/a/b.png', '/tmp/proj', 'outDir')).not.toThrow();
    expect(() => assertPathInsideRoot('/tmp/proj', '/tmp/proj', 'outDir')).not.toThrow();
  });
  it('rejects paths outside the root', () => {
    expect(() => assertPathInsideRoot('/tmp/sibling/x.png', '/tmp/proj', 'outDir')).toThrow(/outside/);
    expect(() => assertPathInsideRoot('/tmp/proj/../sibling/x.png', '/tmp/proj', 'outDir')).toThrow(/outside/);
  });
});

describe('assertSafeGlob', () => {
  it('trims and accepts a normal glob', () => {
    expect(assertSafeGlob('  **/*  ')).toBe('**/*');
  });
  it('rejects empty / null-byte / oversized / parent-traversal globs', () => {
    expect(() => assertSafeGlob('')).toThrow(/invalid glob/);
    expect(() => assertSafeGlob('bad\0glob')).toThrow(/invalid glob/);
    expect(() => assertSafeGlob('x'.repeat(257))).toThrow(/invalid glob/);
    expect(() => assertSafeGlob('../Assets/**')).toThrow(/\.\./);
    expect(() => assertSafeGlob('Assets/../secret/**')).toThrow(/\.\./);
  });
});

describe('sanitizeSourceRel', () => {
  it('accepts a relative png and rejects traversal, absolute, and non-png', () => {
    expect(sanitizeSourceRel('Assets/Sprites/hero.png')).toBe('Assets/Sprites/hero.png');
    expect(sanitizeSourceRel('./Assets/hero.png')).toBe('Assets/hero.png');
    expect(sanitizeSourceRel('../outside.png')).toBeNull();
    expect(sanitizeSourceRel('Assets/../package.json')).toBeNull();
    expect(sanitizeSourceRel('Assets/Scripts/Player.cs')).toBeNull();
    expect(sanitizeSourceRel('/tmp/x.png')).toBeNull();
    expect(sanitizeSourceRel('C:\\Windows\\x.png')).toBeNull();
    expect(sanitizeSourceRel('foo//bar.png')).toBeNull();
  });
});

describe('assertSafeIoPath', () => {
  it('allows a regular file and a missing path whose parent stays in-root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-io-'));
    mkdirSync(join(root, 'Assets'));
    const png = join(root, 'Assets', 'hero.png');
    writeFileSync(png, 'x');
    await expect(assertSafeIoPath(png, root)).resolves.toBeUndefined();
    await expect(assertSafeIoPath(join(root, 'Assets', 'new.png'), root, { forWrite: true })).resolves.toBeUndefined();
  });

  it('refuses a symlink even when the lexical path is inside the project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-io-'));
    const outside = mkdtempSync(join(tmpdir(), 'mp-io-out-'));
    writeFileSync(join(outside, 'secret.png'), 'secret');
    const link = join(root, 'hero.png');
    try {
      symlinkSync(join(outside, 'secret.png'), link);
    } catch {
      return; // filesystem may not allow symlinks
    }
    await expect(assertSafeIoPath(link, root, { forWrite: true })).rejects.toThrow(/symlink/);
  });
});

describe('assertSafeOutDir', () => {
  it('trims and accepts a normal path', () => {
    expect(assertSafeOutDir('  src/assets/magicpixel  ')).toBe('src/assets/magicpixel');
    expect(assertSafeOutDir('public/sprites')).toBe('public/sprites');
  });
  it('rejects empty input', () => {
    expect(() => assertSafeOutDir('')).toThrow(/empty/);
    expect(() => assertSafeOutDir('   ')).toThrow(/empty/);
  });
  it('rejects parent-traversal segments (forward and back slash)', () => {
    expect(() => assertSafeOutDir('../escape')).toThrow(/\.\./);
    expect(() => assertSafeOutDir('src/../../etc')).toThrow(/\.\./);
    expect(() => assertSafeOutDir('src\\..\\etc')).toThrow(/\.\./);
  });
  it('rejects null bytes', () => {
    expect(() => assertSafeOutDir('src/assets\0/x')).toThrow(/null bytes/);
  });
});

describe('safeFetch redirect handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses cross-origin redirects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/x' },
      }),
    );
    await expect(safeFetch('https://api.test/x')).rejects.toThrow(/cross-origin/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('follows same-origin redirects up to 5 hops then bails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(null, { status: 302, headers: { location: new URL('/next', url as string).href } }),
    );
    await expect(safeFetch('https://api.test/start')).rejects.toThrow(/too many HTTP redirects/);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('returns non-3xx responses directly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await safeFetch('https://api.test/x');
    expect(res.status).toBe(200);
  });
});
