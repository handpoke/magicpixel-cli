/**
 * Engine projects sync every game PNG by default. `connect` is only for
 * narrowing that set — users should not have to type `connect '**'`.
 */
import type { MagicPixelConfig } from '../config.js';
import { saveConfig } from '../config.js';
import { detectProjectKind, isEngineKind } from './framework.js';

export const DEFAULT_ENGINE_CONNECT = ['**'];

const ALL_SPRITES_GLOBS = new Set(['**', '**/*', '**/**', '**/*.png', '**/**/*.png']);

export function isAllSpritesGlob(glob: string): boolean {
  return ALL_SPRITES_GLOBS.has(glob.trim());
}

/**
 * Next `connect` list after the user adds a glob.
 * A specific folder replaces a default `**` (narrowing). `**` restores all
 * sprites. Other globs accumulate. Stray `**` left over from an earlier
 * default is dropped when narrowing so OR-matching cannot keep everything.
 */
export function nextConnectGlobs(current: readonly string[], pattern: string): string[] {
  if (isAllSpritesGlob(pattern)) return [...DEFAULT_ENGINE_CONNECT];
  const withoutAll = current.filter((g) => !isAllSpritesGlob(g));
  if (withoutAll.includes(pattern)) return withoutAll;
  return [...withoutAll, pattern];
}

export async function ensureEngineConnect(
  config: MagicPixelConfig,
  cwd: string = process.cwd(),
  persist = true,
): Promise<MagicPixelConfig> {
  if (config.connect.length > 0) return config;
  const kind = await detectProjectKind(cwd);
  if (!isEngineKind(kind)) return config;
  const next: MagicPixelConfig = { ...config, connect: [...DEFAULT_ENGINE_CONNECT] };
  if (persist) await saveConfig(next, cwd);
  return next;
}
