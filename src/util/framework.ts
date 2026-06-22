import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type ProjectKind =
  | 'Next.js'
  | 'Vite'
  | 'Remix'
  | 'TanStack Start'
  | 'Create React App'
  | 'Astro'
  | 'Nuxt'
  | 'SvelteKit'
  | 'Unity'
  | 'Godot'
  | 'GameMaker'
  | null;

/** @deprecated alias — existing imports keep compiling */
export type Framework = ProjectKind;

const ENGINE_KINDS = new Set<string>(['Unity', 'Godot', 'GameMaker']);

export function isEngineKind(kind: ProjectKind): kind is 'Unity' | 'Godot' | 'GameMaker' {
  return kind !== null && ENGINE_KINDS.has(kind);
}

/** Typed `index.ts` is JS-only — game engines load PNGs directly. */
export function supportsTypedIndex(kind: ProjectKind): boolean {
  return !isEngineKind(kind);
}

async function detectJsKind(cwd: string): Promise<ProjectKind> {
  try {
    const pkgPath = resolve(cwd, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next']) return 'Next.js';
    if (deps['@tanstack/start']) return 'TanStack Start';
    if (deps['@remix-run/react']) return 'Remix';
    if (deps['vite']) return 'Vite';
    if (deps['react-scripts']) return 'Create React App';
    if (deps['astro']) return 'Astro';
    if (deps['nuxt']) return 'Nuxt';
    if (deps['@sveltejs/kit']) return 'SvelteKit';
    return null;
  } catch {
    return null;
  }
}

function detectEngineKind(cwd: string): ProjectKind {
  if (existsSync(resolve(cwd, 'project.godot'))) return 'Godot';
  if (existsSync(resolve(cwd, 'ProjectSettings', 'ProjectVersion.txt'))) return 'Unity';
  try {
    const yyp = readdirSync(cwd).find((name) => name.endsWith('.yyp'));
    if (yyp) return 'GameMaker';
  } catch {
    // unreadable cwd — treat as no engine marker
  }
  return null;
}

/** Infer project kind from package.json deps, then engine marker files. */
export async function detectProjectKind(cwd: string = process.cwd()): Promise<ProjectKind> {
  const js = await detectJsKind(cwd);
  if (js) return js;
  return detectEngineKind(cwd);
}

/** @deprecated use `detectProjectKind` */
export async function detectFramework(cwd: string = process.cwd()): Promise<Framework> {
  return detectProjectKind(cwd);
}

/** Default `outDir` for a detected project kind. */
export function suggestOutDir(kind: ProjectKind, cwd: string = process.cwd()): string {
  switch (kind) {
    case 'Next.js':
    case 'Astro':
    case 'Nuxt':
    case 'Create React App':
      return 'public/magicpixel';
    case 'SvelteKit':
      return 'static/magicpixel';
    case 'Vite':
    case 'Remix':
    case 'TanStack Start':
      return 'src/assets/magicpixel';
    case 'Unity':
      return 'Assets/MagicPixel';
    case 'Godot':
      return 'assets/magicpixel';
    case 'GameMaker':
      return 'datafiles/magicpixel';
    default:
      // No kind detected — prefer src/ if present so the typed index is
      // importable; otherwise fall back to a top-level assets/ dir.
      return existsSync(resolve(cwd, 'src')) ? 'src/assets/magicpixel' : 'assets/magicpixel';
  }
}

export function hasPackageJson(cwd: string = process.cwd()): boolean {
  return existsSync(resolve(cwd, 'package.json'));
}

/**
 * True when `outDir` lives under `public/` or `static/` — these dirs are
 * served as-is by frameworks (Next/Astro/Nuxt/CRA/SvelteKit) and cannot be
 * `import`ed by a bundler. Shared by `init` (skip typed index) and
 * `emitIndex` (emit absolute-URL AGENTS.md snippet instead of an import).
 */
export function isStaticOutDir(outDir: string): boolean {
  const norm = outDir.replace(/\\/g, '/').replace(/^\.\//, '');
  return /^(public|static)(\/|$)/.test(norm);
}
