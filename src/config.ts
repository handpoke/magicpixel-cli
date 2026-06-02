import { readFile, mkdir, rename, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertSafeOutDir, MAX_GLOB_LEN, validateEndpointUrl } from './util/security.js';
import { readCredentialsSync } from './util/credentials.js';
import { friendlyFsError } from './util/errors.js';
import { atomicWrite } from './util/atomicWrite.js';

const CONFIG_FILENAME = 'magicpixel.json';
const STATE_DIR = '.magicpixel';
const STATE_FILENAME = 'state.json';

const DEFAULT_ENDPOINT =
  'https://sddsilidjhvtvejzvolx.supabase.co/functions/v1/integration-assets';

export interface MagicPixelConfig {
  outDir: string;
  include: string[];
  exclude: string[];
  endpoint?: string;
  /** Emit a typed `index.ts` alongside the PNGs (autocomplete + compile-time key checks). */
  emitIndex?: boolean;
}

export interface SyncState {
  lastSync?: string;
  /** Map of manifest asset id → key, captured at the end of each successful sync.
   *  Used for rename detection and for emitting `MagicPixelAssetsById` in `index.ts`. */
  assets?: Record<string, string>;
  /** Last error message surfaced by `sync` (for `magicpixel doctor`). Cleared on a clean run. */
  lastError?: string;
}

export const defaultConfig: MagicPixelConfig = {
  outDir: 'src/assets/magicpixel',
  include: ['**/*'],
  exclude: [],
  emitIndex: true,
};

export function configPath(cwd: string = process.cwd()): string {
  return resolve(cwd, CONFIG_FILENAME);
}

export function statePath(cwd: string = process.cwd()): string {
  return resolve(cwd, STATE_DIR, STATE_FILENAME);
}

export async function loadConfig(cwd: string = process.cwd()): Promise<MagicPixelConfig> {
  const path = configPath(cwd);
  if (!existsSync(path)) {
    throw new Error(
      `No ${CONFIG_FILENAME} found in ${cwd}.\n` +
        `  Fix: run \`npx magicpixel init\` to create one.`,
    );
  }
  const raw = await readFile(path, 'utf8');
  let parsed: Partial<MagicPixelConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<MagicPixelConfig>;
  } catch (e) {
    throw new Error(
      `${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}\n` +
        `  Fix: open the file and check for trailing commas or quotes.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${CONFIG_FILENAME} must be a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed}).\n` +
        `  Fix: replace the file contents with { "outDir": "src/assets/magicpixel", "include": ["**/*"] }.`,
    );
  }
  const include = normalizeGlobList(parsed.include ?? defaultConfig.include, 'include');
  const exclude = normalizeGlobList(parsed.exclude ?? defaultConfig.exclude, 'exclude');
  const rawOutDir = typeof parsed.outDir === 'string' && parsed.outDir.trim() ? parsed.outDir : defaultConfig.outDir;
  let outDir: string;
  try {
    outDir = assertSafeOutDir(rawOutDir);
  } catch (e) {
    throw new Error(
      `${CONFIG_FILENAME}: ${(e as Error).message}\n` +
        `  Fix: use a path like src/assets/magicpixel.`,
    );
  }
  let endpoint: string | undefined;
  if (parsed.endpoint !== undefined) {
    if (typeof parsed.endpoint !== 'string' || !parsed.endpoint.trim()) {
      throw new Error(`${CONFIG_FILENAME}: "endpoint" must be a non-empty string.\n  Fix: remove the field to use the default API.`);
    }
    endpoint = validateEndpointUrl(parsed.endpoint.trim());
  }

  let emitIndex: boolean = defaultConfig.emitIndex ?? true;
  if (parsed.emitIndex !== undefined) {
    if (typeof parsed.emitIndex !== 'boolean') {
      throw new Error(
        `${CONFIG_FILENAME}: "emitIndex" must be a boolean (got ${typeof parsed.emitIndex}).\n` +
          `  Fix: set "emitIndex": true or "emitIndex": false (or remove the field).`,
      );
    }
    emitIndex = parsed.emitIndex;
  }

  return {
    outDir,
    include,
    exclude,
    endpoint,
    emitIndex,
  };
}

const MAX_GLOBS = 64;

