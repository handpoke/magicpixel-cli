import kleur from 'kleur';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, defaultConfig, type MagicPixelConfig } from '../config.js';
import { writeCredentials } from '../util/credentials.js';
import { assertKeyValid } from '../util/auth.js';
import { relative } from 'node:path';

const KEY_RE = /^mp_(live|test)_[a-f0-9]{64}$/;

interface LoginOpts {
  key?: string;
}

export async function loginCommand(opts: LoginOpts = {}): Promise<void> {
  // Config is optional for `login` — a brand-new user runs it before `init`.
  let config: MagicPixelConfig;
  try {
    config = await loadConfig();
  } catch {
    config = { ...defaultConfig };
  }

  let key = opts.key?.trim();
  if (!key) {
    if (!stdin.isTTY) {
      throw new Error(
        'magicpixel login: no key provided and stdin is not a TTY.\n' +
          '  Fix: pass --key mp_live_… or run interactively.',
      );
    }
    key = await promptForKey(3, config);
  } else {
    if (!KEY_RE.test(key)) {
      throw new Error(
        `That key doesn't look right (expected mp_live_… or mp_test_…).\n` +
          `  Fix: copy a fresh key from https://magicpixel.art/settings.`,
      );
    }
    await assertKeyValid(key, config);
  }

  const path = await writeCredentials(key);
  console.log();
  console.log(kleur.green('✓ logged in'));
  console.log(kleur.dim(`  Key stored at ${relative(process.cwd(), path)} (mode 0600).`));
  if (process.env.MAGICPIXEL_API_KEY) {
    console.log(
      kleur.yellow(
        '  Note: MAGICPIXEL_API_KEY is still set in your environment and takes precedence.',
      ),
    );
  }
}

async function promptForKey(maxAttempts: number, config: MagicPixelConfig): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const answer = (
        await rl.question(
          `${kleur.cyan('?')} Paste your key from ${kleur.cyan('https://magicpixel.art/settings')} ${kleur.dim("(we'll store it in .magicpixel/credentials, gitignored)")}: `,
        )
      ).trim();
      if (!answer) {
        console.log(kleur.yellow('  No key entered.'));
        continue;
      }
      if (!KEY_RE.test(answer)) {
        console.log(
          kleur.yellow(`  That doesn't look like a MagicPixel key (expected mp_live_… or mp_test_…).`),
        );
        continue;
      }
      try {
        await assertKeyValid(answer, config);
        return answer;
      } catch (e) {
        console.log(kleur.yellow(`  ${(e as Error).message.split('\n')[0]}`));
      }
    }
    throw new Error(
      `Gave up after ${maxAttempts} attempts.\n  Fix: generate a fresh key at https://magicpixel.art/settings and re-run.`,
    );
  } finally {
    rl.close();
  }
}


