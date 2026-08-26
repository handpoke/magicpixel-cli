import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

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

/**
 * Case-insensitive child lookup, preserving the on-disk name. `existsSync` of
 * a guessed `Assets` path is wrong on macOS (matches `assets` but keeps the
 * wrong casing).
 */
export function resolveChild(
  cwd: string,
  logicalName: string,
  opts: { directory?: boolean } = {},
): string | null {
  try {
    const want = logicalName.toLowerCase();
    for (const ent of readdirSync(cwd, { withFileTypes: true })) {
      if (ent.name.toLowerCase() !== want) continue;
      if (opts.directory && !ent.isDirectory()) continue;
      return resolve(cwd, ent.name);
    }
  } catch {
    /* unreadable cwd */
  }
  return null;
}

/** Case-insensitive child directory, preserving the on-disk name. */
export function resolveChildDir(cwd: string, logicalName: string): string | null {
  return resolveChild(cwd, logicalName, { directory: true });
}

function hasMetaSidecar(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.meta'));
  } catch {
    return false;
  }
}

function detectEngineKind(cwd: string): ProjectKind {
  if (existsSync(resolve(cwd, 'project.godot'))) return 'Godot';
  const projectSettings = resolveChildDir(cwd, 'ProjectSettings');
  if (projectSettings && resolveChild(projectSettings, 'ProjectVersion.txt')) return 'Unity';
  const packages = resolveChildDir(cwd, 'Packages');
  if (packages && resolveChild(packages, 'manifest.json')) return 'Unity';
  // Assets/assets only counts with Unity .meta sidecars — a generic `assets/`
  // folder in a Node repo is not a Unity project.
  const assets = resolveChildDir(cwd, 'Assets');
  if (assets && hasMetaSidecar(assets)) return 'Unity';
  // Embedded UPM package: Editor/Runtime plus root .meta (kr-core has no
  // ProjectSettings and often only a lowercase `assets` dump).
  if (hasMetaSidecar(cwd) && (resolveChildDir(cwd, 'Editor') || resolveChildDir(cwd, 'Runtime'))) {
    return 'Unity';
  }
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
      return suggestEngineOutDir(cwd, 'Assets', 'MagicPixel');
    case 'Godot':
      return suggestEngineOutDir(cwd, 'assets', 'magicpixel');
    case 'GameMaker':
      return suggestEngineOutDir(cwd, 'datafiles', 'magicpixel');
    default:
      // No kind detected — prefer src/ if present so the typed index is
      // importable; otherwise fall back to a top-level assets/ dir.
      return existsSync(resolve(cwd, 'src')) ? 'src/assets/magicpixel' : 'assets/magicpixel';
  }
}

function suggestEngineOutDir(cwd: string, folder: string, destName: string): string {
  const found = resolveChildDir(cwd, folder);
  const rel = found ? relative(cwd, found).replace(/\\/g, '/') : folder;
  return `${rel || folder}/${destName}`;
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
