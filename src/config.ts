import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateEndpointUrl } from './util/security.js';

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
  const include = normalizeGlobList(parsed.include ?? defaultConfig.include, 'include');
  const exclude = normalizeGlobList(parsed.exclude ?? defaultConfig.exclude, 'exclude');
  const outDir = typeof parsed.outDir === 'string' && parsed.outDir.trim() ? parsed.outDir.trim() : defaultConfig.outDir;
  if (outDir.includes('\0') || outDir.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new Error(
      `${CONFIG_FILENAME}: outDir must not contain ".." segments.\n` +
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

  return {
    outDir,
    include,
    exclude,
    endpoint,
    emitIndex: parsed.emitIndex ?? defaultConfig.emitIndex,
  };
}

const MAX_GLOBS = 64;
const MAX_GLOB_LEN = 256;

function normalizeGlobList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${CONFIG_FILENAME}: "${field}" must be an array of glob strings.`);
  }
  if (value.length > MAX_GLOBS) {
    throw new Error(`${CONFIG_FILENAME}: "${field}" has too many entries (max ${MAX_GLOBS}).`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${CONFIG_FILENAME}: "${field}" entries must be non-empty strings.`);
    }
    const g = item.trim();
    if (g.length > MAX_GLOB_LEN || g.includes('\0')) {
      throw new Error(`${CONFIG_FILENAME}: "${field}" entry is too long or invalid.`);
    }
    out.push(g);
  }
  return out;
}

export async function saveConfig(
  config: MagicPixelConfig,
  cwd: string = process.cwd(),
): Promise<void> {
  await writeFile(configPath(cwd), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export async function loadState(cwd: string = process.cwd()): Promise<SyncState> {
  const path = statePath(cwd);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SyncState;
  } catch {
    return {};
  }
}

export async function saveState(
  state: SyncState,
  cwd: string = process.cwd(),
): Promise<void> {
  const path = statePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function resolveEndpoint(config: MagicPixelConfig): string {
  if (config.endpoint) return config.endpoint;
  return DEFAULT_ENDPOINT;
}

export function getApiKey(): string {
  const key = process.env.MAGICPIXEL_API_KEY;
  if (!key) {
    throw new Error(
      'MAGICPIXEL_API_KEY is not set.\n' +
        '  Fix:\n' +
        '    1. Get a key at https://magicpixel.art/settings (API Keys).\n' +
        '    2. export MAGICPIXEL_API_KEY=mp_live_...\n' +
        '    3. Re-run the command.',
    );
  }
  const trimmed = key.trim();
  if (trimmed !== key) {
    throw new Error(
      `MAGICPIXEL_API_KEY has leading/trailing whitespace.\n` +
        `  Fix: export the key without spaces or quotes.`,
    );
  }
  if (!/^mp_(live|test)_[a-f0-9]{64}$/.test(trimmed)) {
    throw new Error(
      `MAGICPIXEL_API_KEY does not look right (expected mp_live_… or mp_test_…).\n` +
        `  Fix: re-copy the key from https://magicpixel.art/settings.`,
    );
  }
  return trimmed;
}

export { CLI_USER_AGENT, CLI_VERSION } from './version.js';
