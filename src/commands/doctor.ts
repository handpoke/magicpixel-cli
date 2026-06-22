import kleur from 'kleur';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { loadConfig, loadState, resolveEndpoint, defaultConfig, type MagicPixelConfig } from '../config.js';
import { describeKeySource, readKeyForDisplay } from '../util/credentials.js';
import { detectProjectKind, hasPackageJson } from '../util/framework.js';
import { safeFetch } from '../util/security.js';
import { authHeaders } from '../util/authHeaders.js';
import { CLI_VERSION } from '../version.js';

/**
 * Structured diagnostic report. Stable shape — `--json` consumers (and
 * paste-to-AI workflows) depend on field names. Never includes the API key
 * itself, only its source.
 */
export interface DoctorReport {
  cli: string;
  node: string;
  platform: NodeJS.Platform;
  cwd: string;
  framework: string | null;
  hasPackageJson: boolean;
  config:
    | { found: true; outDir: string; emitIndex: boolean; include: string[]; exclude: string[]; endpoint: string | null }
    | { found: false; error: string };
  endpoint: string;
  key: { source: 'env' | 'credentials-file' | 'none' };
  watchScript: string | null;
  state: { lastSync: string | null; assetCount: number; lastError: string | null };
  outDir: { path: string | null; exists: boolean };
  /**
   * Result of the live manifest probe. Discriminated:
   *   - `{ skipped: 'offline' }` — `--offline` was passed.
   *   - `{ skipped: 'no-api-key' }` — no API key configured; probe would
   *     have produced a guaranteed 401, so we don't issue it.
   *   - `{ ok, status, roundtripMs, requestId, error }` — a probe ran.
   *
   * JSON consumers can branch on `'skipped' in network` instead of
   * mis-reading a probe skip as a network failure (`ok: false`).
   */
  network:
    | { skipped: 'offline' | 'no-api-key' }
    | {
        ok: boolean;
        status: number | null;
        roundtripMs: number | null;
        requestId: string | null;
        error: string | null;
      };
  suggestions: string[];
}

export interface DoctorOpts {
  json?: boolean;
  /** Skip the live manifest probe (network section will be `null`). */
  offline?: boolean;
}

export async function doctorCommand(opts: DoctorOpts = {}): Promise<void> {
  const report = await collectDoctorReport(opts);
  if (opts.json) {
    // Pure JSON to stdout — no ANSI, no header. Pipe-able into `jq` or pasted
    // into an LLM verbatim.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  console.log(renderDoctorReport(report));
}

/**
 * Read-only data collection. Hits the network exactly once (a HEAD-equivalent
 * GET against `/manifest?limit=1`) unless `--offline` is set. Never mutates
 * state on disk.
 */
export async function collectDoctorReport(opts: DoctorOpts = {}): Promise<DoctorReport> {
  const framework = await detectProjectKind();
  const pkgFound = hasPackageJson();

  let config: MagicPixelConfig | null = null;
  let configErr: string | null = null;
  try {
    config = await loadConfig();
  } catch (e) {
    // Preserve the full multi-line "Fix:" hint for `--json` consumers (LLM
    // paste-and-debug). The human renderer below trims to the first line so
    // the TTY layout stays compact.
    configErr = (e as Error).message;
  }

  const endpoint = resolveEndpoint(config ?? { ...defaultConfig });
  const keySource = describeKeySource();

  let watchScript: string | null = null;
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      watchScript = pkg.scripts?.['magicpixel:watch'] ?? null;
    }
  } catch {
    // package.json absent or unreadable — already reflected in `hasPackageJson`.
  }

  const state = await loadState();

  let outDirPath: string | null = null;
  let outDirExists = false;
  if (config) {
    const abs = resolve(process.cwd(), config.outDir);
    outDirPath = relative(process.cwd(), abs) || config.outDir;
    outDirExists = existsSync(abs);
  }

  // Skip the network probe when there's no key — it would unauthenticate to
  // a guaranteed 401 and surface a misleading "API rejected the key"
  // suggestion on top of the (correct) "run login" one. The network section
  // still gets a structured value so `--json` consumers can branch on it.
  const network: DoctorReport['network'] = opts.offline
    ? { skipped: 'offline' }
    : keySource === 'none'
      ? { skipped: 'no-api-key' }
      : await probeManifest(endpoint);

  const suggestions: string[] = [];
  if (keySource === 'none') suggestions.push('Run `magicpixel login` to store your API key.');
  if (!config) suggestions.push('Run `magicpixel start` (or `magicpixel init`) to bootstrap.');
  if (config && !watchScript && pkgFound) {
    suggestions.push('Add a `magicpixel:watch` npm script (or run `magicpixel sync -w`) for live sync.');
  }
  if (state.lastError) suggestions.push('Last sync surfaced an error — run `magicpixel repair` to self-heal.');
  // Only emit network-derived suggestions when we actually probed.
  if ('ok' in network && !network.ok) {
    if (network.status === 401 || network.status === 403) {
      suggestions.push('API rejected the key — run `magicpixel login` with a fresh key from settings.');
    } else if (network.status === null) {
      suggestions.push('Could not reach MagicPixel — check internet/proxy, or re-run with --offline.');
    } else {
      suggestions.push(`Manifest probe returned ${network.status} — paste the request id when filing a report.`);
    }
  }

  return {
    cli: CLI_VERSION,
    node: process.versions.node,
    platform: process.platform,
    cwd: process.cwd(),
    framework: framework ?? null,
    hasPackageJson: pkgFound,
    config: config
      ? {
          found: true,
          outDir: config.outDir,
          emitIndex: config.emitIndex !== false,
          include: config.include,
          exclude: config.exclude,
          endpoint: config.endpoint ?? null,
        }
      : { found: false, error: configErr ?? 'unknown' },
    endpoint,
    key: { source: keySource },
    watchScript,
    state: {
      lastSync: state.lastSync ?? null,
      assetCount: state.assets ? Object.keys(state.assets).length : 0,
      lastError: state.lastError ?? null,
    },
    outDir: { path: outDirPath, exists: outDirExists },
    network,
    suggestions,
  };
}

