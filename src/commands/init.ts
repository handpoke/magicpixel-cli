import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { configPath, defaultConfig, saveConfig, type MagicPixelConfig } from '../config.js';
import { detectFramework, suggestOutDir, hasPackageJson } from '../util/framework.js';

const WATCH_SCRIPT_NAME = 'magicpixel:watch';
const WATCH_SCRIPT_CMD = 'magicpixel sync --watch';

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

  const pkgExists = hasPackageJson();
  const pkgPath = resolve(process.cwd(), 'package.json');
  let addWatchScript = pkgExists;

  if (interactive) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      console.log(kleur.bold('Set up @magicpixelart/cli'));
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

      if (pkgExists) {
        const wAns = (await rl.question(
          `${kleur.cyan('?')} Add a "${WATCH_SCRIPT_NAME}" script to package.json? ${kleur.dim('(Y/n)')} `,
        )).trim().toLowerCase();
        addWatchScript = wAns !== 'n' && wAns !== 'no';
      }
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

  let watchScriptAdded = false;
  if (addWatchScript && pkgExists) {
    const r = await ensureWatchScript(pkgPath);
    watchScriptAdded = r.added;
    if (r.added) console.log(kleur.green(`✓ added "${WATCH_SCRIPT_NAME}" script to package.json`));
    else if (r.alreadyPresent) console.log(kleur.dim(`  "${WATCH_SCRIPT_NAME}" script already present in package.json`));
    else if (r.error) console.log(kleur.yellow(`  could not patch package.json: ${r.error}`));
  }

  // Only print the "Next" block in fully-interactive init runs. `start`
  // orchestrates its own onboarding summary, so doubling them up is noisy.
  if (interactive) {
    console.log();
    console.log(kleur.bold('Next:'));
    console.log(`  1. ${kleur.dim('magicpixel login')}    ${kleur.dim('# paste your key from https://magicpixel.art/settings')}`);
    console.log(`  2. ${kleur.dim('magicpixel sync')}     ${kleur.dim('# downloads your assets')}`);
    if (watchScriptAdded) {
      console.log(`  3. ${kleur.dim('npm run')} ${WATCH_SCRIPT_NAME}    ${kleur.dim('# keeps assets fresh while you edit')}`);
    } else {
      console.log(`  3. ${kleur.dim('npx')} magicpixel sync --watch    ${kleur.dim('# keeps assets fresh while you edit')}`);
    }
    console.log();
  }
}

interface WatchScriptResult {
  added: boolean;
  alreadyPresent: boolean;
  error?: string;
}

/**
 * Add a `magicpixel:watch` npm script. Preserves existing scripts and 2-space
 * indentation; never overwrites a user-defined script of the same name.
 */
async function ensureWatchScript(pkgPath: string): Promise<WatchScriptResult> {
  try {
    const raw = await readFile(pkgPath, 'utf8');
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      return { added: false, alreadyPresent: false, error: `package.json is not valid JSON (${(e as Error).message})` };
    }
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
    if (typeof scripts[WATCH_SCRIPT_NAME] === 'string') {
      return { added: false, alreadyPresent: true };
    }
    scripts[WATCH_SCRIPT_NAME] = WATCH_SCRIPT_CMD;
    pkg.scripts = scripts;
    const trailingNewline = raw.endsWith('\n') ? '\n' : '';
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline, 'utf8');
    return { added: true, alreadyPresent: false };
  } catch (e) {
    return { added: false, alreadyPresent: false, error: (e as Error).message };
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
  // Accept any of these as "already ignored" so we don't append a duplicate.
  const equivalents = new Set(['.magicpixel', '.magicpixel/', '/.magicpixel', '/.magicpixel/']);
  if (existsSync(path)) {
    const current = await readFile(path, 'utf8');
    if (current.split('\n').some((l) => equivalents.has(l.trim()))) return false;
    await appendFile(path, (current.endsWith('\n') ? '' : '\n') + `\n# MagicPixel CLI state\n${marker}\n`);
    return true;
  }
  await writeFile(path, `# MagicPixel CLI state\n${marker}\n`, 'utf8');
  return true;
}
