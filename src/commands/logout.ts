import kleur from 'kleur';
import { ui } from '../util/ui.js';
import { deleteCredentials, credentialsPath } from '../util/credentials.js';
import { relative } from 'node:path';

export async function logoutCommand(): Promise<void> {
  const path = credentialsPath();
  const removed = await deleteCredentials();
  if (removed) {
    console.log(ui.ok(`logged out`));
    console.log(kleur.dim(`  Removed ${relative(process.cwd(), path)}.`));
  } else {
    console.log(kleur.dim('No stored credentials to remove.'));
  }
  if (process.env.MAGICPIXEL_API_KEY) {
    console.log(
      kleur.yellow(
        '  Note: MAGICPIXEL_API_KEY is still set in your environment — unset it to fully log out.',
      ),
    );
  }
}