/**
 * One live probe against `/manifest?limit=1` with a 5s timeout. Caller
 * guarantees a stored API key is present (no-key callers skip the probe
 * entirely — see `collectDoctorReport`), so this function always
 * authenticates and mirrors exactly what a real `sync` would send.
 */
type ProbeResult = Extract<DoctorReport['network'], { ok: boolean }>;

async function probeManifest(endpoint: string): Promise<ProbeResult> {
  const url = new URL(`${endpoint}/manifest`);
  url.searchParams.set('limit', '1');
  const display = readKeyForDisplay();
  if (!display) {
    // Defensive: the caller in `collectDoctorReport` already returns the
    // structured "no API key" record without invoking us. If we somehow get
    // here, surface a clear internal error rather than a confusing 401.
    return {
      ok: false,
      status: null,
      roundtripMs: null,
      requestId: null,
      error: 'internal: probeManifest invoked without a stored API key',
    };
  }
  const { headers, requestId } = authHeaders(display.value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    const res = await safeFetch(url.href, { headers, signal: controller.signal });
    await res.body?.cancel();
    const elapsed = Date.now() - start;
    const serverRequestId = res.headers.get('x-request-id') ?? requestId;
    return {
      ok: res.ok,
      status: res.status,
      roundtripMs: elapsed,
      requestId: serverRequestId,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      roundtripMs: Date.now() - start,
      requestId,
      error: (e as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable rendering of `DoctorReport`. */
export function renderDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(kleur.bold('MagicPixel CLI — doctor'));
  push(kleur.dim(`  Paste this to your AI agent if something isn't working.`));
  push();

  push(`CLI version:        ${r.cli}`);
  push(`Node version:       ${r.node}`);
  push(`Platform:           ${r.platform}`);
  push(`cwd:                ${r.cwd}`);
  push();
  push(`package.json:       ${r.hasPackageJson ? 'found' : kleur.yellow('missing')}`);
  push(`Framework detected: ${r.framework ?? kleur.dim('none')}`);

  if (r.config.found) {
    push(`magicpixel.json:    found`);
    push(`  outDir:           ${r.config.outDir}`);
    push(`  emitIndex:        ${r.config.emitIndex ? 'true' : 'false'}`);
    push(`  include:          ${r.config.include.join(', ')}`);
    if (r.config.exclude.length) push(`  exclude:          ${r.config.exclude.join(', ')}`);
    if (r.config.endpoint) push(`  endpoint:         ${kleur.yellow(r.config.endpoint)} (custom)`);
  } else {
    push(`magicpixel.json:    ${kleur.yellow('missing')} (${r.config.error.split('\n')[0]})`);
  }
  push(`API endpoint:       ${r.endpoint}`);

  const sourceLabel =
    r.key.source === 'env'
      ? 'environment variable (MAGICPIXEL_API_KEY)'
      : r.key.source === 'credentials-file'
        ? '.magicpixel/credentials'
        : kleur.yellow('none — run `magicpixel login`');
  push(`API key source:     ${sourceLabel}`);
  push(`Watch script:       ${r.watchScript ? `"${r.watchScript}"` : kleur.dim('not configured')}`);

  push(`Last sync:          ${r.state.lastSync ? new Date(r.state.lastSync).toLocaleString() : kleur.dim('never')}`);
  push(`Assets in state:    ${r.state.assetCount}`);
  if (r.state.lastError) push(`Last error:         ${kleur.yellow(r.state.lastError)}`);

  if (r.outDir.path !== null) {
    push(`outDir on disk:     ${r.outDir.path} (${r.outDir.exists ? 'exists' : kleur.dim('not created yet')})`);
  }

  push();
  if ('skipped' in r.network) {
    const reason =
      r.network.skipped === 'offline'
        ? 'skipped (--offline)'
        : 'skipped (no API key — run `magicpixel login`)';
    push(`Network probe:      ${kleur.dim(reason)}`);
  } else if (r.network.ok) {
    push(`Network probe:      ${kleur.green('✓')} ${r.network.status} in ${r.network.roundtripMs}ms`);
    if (r.network.requestId) push(`  request id:       ${kleur.dim(r.network.requestId)}`);
  } else {
    const statusLabel = r.network.status !== null ? `HTTP ${r.network.status}` : 'no response';
    push(`Network probe:      ${kleur.red('✗')} ${statusLabel} (${r.network.roundtripMs}ms)`);
    if (r.network.requestId) push(`  request id:       ${kleur.dim(r.network.requestId)}`);
    if (r.network.error) push(`  error:            ${kleur.dim(r.network.error)}`);
  }

  if (r.suggestions.length > 0) {
    push();
    push(kleur.dim('Next steps:'));
    for (const s of r.suggestions) push(kleur.dim(`  • ${s}`));
  }

  return lines.join('\n');
}
