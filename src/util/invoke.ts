/**
 * How should we tell the user to run a subcommand?
 *
 * `magicpixel` is only the BIN name; the published package is
 * `@magicpixelart/cli`. So npx-ing the bin name directly (e.g. `magicpixel init` via npx) 404s in a
 * project with no local install ("'magicpixel@*' is not in this registry"), which is a dead end
 * for anyone driving the CLI purely through `npx @magicpixelart/cli …`.
 *
 * Rule: if the package resolves from the project's node_modules, the bin is on
 * the PATH for `npx`/scripts and the short `magicpixel <cmd>` form works.
 * Otherwise we print the always-correct `npx @magicpixelart/cli <cmd>` form.
 * When in doubt we prefer the long form — it works in both worlds.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export const PKG_NAME = '@magicpixelart/cli';

let cachedLocal: boolean | null = null;

/** True when `@magicpixelart/cli` is installed in the current project. */
export function hasLocalInstall(cwd: string = process.cwd()): boolean {
  if (cachedLocal !== null) return cachedLocal;
  let local = false;
  try {
    // Resolve as if requiring from <cwd>/index.js so only the project's
    // node_modules chain counts — not the npx cache this process runs from.
    const req = createRequire(resolve(cwd, 'index.js'));
    req.resolve(`${PKG_NAME}/package.json`);
    local = true;
  } catch {
    local = false;
  }
  cachedLocal = local;
  return local;
}

/** Reset the memoized probe (tests only). */
export function resetInvokeCache(): void {
  cachedLocal = null;
}

/**
 * Format a runnable command hint, e.g. `cmd('login')` →
 * "npx @magicpixelart/cli login" or "magicpixel login".
 */
export function cmd(subcommand: string, cwd?: string): string {
  const suffix = subcommand ? ` ${subcommand}` : '';
  return hasLocalInstall(cwd) ? `magicpixel${suffix}` : `npx ${PKG_NAME}${suffix}`;
}
