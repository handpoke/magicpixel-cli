import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  return {
    outDir: parsed.outDir ?? defaultConfig.outDir,
    include: parsed.include ?? defaultConfig.include,
    exclude: parsed.exclude ?? defaultConfig.exclude,
    endpoint: parsed.endpoint,
    emitIndex: parsed.emitIndex ?? defaultConfig.emitIndex,
  };
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
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function resolveEndpoint(config: MagicPixelConfig): string {
  return config.endpoint ?? DEFAULT_ENDPOINT;
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
  if (!/^mp_(live|test)_/.test(key)) {
    throw new Error(
      `MAGICPIXEL_API_KEY does not look right (expected to start with "mp_live_").\n` +
        `  Fix: re-copy the key from https://magicpixel.art/settings.`,
    );
  }
  return key;
}

export { CLI_USER_AGENT, CLI_VERSION } from './version.js';
