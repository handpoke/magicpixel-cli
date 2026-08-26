/**
 * `magicpixel` is only the bin name — the published package is
 * `@magicpixelart/cli`. Printing `npx magicpixel <cmd>` to a user with no local
 * install sends them into a 404 dead end, so every hint goes through `cmd()`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { cmd, hasLocalInstall, resetInvokeCache } from '../src/util/invoke.js';

function projectWithLocalInstall(): string {
  const root = mkdtempSync(join(tmpdir(), 'mp-invoke-'));
  const pkgDir = join(root, 'node_modules', '@magicpixelart', 'cli');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@magicpixelart/cli', version: '0.0.0', main: 'index.js' }),
  );
  writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};');
  return root;
}

describe('cmd()', () => {
  beforeEach(() => resetInvokeCache());

  it('uses the full package form when nothing is installed locally', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mp-empty-'));
    expect(hasLocalInstall(empty)).toBe(false);
    resetInvokeCache();
    expect(cmd('init', empty)).toBe('npx @magicpixelart/cli init');
  });

  it('uses the short bin form when the package resolves from the project', () => {
    const root = projectWithLocalInstall();
    expect(hasLocalInstall(root)).toBe(true);
    resetInvokeCache();
    expect(cmd('login', root)).toBe('magicpixel login');
  });

  it('handles the bare invocation', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mp-empty2-'));
    expect(cmd('', empty)).toBe('npx @magicpixelart/cli');
  });

  it('memoizes the probe until reset', () => {
    const root = projectWithLocalInstall();
    expect(cmd('sync', root)).toBe('magicpixel sync');
    // Second call with a different cwd must reuse the cached answer.
    expect(cmd('sync', mkdtempSync(join(tmpdir(), 'mp-other-')))).toBe('magicpixel sync');
    resetInvokeCache();
    expect(cmd('sync', mkdtempSync(join(tmpdir(), 'mp-other2-')))).toBe('npx @magicpixelart/cli sync');
  });
});

describe('source hints', () => {
  const SRC = new URL('../src/', import.meta.url).pathname;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
  }

  const files = walk(SRC);

  it('never emits a bare `npx magicpixel <cmd>` string', () => {
    const offenders = files.filter((f) => /npx magicpixel /.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('routes user-facing command hints through cmd()', () => {
    // Backticked `magicpixel <subcommand>` in a runtime string is a hardcoded
    // hint; comments and help text (commander sets the program name) are fine.
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith('/index.ts')) continue; // commander help/examples
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (/^(\*|\/\/|\/\*)/.test(trimmed)) return;
        if (/`magicpixel (init|login|sync|push|start|doctor|repair|status|add|remove|list|whoami)\b/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
