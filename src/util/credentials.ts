import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { atomicWrite } from './atomicWrite.js';

const CREDENTIALS_DIR = '.magicpixel';
const CREDENTIALS_FILE = 'credentials';

export interface StoredCredentials {
  apiKey: string;
  savedAt: string;
}

export function credentialsPath(cwd: string = process.cwd()): string {
  return resolve(cwd, CREDENTIALS_DIR, CREDENTIALS_FILE);
}

/** Synchronous read — called from `getApiKey()` which must stay sync. */
export function readCredentialsSync(cwd: string = process.cwd()): StoredCredentials | null {
  const path = credentialsPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
      return { apiKey: parsed.apiKey.trim(), savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '' };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeCredentials(apiKey: string, cwd: string = process.cwd()): Promise<string> {
  const path = credentialsPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const body: StoredCredentials = { apiKey: apiKey.trim(), savedAt: new Date().toISOString() };
  // Atomic stage-and-rename. The mode is applied to the tmp file *before* the
  // rename so the final credentials file is never world-readable for even a
  // single tick (crash-window safety + perm-window safety in one call).
  await atomicWrite(path, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  return path;
}

export async function deleteCredentials(cwd: string = process.cwd()): Promise<boolean> {
  const path = credentialsPath(cwd);
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Look for `MAGICPIXEL_API_KEY=…` in a `.env` / `.env.local` file. Returns the
 * raw value (no validation) or `null`. Used by `init`/`start` to offer migration
 * away from bundler-visible env files.
 */
export async function findKeyInDotenv(cwd: string = process.cwd()): Promise<{ file: string; value: string } | null> {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, 'utf8');
      for (const line of raw.split('\n')) {
        // Anchored on the *exact* key name — otherwise `MAGICPIXEL_API_KEY_OLD`
        // or `MAGICPIXEL_API_KEY_BACKUP` would silently match and return the
        // wrong value. Allows optional `export` prefix and spaces around `=`.
        const m = line.match(/^\s*(?:export\s+)?MAGICPIXEL_API_KEY\s*=\s*"?([^"\n#]+?)"?\s*(?:#.*)?$/);
        if (m && m[1]) return { file: name, value: m[1].trim() };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function describeKeySource(cwd: string = process.cwd()): 'env' | 'credentials-file' | 'none' {
  if (process.env.MAGICPIXEL_API_KEY) return 'env';
  if (readCredentialsSync(cwd)) return 'credentials-file';
  return 'none';
}

/**
 * Best-effort read of the API key for *display only* (e.g. `status`,
 * `doctor`). Honors the same precedence as `getApiKey()` but never throws and
 * never validates — callers that need a real key should still use `getApiKey`.
 *
 * Returns `null` when no key is configured. The caller is responsible for
 * masking before printing.
 */
export function readKeyForDisplay(
  cwd: string = process.cwd(),
): { value: string; source: 'env' | 'credentials-file' } | null {
  const fromEnv = process.env.MAGICPIXEL_API_KEY?.trim();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const stored = readCredentialsSync(cwd);
  if (stored) return { value: stored.apiKey, source: 'credentials-file' };
  return null;
}
