import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { configPath, defaultConfig, saveConfig, type MagicPixelConfig } from '../config.js';
import {
  detectProjectKind,
  suggestOutDir,
  hasPackageJson,
  isStaticOutDir,
  supportsTypedIndex,
  isEngineKind,
} from '../util/framework.js';
import { assertSafeOutDir } from '../util/security.js';
import { atomicWrite } from '../util/atomicWrite.js';

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

  const kind = await detectProjectKind();
  const suggestedOutDir = suggestOutDir(kind);
  config.outDir = suggestedOutDir;

  const pkgExists = hasPackageJson();
  const pkgPath = resolve(process.cwd(), 'package.json');
  let addWatchScript = pkgExists && !isEngineKind(kind);

  if (interactive) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      console.log(kleur.bold('Set up @magicpixelart/cli'));
      if (kind) console.log(kleur.dim(`  Detected: ${kind}`));
      console.log();

      // Re-prompt loop: catch unsafe outDir values (null bytes, `..` segments)
      // at input time rather than letting `loadConfig` reject them on the next
      // `sync`/`status` run. UX is faster and the error sits next to the cause.
      // Delegates to `assertSafeOutDir` so the predicate matches `loadConfig` exactly.
      for (;;) {
        const ans = (await rl.question(
          `${kleur.cyan('?')} Where should assets be written? ${kleur.dim(`(${suggestedOutDir})`)} `,
        )).trim();
        const candidate = ans || suggestedOutDir;
        try {
          config.outDir = assertSafeOutDir(candidate);
          break;
        } catch (e) {
          console.log(kleur.yellow(`  ${(e as Error).message} Try again.`));
        }
      }

      // Typed index only makes sense for JS projects with a bundler-importable outDir.
      if (!supportsTypedIndex(kind)) {
        config.emitIndex = false;
      } else if (!isStaticOutDir(config.outDir)) {
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

      if (pkgExists && !isEngineKind(kind)) {
        const wAns = (await rl.question(
          `${kleur.cyan('?')} Add a "${WATCH_SCRIPT_NAME}" script to package.json? ${kleur.dim('(Y/n)')} `,
        )).trim().toLowerCase();
        addWatchScript = wAns !== 'n' && wAns !== 'no';
      }
    } finally {
      rl.close();
    }
  } else {
    config.emitIndex = supportsTypedIndex(kind) && !isStaticOutDir(config.outDir);
  }

  await saveConfig(config);
  console.log();
  console.log(kleur.green('✓ wrote magicpixel.json'));
  if (kind === 'GameMaker') {
    console.log(kleur.dim("  Note: GameMaker doesn't auto-import — refresh Included Files after each sync."));
  }

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
    // Atomic write — a crash mid-write must never corrupt the user's package.json.
    await atomicWrite(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline);
    return { added: true, alreadyPresent: false };
  } catch (e) {
    return { added: false, alreadyPresent: false, error: (e as Error).message };
  }
}

// `isImportableOutDir` lives in util/framework.ts as `isStaticOutDir`
// (negated) — shared with `emitIndex.ts`'s AGENTS.md snippet resolver.

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
