import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for CLI 0.5.2.
 *
 * The asset-bytes writer in `sync.ts` MUST use a direct `writeFile` and not
 * route through `atomicWrite`. Reason: `atomicWrite` stages a tmp file
 * (`<name>.<pid>.<hex>.tmp`) and `rename()`s over the target. Vite's chokidar
 * watcher only collapses the resulting unlink/add pair for tmp filenames
 * starting with '.' or ending with '~' — ours matches neither, so the target
 * is observed as `add` (not `change`) and Vite does not re-push the new image
 * URL to the open browser. Users would have to hard-refresh to see freshly
 * synced assets (e.g. after renaming an artboard in MagicPixel).
 *
 * If a future refactor needs to reintroduce atomicity for asset bytes, it
 * MUST first switch the tmp-name pattern to something chokidar recognises
 * and verify HMR end-to-end in a consumer app.
 */
describe('sync asset writer uses direct writeFile (HMR contract)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'src', 'commands', 'sync.ts'), 'utf8');

  it('does not import atomicWrite into sync.ts', () => {
    expect(src).not.toMatch(/^import\s+\{[^}]*\batomicWrite\b[^}]*\}\s+from\s+['"][^'"]*atomicWrite/m);
  });

  it('does not call atomicWrite(...) anywhere in sync.ts', () => {
    expect(src).not.toMatch(/\batomicWrite\s*\(/);
  });

  it('writes asset bytes with writeFile(diskPath, bytes)', () => {
    expect(src).toMatch(/await\s+writeFile\(\s*diskPath\s*,\s*bytes\s*\)/);
  });
});
