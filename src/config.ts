import { readFile, mkdir, rename, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertSafeOutDir, MAX_GLOB_LEN, sanitizeSourceRel, validateEndpointUrl } from './util/security.js';
import { readCredentialsSync } from './util/credentials.js';
import { friendlyFsError } from './util/errors.js';
import { atomicWrite } from './util/atomicWrite.js';
import { cmd } from './util/invoke.js';

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
  /** Unity only: pixels-per-unit baked into generated `.meta` files (default 32). */
  unityPpu?: number;
  /** Unity only: sync every artboard instead of only the ones flagged
   *  "Sync to Unity" in the editor (default false). */
  unitySyncAll?: boolean;
  /** Disk → MagicPixel on every `sync`. Set false for pull-only. Default true. */
  push?: boolean;
  /**
   * Globs of game PNGs to keep in Connected. Unity/Godot/GameMaker default to
   * all sprites (`**`) on first sync. Narrow with `magicpixel connect <glob>`.
   */
  connect: string[];
}

/**
 * What the CLI last pulled for one composite key. `magicpixel push` needs the
 * exact artboard address plus the composite sha it wrote to disk, so a disk
 * edit can be sent back with a conflict baseline instead of blindly
 * overwriting whatever the cloud holds now.
 */
export interface SyncedSprite {
  assetId: string;
  layerIdx: number;
  /**
   * Cloud composite sha256 (conflict baseline for `push` updates). For
   * connected game files this is often *not* the original PNG on disk —
   * MagicPixel re-encodes on ingest. Skip decisions use `diskSha256`.
   */
  sha256: string;
  /**
   * sha256 of the file bytes last seen on disk. Connected originals keep this
   * even when it differs from the cloud composite, so watch/push do not
   * re-upload thousands of unchanged game PNGs every tick.
   */
  diskSha256?: string;
  /** `lstat` mtime (ms) of the file when `diskSha256` was recorded. */
  diskMtimeMs?: number;
  /** `lstat` size of the file when `diskSha256` was recorded. */
  diskSize?: number;
  /** Layer count of the artboard — a >1 push needs an explicit `--flatten`. */
  layers?: number;
  /**
   * Legacy single-PNG row (`layer_idx: -1` in the manifest): the cloud has no
   * addressable artboard for it, so `push` refuses instead of adopting a
   * duplicate document.
   */
  legacy?: boolean;
  /**
   * Original game-tree path (cwd-relative). Write-back always requires this
   * path to still exist in the live connect index; the field only aliases a
   * cloud composite key onto that indexed PNG.
   */
  sourceRel?: string;
}

export interface SyncState {
  lastSync?: string;
  /** Map of manifest asset id → key, captured at the end of each successful sync.
   *  Used for rename detection and for emitting `MagicPixelAssetsById` in `index.ts`. */
  assets?: Record<string, string>;
  /** Map of composite key → artboard address + last-pulled sha (for `push`). */
  synced?: Record<string, SyncedSprite>;
  /** Last error message surfaced by `sync` (for `magicpixel doctor`). Cleared on a clean run. */
  lastError?: string;
  /**
   * Manifest ETag validators (endpoint+query → validator) from the last run, so
   * a one-shot `sync` gets the same idle 304 as a watcher. Advisory only: a
   * stale or missing entry just costs one full manifest response.
   */
  manifestEtags?: Record<string, string>;
  /**
   * ISO time of the last full (non-incremental) pass. Incremental runs cannot
   * see a permanently deleted row — the cloud has nothing left to report — so a
   * full reconcile is promoted periodically to clear orphaned PNGs.
   */
  lastReconcile?: string;
}

export const defaultConfig: MagicPixelConfig = {
  outDir: 'src/assets/magicpixel',
  include: ['**/*'],
  exclude: [],
  connect: [],
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
        `  Fix: run \`${cmd('start')}\` — it creates the config, logs you in, and runs the first sync.`,
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
  const connect = normalizeGlobList(parsed.connect ?? defaultConfig.connect, 'connect');
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

  let unityPpu: number | undefined;
  if (parsed.unityPpu !== undefined) {
    if (
      typeof parsed.unityPpu !== 'number' ||
      !Number.isFinite(parsed.unityPpu) ||
      parsed.unityPpu <= 0 ||
      parsed.unityPpu > 4096
    ) {
      throw new Error(
        `${CONFIG_FILENAME}: "unityPpu" must be a number between 1 and 4096.\n` +
          `  Fix: set "unityPpu": 32 (or remove the field to use the default).`,
      );
    }
    unityPpu = Math.round(parsed.unityPpu);
  }

  return {
    outDir,
    include,
    exclude,
    endpoint,
    emitIndex,
    unityPpu,
    unitySyncAll: parsed.unitySyncAll === true ? true : undefined,
    push: parsed.push === false ? false : undefined,
    connect,
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
    if (g.split(/[/\\]/).some((seg) => seg === '..')) {
      throw new Error(
        `${CONFIG_FILENAME}: "${field}" must not contain ".." segments.\n` +
          `  Fix: use a project-relative glob such as "Assets/Sprites/**".`,
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
      hint: `magicpixel.json holds your sync config — without it \`${cmd('sync')}\` can't run.`,
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
    return scrubLoadedState(JSON.parse(raw) as SyncState);
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

/** Drop untrusted persisted sourceRel so a hand-edited state.json cannot leak into later saves. */
function scrubLoadedState(state: SyncState): SyncState {
  const synced = state.synced;
  if (!synced || typeof synced !== 'object' || Array.isArray(synced)) return state;
  const next: Record<string, SyncedSprite> = {};
  for (const [key, val] of Object.entries(synced)) {
    if (!val || typeof val !== 'object') continue;
    const sprite: SyncedSprite = { ...val };
    if (sprite.sourceRel !== undefined) {
      const safe = sanitizeSourceRel(sprite.sourceRel);
      if (safe) sprite.sourceRel = safe;
      else delete sprite.sourceRel;
    }
    next[key] = sprite;
  }
  return { ...state, synced: next };
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
        `    2. Run \`${cmd('login')}\` (or \`export MAGICPIXEL_API_KEY=mp_live_...\`).\n` +
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
        `  Fix: run \`${cmd('login')}\` and paste a fresh key from https://magicpixel.art/settings.`,
    );
  }
  return trimmed;
}

export { CLI_USER_AGENT, CLI_VERSION } from './version.js';
