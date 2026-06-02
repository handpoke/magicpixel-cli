import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type Framework =
  | 'Next.js'
  | 'Vite'
  | 'Remix'
  | 'TanStack Start'
  | 'Create React App'
  | 'Astro'
  | 'Nuxt'
  | 'SvelteKit'
  | null;

/** Read `package.json` and infer the framework from its dependencies. */
export async function detectFramework(cwd: string = process.cwd()): Promise<Framework> {
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

/** Default `outDir` for a detected framework. */
export function suggestOutDir(framework: Framework, cwd: string = process.cwd()): string {
  switch (framework) {
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
    default:
      // No framework detected — prefer src/ if present so the typed index is
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
