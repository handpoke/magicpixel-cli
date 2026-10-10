import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

/** Ask a y/N question. Non-interactive runs (CI) always answer no. */
export async function confirm(prompt: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const a = (await rl.question(prompt)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}
