import { describe, expect, it } from 'vitest';
import { keyInScope, normalizeScopeFolder, pathInScope, resolveSyncScope, scopeFingerprint } from '../src/util/syncScope.js';

describe('sync --only scope', () => {
  it('normalizes leading slash, backslashes and trailing /**', () => {
    expect(normalizeScopeFolder('/Runtime/Sprites/Entities/decorations/**')).toBe('Runtime/Sprites/Entities/decorations');
    expect(normalizeScopeFolder('Runtime\\Sprites\\')).toBe('Runtime/Sprites');
    expect(normalizeScopeFolder('./Runtime/Icons/')).toBe('Runtime/Icons');
  });

  it('returns null with no folders so unscoped sync is unchanged', () => {
    expect(resolveSyncScope(undefined)).toBeNull();
    expect(resolveSyncScope(['', '/'])).toBeNull();
  });

  const scope = resolveSyncScope(['/Runtime/Sprites/Entities/decorations'])!;

  it('matches game paths by folder prefix, case-insensitively, not by name prefix', () => {
    expect(pathInScope(scope, 'Runtime/Sprites/Entities/decorations/statue.png')).toBe(true);
    expect(pathInScope(scope, 'runtime/sprites/entities/Decorations/a/b.png')).toBe(true);
    expect(pathInScope(scope, 'Runtime/Sprites/Entities/decorations2/x.png')).toBe(false);
    expect(pathInScope(scope, 'Runtime/Sprites/Icons/lock.png')).toBe(false);
  });

  it('uses the game path when known, otherwise the library folder key', () => {
    expect(keyInScope(scope, 'whatever/doc/art', 'Runtime/Sprites/Entities/decorations/x.png')).toBe(true);
    expect(keyInScope(scope, 'runtime/sprites/entities/decorations/statue/statue')).toBe(true);
    expect(keyInScope(scope, 'runtime/sprites/icons/lock/lock')).toBe(false);
    expect(keyInScope(scope, 'runtime/sprites/icons/lock/lock', 'Runtime/Sprites/Icons/lock.png')).toBe(false);
  });

  it('fingerprint is order-independent and undefined when unscoped', () => {
    expect(scopeFingerprint(resolveSyncScope(['B', 'a']))).toBe(scopeFingerprint(resolveSyncScope(['a', 'b'])));
    expect(scopeFingerprint(null)).toBeUndefined();
  });
});
