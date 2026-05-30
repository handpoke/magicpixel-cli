import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { configPath, defaultConfig, saveConfig, type MagicPixelConfig } from '../config.js';

interface InitOpts {
  force?: boolean;
  yes?: boolean;
}

export async function initCommand(opts: InitOpts): Promise<void> {
  const path = configPath();
  if (existsSync(path) && !opts.force) {
    console.log(kleur.yellow(`magicpixel.json already exists. Use --force to overwrite.`));
    return;
  }

  const interactive = !opts.yes && stdin.isTTY;
  const config: MagicPixelConfig = { ...defaultConfig };
  let addGitignore = true;

  const framework = await detectFramework();
  const suggestedOutDir = suggestOutDir(framework);
  config.outDir = suggestedOutDir;

  if (interactive) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      console.log(kleur.bold('Set up @magicpixel/cli'));
      if (framework) console.log(kleur.dim(`  Detected: ${framework}`));
      console.log();

      config.outDir = (await rl.question(
        `${kleur.cyan('?')} Where should assets be written? ${kleur.dim(`(${suggestedOutDir})`)} `,
      )).trim() || suggestedOutDir;

      // Typed index only makes sense when the outDir is importable by a bundler.
      // public/ and static/ are served as-is and cannot be imported.
      if (isImportableOutDir(config.outDir)) {
        const emitAns = (await rl.question(
          `${kleur.cyan('?')} Emit a typed index.ts for autocomplete? ${kleur.dim('(Y/n)')} `,
        )).trim().toLowerCase();
        config.emitIndex = emitAns !== 'n' && emitAns !== 'no';
      } else {
        config.emitIndex = false;
        console.log(kleur.dim(`  Skipping typed index (outDir "${config.outDir}" is served statically, not importable).`));
      }

      const giAns = (await rl.question(
        `${kleur.cyan('?')} Add .magicpixel/ to .gitignore? ${kleur.dim('(Y/n)')} `,
      )).trim().toLowerCase();
      addGitignore = giAns !== 'n' && giAns !== 'no';
    } finally {
      rl.close();
    }
  } else {
    config.emitIndex = isImportableOutDir(config.outDir);
  }

  await saveConfig(config);
  console.log();
  console.log(kleur.green('✓ wrote magicpixel.json'));

  if (addGitignore) {
    const added = await ensureGitignore();
    if (added) console.log(kleur.green('✓ added .magicpixel/ to .gitignore'));
  }

  console.log();
  console.log(kleur.bold('Next:'));
  console.log(`  1. Get an API key → ${kleur.cyan('https://magicpixel.art/settings')}`);
  console.log(`  2. ${kleur.dim('export')} MAGICPIXEL_API_KEY=mp_live_...`);
  console.log(`  3. ${kleur.dim('npx')} magicpixel sync`);
  console.log();
  console.log(kleur.dim('Tip: use `magicpixel sync --watch` while editing.'));
}

async function detectFramework(): Promise<string | null> {
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next']) return 'Next.js';
    if (deps['vite']) return 'Vite';
    if (deps['@remix-run/react']) return 'Remix';
    if (deps['react-scripts']) return 'Create React App';
    if (deps['astro']) return 'Astro';
    if (deps['nuxt']) return 'Nuxt';
    if (deps['@sveltejs/kit']) return 'SvelteKit';
    return null;
  } catch {
    return null;
  }
}

function suggestOutDir(framework: string | null): string {
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
    default:
      return 'src/assets/magicpixel';
  }
}

/**
 * `public/` and `static/` are served as-is by frameworks and can't be
 * `import`ed by a bundler — emitting a typed index there is dead code that
 * also gets shipped as a static asset.
 */
function isImportableOutDir(outDir: string): boolean {
  const norm = outDir.replace(/\\/g, '/').replace(/^\.\//, '');
  return !/^(public|static)(\/|$)/.test(norm);
}

async function ensureGitignore(): Promise<boolean> {
  const path = resolve(process.cwd(), '.gitignore');
  const marker = '.magicpixel/';
  if (existsSync(path)) {
    const current = await readFile(path, 'utf8');
    if (current.split('\n').some((l) => l.trim() === marker)) return false;
    await appendFile(path, (current.endsWith('\n') ? '' : '\n') + `\n# MagicPixel CLI state\n${marker}\n`);
    return true;
  }
  await writeFile(path, `# MagicPixel CLI state\n${marker}\n`, 'utf8');
  return true;
}