function normalizeGlobList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${CONFIG_FILENAME}: "${field}" must be an array of glob strings (got ${typeof value}).\n` +
        `  Fix: change "${field}" to an array, e.g. "${field}": ["**/*"].`,
    );
  }
  if (value.length > MAX_GLOBS) {
    throw new Error(
      `${CONFIG_FILENAME}: "${field}" has too many entries (${value.length}, max ${MAX_GLOBS}).\n` +
        `  Fix: combine patterns or split your sync into multiple projects.`,
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(
        `${CONFIG_FILENAME}: "${field}" entries must be non-empty strings.\n` +
          `  Fix: remove empty/null entries from "${field}".`,
      );
    }
    const g = item.trim();
    if (g.length > MAX_GLOB_LEN || g.includes('\0')) {
      throw new Error(
        `${CONFIG_FILENAME}: "${field}" entry is too long (>${MAX_GLOB_LEN} chars) or contains a null byte.\n` +
          `  Fix: shorten the pattern.`,
      );
    }
    out.push(g);
  }
  return out;
}

export async function saveConfig(
  config: MagicPixelConfig,
  cwd: string = process.cwd(),
): Promise<void> {
  const path = configPath(cwd);
  try {
    // Atomic write: a crash mid-write must never leave magicpixel.json
    // truncated — a corrupt config wedges every subsequent `sync`/`status`
    // run with a JSON parse error and is exactly the scenario `repair` was
    // built to recover from. Cheap to avoid in the first place.
    await atomicWrite(path, JSON.stringify(config, null, 2) + '\n');
  } catch (e) {
    throw friendlyFsError(e, {
      operation: 'Saving magicpixel.json',
      path,
      hint: 'magicpixel.json holds your sync config — without it `magicpixel sync` can\'t run.',
    });
  }
}

export async function loadState(cwd: string = process.cwd()): Promise<SyncState> {
  const path = statePath(cwd);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as SyncState;
  } catch (e) {
    // Corrupt state file (truncated by a crash, hand-edited, disk full, etc.)
    // Quarantine it so the user can recover/inspect, then fall back to a full
    // re-sync rather than wedging every future run with a parse error.
    const quarantine = `${path}.corrupt-${Date.now()}`;
    try {
      await rename(path, quarantine);
      console.warn(
        `[magicpixel] state.json was corrupt (${(e as Error).message}). ` +
          `Moved to ${quarantine} and falling back to a full sync.`,
      );
    } catch {
      console.warn(
        `[magicpixel] state.json was corrupt (${(e as Error).message}); ` +
          `falling back to a full sync.`,
      );
    }
    return {};
  }
}

export async function saveState(
  state: SyncState,
  cwd: string = process.cwd(),
): Promise<void> {
  const path = statePath(cwd);
  try {
    await mkdir(dirname(path), { recursive: true });
    // state.json is saved on every watch tick, so it must not use a visible
    // stage-and-rename tmp path (`state.json.<pid>.<hex>.tmp`) that churns in
    // VS Code / Vite file watchers. A torn state write is recoverable: loadState
    // quarantines corrupt JSON and the next sync re-derives state from disk +
    // manifest, so direct writeFile is the safer UX trade-off here. Keep
    // atomicWrite for durable config/credentials/index writers.
    await writeFile(path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(path, 0o600);
    } catch {
      // Windows / read-only FS — ignore. The contents are non-secret sync state.
    }
  } catch (e) {
    throw friendlyFsError(e, {
      operation: 'Saving sync state',
      path,
      hint: 'state.json tracks what was last synced — without it the next run re-downloads everything.',
    });
  }
}

export function resolveEndpoint(config: MagicPixelConfig): string {
  if (config.endpoint) return config.endpoint;
  return DEFAULT_ENDPOINT;
}

/**
 * Read the API key. Precedence: `MAGICPIXEL_API_KEY` env var (highest, so CI
 * can always override) > `.magicpixel/credentials` (written by `magicpixel
 * login`). Throws a friendly error pointing at `magicpixel login` when neither
 * source is configured.
 */
export function getApiKey(): string {
  const fromEnv = process.env.MAGICPIXEL_API_KEY;
  let key: string | undefined = fromEnv;
  if (!key) {
    const stored = readCredentialsSync();
    if (stored) key = stored.apiKey;
  }
  if (!key) {
    throw new Error(
      'No MagicPixel API key found.\n' +
        '  Fix:\n' +
        '    1. Get a key at https://magicpixel.art/settings (API Keys).\n' +
        '    2. Run `magicpixel login` (or `export MAGICPIXEL_API_KEY=mp_live_...`).\n' +
        '    3. Re-run the command.',
    );
  }
  // Env vars from shells routinely smuggle in stray quotes / whitespace; the
  // credentials file is already trimmed at write time but we trim defensively
  // here so both code paths share the same validation.
  const trimmed = key.trim();
  if (trimmed !== key && fromEnv !== undefined) {
    throw new Error(
      `MAGICPIXEL_API_KEY has leading/trailing whitespace.\n` +
        `  Fix: export the key without spaces or quotes.`,
    );
  }
  if (!/^mp_(live|test)_[a-f0-9]{64}$/.test(trimmed)) {
    throw new Error(
      `MagicPixel API key does not look right (expected mp_live_… or mp_test_…).\n` +
        `  Fix: run \`magicpixel login\` and paste a fresh key from https://magicpixel.art/settings.`,
    );
  }
  return trimmed;
}

export { CLI_USER_AGENT, CLI_VERSION } from './version.js';
