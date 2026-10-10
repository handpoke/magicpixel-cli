/**
 * Monorepo workspaces: one `magicpixel.json` at the root syncs several game
 * folders (Unity projects / packages). Each folder keeps the sprite names it
 * would have on its own, so moving to a workspace never re-uploads anything.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { detectEngineKind, isEngineKind, readWorkspaceMembers } from './framework.js';

const NOT_MEMBERS = new Set(['node_modules', 'library', 'temp', 'build', 'builds', 'logs', 'obj']);

/** Child folders of `root` that are game folders on their own. Sorted. */
export function detectWorkspaceMembers(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !NOT_MEMBERS.has(e.name.toLowerCase()))
      .filter((e) => isEngineKind(detectEngineKind(resolve(root, e.name))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Nearest ancestor (excluding `cwd`) that is a workspace root, or null. */
export function findWorkspaceRoot(cwd: string): string | null {
  let dir = dirname(resolve(cwd));
  for (let i = 0; i < 32; i++) {
    if (existsSync(resolve(dir, 'magicpixel.json')) && readWorkspaceMembers(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Re-anchor a game-folder glob at the workspace root. */
export function anchorGlob(member: string, glob: string): string {
  const g = glob.trim().replace(/^\.\//, '');
  return `${member}/${g}`;
}

/**
 * A path typed by the user, made relative to the setup folder. Commands run
 * inside a game folder of a monorepo work from the root, so `Runtime` typed in
 * `kr-core` means `kr-core/Runtime`.
 */
/** Resolve symlinks on the existing prefix so `/var` and `/private/var` compare equal. */
function canonical(p: string): string {
  const abs = resolve(p);
  const missing: string[] = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs;
    missing.push(basename(dir));
    dir = parent;
  }
  try {
    const real = realpathSync(dir);
    return missing.length === 0 ? real : resolve(real, ...missing.reverse());
  } catch {
    return abs;
  }
}

export function resolveInvokedPath(typed: string, cwd: string = process.cwd()): string {
  const from = process.env.MAGICPIXEL_INVOKED_FROM;
  if (!from || isAbsolute(typed)) return typed;
  return relative(canonical(cwd), canonical(resolve(from, typed))).replace(/\\/g, '/') || '.';
}

/**
 * Library folders don't include the game-folder name, so drop a leading
 * monorepo member (`kr-core/Runtime` → `Runtime`) before matching them.
 */
export function stripMemberSegment(segments: string[], cwd: string = process.cwd()): string[] {
  const members = readWorkspaceMembers(cwd);
  if (!members || segments.length < 2) return segments;
  const first = segments[0];
  return members.some((m) => m.toLowerCase() === first) ? segments.slice(1) : segments;
}
