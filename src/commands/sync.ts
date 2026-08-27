import kleur from 'kleur';
import ora, { type Ora } from 'ora';
import { mkdir, unlink, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { loadConfig, loadState, saveState, type SyncedSprite, type SyncState } from '../config.js';
import { ensureEngineConnect } from '../util/engineConnect.js';
import { fetchManifestSnapshot, fetchAssetBytes, ApiError, getLastProjectInfo, primeManifestEtags, manifestEtagsSnapshot, type ManifestEntry } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { pruneEmptyDirs, walkOutDirPngs } from '../util/paths.js';
import { createLimit } from '../util/limit.js';
import { emitTypedIndex, ensureAgentsDoc, scanDiskAssets } from '../util/emitIndex.js';
import { assertPathInsideRoot, assertSafeIoPath } from '../util/security.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { indexGamePngs, matchConnectGlobs, GAME_INDEX_CAP_HINT, connectCapMessage, countingSpritesText, type GameIndex, type ScanProgress } from '../util/gameScan.js';
import { aliasCollisionKeys, collectSourceRelMap, isPathInside, syncDiskPathFromKey } from '../util/syncPath.js';
import { DEFAULT_UNITY_PPU, writeMissingUnityMetas } from '../util/unityMeta.js';
import { applyUnityPullPolicy, isWorkingSetEntry, workingSetPullKeys } from '../util/unityFilter.js';
import { selectFullSyncOrphans } from '../util/prunePolicy.js';
import { runTmpJanitor } from '../util/tmpJanitor.js';
import { friendlyFsError } from '../util/errors.js';
import { maxIsoTimestamp } from '../util/iso.js';
import { formatBytes } from '../util/format.js';
import { computePreviousKeyOrphans } from '../util/previousKeyOrphans.js';
import { cmd } from '../util/invoke.js';
import { formatWatchSpriteLine } from '../util/watchCopy.js';
import { decidePull } from '../util/pullDecision.js';
import { hasUnpushedLocalEdit } from '../util/localEdit.js';
import { shouldReconcile } from '../util/reconcile.js';
import { runPush, type PushSummary } from './push.js';

interface SyncOpts {
  prune?: boolean;  // commander: defaults true; --no-prune sets false
  dryRun?: boolean;
  full?: boolean;
  concurrency?: number;
  watch?: boolean | string;
  quiet?: boolean;
}

interface RenameInfo {
  id: string;
  oldKey: string;
  newKey: string;
}

interface SyncResult {
  added: string[];
  modified: string[];
  unchanged: number;
  removed: string[];
  renamed: RenameInfo[];
  failed: number;
  bytesIn: number;
  bytesSaved: number;
  /**
   * Keys edited both on disk and in MagicPixel since the last sync. Never
   * downloaded (that would destroy the local edit) and never pruned; the user
   * resolves them, then the next sync proceeds normally.
   */
  conflicts: string[];
  /**
   * Outcome of the local→cloud push half of the run, when it ran. Watch mode
   * uses it to keep the poll hot while the user is editing in their engine —
   * pushes never appear in `added`/`modified` (those are pulls).
   */
  pushed?: PushSummary | null;
}

/** Did the push half of a run actually move bytes into MagicPixel? */
export function pushWasActive(pushed: PushSummary | null | undefined): boolean {
  if (!pushed) return false;
  return pushed.created > 0 || pushed.updated > 0 || pushed.imported > 0;
}

/**
 * Two consumers need the local PNG listing: the full-sync orphan sweep (no
 * `since`) and the sha-based rename fallback (incremental, and only when
 * something is download-bound). On an idle incremental tick — the common case
 * now that unchanged manifests come back as a bodyless 304 — neither runs, so
 * walking the whole output tree would be pure waste.
 *
 * Full syncs must ALWAYS walk: skipping there would silently disable pruning.
 */
export function needsLocalPngWalk(since: string | undefined, toDownloadCount: number): boolean {
  return !since || toDownloadCount > 0;
}

export async function syncCommand(opts: SyncOpts): Promise<void> {
  // Sweep any leaked `<file>.<pid>.<hex>.tmp` files left behind by a prior
  // crashed/killed CLI run before they pile up. Runs once per CLI invocation
  // (watch mode included) and only touches files older than 30s, so it can
  // never race a concurrent in-flight write. See util/tmpJanitor.ts.
  try {
    const cfg = await loadConfig();
    try {
      await runTmpJanitor(cfg.outDir);
    } catch {
      /* janitor is best-effort — never let it block a sync */
    }
    await ensureEngineConnect(cfg, process.cwd(), !opts.dryRun);
  } catch {
    /* missing/invalid config is reported by runOnce / watchLoop */
  }
  if (opts.watch) {
    await watchLoop(opts);
    return;
  }
  await runOnce(opts);
}

async function watchLoop(opts: SyncOpts): Promise<void> {
  // Default 2s — matches the perceived-instant UX users expect when editing
  // sprites in MagicPixel and watching them refresh in their game's dev
  // server. Incremental polls send `?since=<lastSync>` so an empty manifest
  // round-trip is cheap (a single HTTP HEAD-sized response with `count: 0`).
  // Commander already validated the numeric value (2–3600); the `?? 2`
  // covers the bare boolean `-w` form.
  const intervalSec = typeof opts.watch === 'string' ? parseInt(opts.watch, 10) : 2;

  // Header — print once on start. Counts are best-effort; if the first
  // manifest fetch fails we still want the loop to come up and retry.
  console.log(kleur.bold('👀 MagicPixel watching for changes…'));
  console.log(`   Edit at:  ${kleur.cyan('https://magicpixel.art')}`);
  let countSpinner: Ora | null = null;
  if (!opts.quiet) {
    try {
      const config = await loadConfig();
      const kind = await detectProjectKind();
      if (isEngineKind(kind) && (config.connect?.length ?? 0) > 0) {
        countSpinner = ora({ text: countingSpritesText(0), spinner: 'dots' }).start();
      }
    } catch {
      /* header is cosmetic */
    }
  }
  const header = await loadWatchHeader(
    countSpinner ? (p) => { countSpinner!.text = countingSpritesText(p); } : undefined,
  );
  if (countSpinner) {
    if (header.line) countSpinner.succeed(header.line.trim());
    else countSpinner.stop();
  } else if (header.line && !opts.quiet) {
    console.log(kleur.dim(header.line));
  }
  console.log(kleur.dim(`   Polling:  every ${intervalSec}s (slows when idle)   ·   Stop: Ctrl+C`));
  console.log();

  let stopping = false;
  let inFlight = false;
  let backoffSec = intervalSec;
  let pausedForAuth = false;
  // Mirrors pausedForAuth for the network-offline path: once we've told the
  // user "MagicPixel is offline", the next successful tick prints a single
  // "back online" recovery line. Without this flag a user who walked away
  // during an outage has no signal that things are healthy again.
  let pausedForNetwork = false;
  // After this many consecutive 401/403s we give up and exit non-zero so a
  // parent process (Vite plugin, systemd, pm2) can tell the watcher is
  // genuinely broken (revoked key) rather than transiently blipped.
  const MAX_AUTH_FAILURES = 5;
  let consecutiveAuthFailures = 0;
  // Adaptive idle backoff: the fast interval is a "hot window" around actual
  // work, not a steady state. After ~1 min of nothing-to-do we slow the poll
  // from intervalSec → 5s, and after ~5 min → 10s, so a dev who walked away
  // isn't polling the manifest hundreds of times an hour. ANY change (pulled
  // OR pushed) or error resets this, so the "edit → see it" promise stays
  // intact the moment the user comes back. Error backoff (2→60s) is separate
  // and continues to win.
  //
  // Idle is measured in wall-clock seconds since the last change, not in
  // ticks: once we've backed off, a "tick" is 5s or 10s long, so counting
  // ticks × intervalSec would undercount elapsed time and push the 5-minute
  // step far past 5 minutes.
  let lastChangeAt = Date.now();

  // Re-walk the game tree on this cadence so new PNGs are ingested without
  // listing thousands of folders on every 2s tick.
  const GAME_INDEX_TTL_MS = 30_000;
  let gameIndexCache = header.gameIndex;
  let gameIndexAt = Date.now();

  // Cancellable idle sleep — `onStopSignal` calls `wakeStop()` so the next
  // tick exits immediately instead of waiting out the full backoff (which can
  // be 60s at the error ceiling). Initialised to a no-op so the first
  // pre-loop `await tick()` is safe even before the first sleep.
  let wakeStop: () => void = () => {};

  // Handle both SIGINT (Ctrl+C) and SIGTERM (`kill`, `docker stop`, systemd,
  // pm2). Without the SIGTERM listener a supervisor-managed watcher would die
  // mid-sync without draining in-flight work or preserving the exit code.
  const onStopSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    wakeStop();
    process.stdout.write('\x1b[2K\r');
    const sig: NodeJS.Signals = signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT';
    if (inFlight) {
      const again = sig === 'SIGINT' ? 'Ctrl+C' : 'SIGTERM';
      console.log(kleur.dim(`Still finishing this check… (${again} again to stop now)`));
      process.once(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143));
    } else {
      if (!opts.quiet) console.log(kleur.dim('Stopped watching.'));
      // Preserve any exit code already set by a prior failed tick.
      process.exit(process.exitCode ?? 0);
    }
  };
  process.on('SIGINT', onStopSignal);
  process.on('SIGTERM', onStopSignal);

  const tick = async () => {
    if (inFlight || stopping) return;
    inFlight = true;
    const onStatus = (msg: string) => {
      if (opts.quiet) return;
      process.stdout.write(`\r\x1b[2K${kleur.dim(`${timestamp()} ${msg}`)}`);
    };
    try {
      onStatus('Checking MagicPixel…');
      const reuseIndex =
        gameIndexCache && Date.now() - gameIndexAt < GAME_INDEX_TTL_MS
          ? gameIndexCache
          : undefined;
      const r = await runOnce(
        { ...opts, watch: false },
        {
          watchMode: true,
          onStatus,
          gameIndex: reuseIndex,
          onGameIndex: (idx) => {
            gameIndexCache = idx;
            gameIndexAt = Date.now();
          },
        },
      );
      // Reset backoff on any successful tick. Resume message fires once when
      // we recover from an auth pause — `getApiKey()` re-reads
      // .magicpixel/credentials on every call, so a `magicpixel login` in
      // another terminal is picked up automatically by the next tick.
      const wasPausedForAuth = pausedForAuth;
      const wasPausedForNetwork = pausedForNetwork;
      backoffSec = intervalSec;
      pausedForAuth = false;
      pausedForNetwork = false;
      consecutiveAuthFailures = 0;
      if (wasPausedForAuth && !opts.quiet) {
        process.stdout.write('\x1b[2K\r');
        console.log(`${kleur.dim(timestamp())} ${kleur.green('✓')} Key accepted again — resuming.`);
      }
      if (wasPausedForNetwork && !wasPausedForAuth && !opts.quiet) {
        process.stdout.write('\x1b[2K\r');
        console.log(`${kleur.dim(timestamp())} ${kleur.green('✓')} Back online — resuming.`);
      }
      const changedCount = r.added.length + r.modified.length + r.removed.length + r.renamed.length;
      // Pushing a locally edited sprite is activity too — it just isn't part of
      // the printed pull list. Without it, an artist working only in Unity
      // would slide into the 10s idle poll while actively saving files.
      if (changedCount > 0 || pushWasActive(r.pushed)) {
        // Snap back to the fast interval the moment anything changes.
        lastChangeAt = Date.now();
        backoffSec = intervalSec;
      } else {
        backoffSec = nextBackoffForIdle((Date.now() - lastChangeAt) / 1000, intervalSec);
      }

      if (opts.quiet) return;
      if (changedCount > 0) {
        process.stdout.write('\x1b[2K\r');
        const verb = r.removed.length && !r.added.length && !r.modified.length ? 'Removed' : 'Pulled';
        console.log(
          `${kleur.dim(timestamp())} ${kleur.green('✓')} ${verb} ${changedCount} ` +
            `change${changedCount === 1 ? '' : 's'} from MagicPixel:`,
        );
        printChanges(r, /* indent */ '  ');
      } else {
        process.stdout.write(`\r\x1b[2K${kleur.dim(`${timestamp()} Waiting for edits… (${r.unchanged} up to date)`)}`);
      }
    } catch (e) {
      const err = e as Error;
      const apiErr = err instanceof ApiError ? err : null;
      const firstLine = err.message.split('\n')[0];
      process.stdout.write('\x1b[2K\r');
      // Any error breaks the idle streak so we come back fast once it clears.
      lastChangeAt = Date.now();

      const decision = classifyTickError(err, {
        backoffSec,
        pausedForAuth,
        pausedForNetwork,
        consecutiveAuthFailures,
        maxAuthFailures: MAX_AUTH_FAILURES,
      });

      if (decision.kind === 'auth') {
        if (!pausedForAuth) {
          // Surface the request id (from B1) so the user can paste it into a
          // support thread and we can correlate against edge function logs.
          const idSuffix = apiErr?.requestId ? kleur.dim(` (request id: ${apiErr.requestId})`) : '';
          console.log(`${kleur.dim(timestamp())} ${kleur.red('✗')} Your key looks invalid or rotated.${idSuffix}`);
          console.log(kleur.dim(`   Fix: run \`${cmd('login')}\` (this watcher will keep retrying every 30s).`));
        }
        pausedForAuth = true;
        consecutiveAuthFailures = decision.consecutiveAuthFailures;
        backoffSec = decision.nextBackoffSec;
        if (decision.giveUp) {
          console.log(
            `${kleur.dim(timestamp())} ${kleur.red('✗')} Giving up after ${MAX_AUTH_FAILURES} consecutive auth failures.`,
          );
          console.log(kleur.dim(`   Fix: run \`${cmd('login')}\` with a fresh key, then restart the watcher.`));
          // Surface this to /admin/errors — persistent watcher auth failure
          // means a key is mass-rejected (revoked, project deleted, edge
          // misconfig) and we want visibility without waiting for a support
          // ping. Awaited so the report flushes before exit.
          const { reportAndExit } = await import('../util/telemetry.js');
          await reportAndExit(err, 'sync (watch)', 2);
        }
      } else if (decision.kind === 'network') {
        consecutiveAuthFailures = 0;
        if (decision.printMessage) {
          const idSuffix = apiErr?.requestId ? kleur.dim(` (request id: ${apiErr.requestId})`) : '';
          console.log(
            `${kleur.dim(timestamp())} ${kleur.yellow('!')} MagicPixel is offline or your internet is. ` +
              `Sprites you already have still work. Retrying in ${decision.nextBackoffSec}s.${idSuffix}`,
          );
        }
        pausedForNetwork = true;
        backoffSec = decision.nextBackoffSec;
      } else {
        consecutiveAuthFailures = 0;
        const idSuffix = apiErr?.requestId ? kleur.dim(` (request id: ${apiErr.requestId})`) : '';
        console.log(`${kleur.dim(timestamp())} ${kleur.red('!')} ${firstLine}${idSuffix}`);
        backoffSec = decision.nextBackoffSec;
      }
    } finally {
      inFlight = false;
    }
  };
  await tick();
  while (!stopping) {
    // Race the sleep against a stop signal so Ctrl+C during a long error-
    // backoff (up to 60s) exits within a tick instead of after the full wait.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeStop = () => {};
        resolve();
      }, backoffSec * 1000);
      wakeStop = () => {
        clearTimeout(timer);
        wakeStop = () => {};
        resolve();
      };
    });
    if (stopping) break;
    // `await tick()` only returns once its `finally` runs (clearing
    // `inFlight`), so the loop naturally drains the in-flight sync on Ctrl+C
    // before we exit — no separate idle-promise dance required.
    await tick();
  }
  if (!opts.quiet) console.log(kleur.dim('Stopped watching.'));
  // Preserve any non-zero exit code set by a failed tick — don't mask a
  // download failure with a clean exit just because the user pressed Ctrl+C.
  process.exit(process.exitCode ?? 0);
}

function isNetworkError(err: Error): boolean {
  // The api layer wraps fetch failures as `manifest: network error (...)`;
  // bare ENOTFOUND/ETIMEDOUT/etc. also surface here from `fetchAssetBytes`.
  // Include 502/504 strings — corporate proxies often surface upstream gateway
  // failures as terse text rather than as ApiError (e.g. 502 from a TLS
  // terminator before our edge function ever sees the request).
  const msg = err.message;
  return (
    /network error/i.test(msg) ||
    /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /\b(502|504)\b.*\b(bad gateway|gateway timeout)\b/i.test(msg)
  );
}

/**
 * Idle thresholds (seconds of consecutive idleness) at which the watcher steps
 * down from the configured interval to 5s, then to 10s. Single source of truth
 * for both the watch loop and its regression tests.
 */
export const IDLE_BACKOFF_THRESHOLDS = { softSec: 60, hardSec: 300 } as const;

/**
 * Pure helper: given how long we've been idle (wall-clock seconds since the
 * last pulled or pushed change) and the configured poll interval, return the
 * next backoff in seconds. Exported so the watch-mode regression test can guard
 * the "ticks vs seconds" bug fixed in 0.4.0 without exercising the full watch
 * loop. Callers pass elapsed time, not tick counts: once the watcher has backed
 * off, ticks are longer than `intervalSec`.
 */
export function nextBackoffForIdle(
  idleSeconds: number,
  intervalSec: number,
  thresholds: { softSec: number; hardSec: number } = IDLE_BACKOFF_THRESHOLDS,
): number {
  if (idleSeconds >= thresholds.hardSec) return Math.max(intervalSec, 10);
  if (idleSeconds >= thresholds.softSec) return Math.max(intervalSec, 5);
  return intervalSec;
}

export interface TickErrorState {
  backoffSec: number;
  pausedForAuth: boolean;
  pausedForNetwork: boolean;
  consecutiveAuthFailures: number;
  maxAuthFailures: number;
}

export type TickErrorDecision =
  | { kind: 'auth'; nextBackoffSec: number; consecutiveAuthFailures: number; giveUp: boolean }
  | { kind: 'network'; nextBackoffSec: number; printMessage: boolean }
  | { kind: 'other'; nextBackoffSec: number };

/**
 * Pure helper: classify a per-tick error and compute the next backoff +
 * counter updates. Extracted so the auth-failure watchdog and the
 * network-recovery message can be unit-tested without spinning up signals or
 * mocking timers.
 *
 * Caller is responsible for performing side effects (logging, `process.exit`,
 * assigning the returned values back onto loop state).
 */
export function classifyTickError(err: Error, state: TickErrorState): TickErrorDecision {
  const apiErr = err instanceof ApiError ? err : null;
  if (apiErr && (apiErr.status === 401 || apiErr.status === 403)) {
    const next = state.consecutiveAuthFailures + 1;
    return {
      kind: 'auth',
      nextBackoffSec: 30,
      consecutiveAuthFailures: next,
      giveUp: next >= state.maxAuthFailures,
    };
  }
  if (isNetworkError(err)) {
    const nextBackoffSec = Math.min(state.backoffSec * 2, 60);
    // Print on the first offline tick, then again whenever backoff changes —
    // capped at 60s so users who walked away still see periodic confirmation
    // the watcher is alive and retrying.
    const printMessage = !state.pausedForNetwork || nextBackoffSec !== state.backoffSec;
    return { kind: 'network', nextBackoffSec, printMessage };
  }
  return { kind: 'other', nextBackoffSec: Math.min(state.backoffSec * 2, 60) };
}

interface RunOpts {
  /** True when called from the watch loop — suppresses the verbose body but
   *  not the change list (the loop prints its own header + list). */
  watchMode?: boolean;
  /** Carriage-return status for long watch ticks (manifest, downloads, push). */
  onStatus?: (msg: string) => void;
  /** Reuse a just-built game index (watch header) so startup doesn't walk twice. */
  gameIndex?: GameIndex;
  /** Watch loop: persist an index we scanned this tick so later ticks can reuse it. */
  onGameIndex?: (index: GameIndex) => void;
}

async function loadWatchHeader(
  onProgress?: (progress: ScanProgress) => void,
): Promise<{ line: string | null; gameIndex?: GameIndex }> {
  try {
    const config = await loadConfig();
    const state = await loadState();
    const lastPulled = state.assets ? Object.keys(state.assets).length : 0;
    let workingSet = 0;
    let gameIndex: GameIndex | undefined;
    const kind = await detectProjectKind();
    if (isEngineKind(kind) && (config.connect?.length ?? 0) > 0) {
      gameIndex = await indexGamePngs(kind, process.cwd(), config.outDir, { onProgress });
      workingSet = matchConnectGlobs(gameIndex, config.connect).total;
    } else if (state.synced) {
      workingSet = Object.keys(state.synced).length;
    }
    return { line: formatWatchSpriteLine({ workingSet, lastPulled }), gameIndex };
  } catch {
    return { line: null };
  }
}

async function runOnce(opts: SyncOpts, runOpts: RunOpts = {}): Promise<SyncResult> {
  const config = await loadConfig();
  const state = await loadState();
  // Seed manifest validators persisted by the previous run so a one-shot sync
  // can answer with a 304 on its very first poll (watchers already keep them
  // in memory). A `--full` run intentionally sends no `since`, which is a
  // different validator key, so it can't be short-circuited by a stale entry.
  primeManifestEtags(state.manifestEtags);

  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  const verbose = !opts.quiet && !runOpts.watchMode;
  const live = !opts.quiet;
  const onStatus = runOpts.onStatus;
  const shouldPrune = opts.prune !== false;  // commander: --no-prune sets false

  if (verbose && config.endpoint) {
    console.log(kleur.yellow(`! using custom endpoint: ${config.endpoint}`));
  }

  // Incremental unless asked for a full run — or unless a full pass is due:
  // permanently-deleted rows can't be reported incrementally (see reconcile.ts).
  const reconcileDue = !opts.full && !!state.lastSync && shouldReconcile(state.lastReconcile, Date.now());
  let since = opts.full || reconcileDue ? undefined : state.lastSync;
  if (reconcileDue && verbose) {
    console.log(kleur.dim('Running a full reconcile (periodic) to clear anything deleted in MagicPixel.'));
  }
  const previousAssets = state.assets ?? {};  // id → key from prior sync

  const spinner: Ora | null = verbose
    ? ora(since ? `Fetching manifest since ${humanTime(since)}…` : 'Fetching manifest…').start()
    : null;
  if (!spinner) onStatus?.(since ? 'Checking MagicPixel for edits…' : 'Fetching your sprites from MagicPixel…');
  let manifest: ManifestEntry[];
  // Composite keys the cloud reports as gone (document trashed / componentized)
  // since our cursor. Empty on --full, where the manifest itself is the truth.
  let removedRemoteKeys: string[] = [];
  // Capture before the Unity filter drops rows — lastSync must not jump past
  // an editor save whose `unity` flag was omitted on this tick.
  let observedUpdatedAt: string | null = null;
  try {
    let snapshot = await fetchManifestSnapshot(config, since);
    if (snapshot.removalsTruncated && since) {
      // The server couldn't list every removal in this window. Trusting the
      // partial list and advancing the cursor would strand the rest forever, so
      // re-read the whole manifest and let the orphan sweep decide.
      if (verbose) {
        console.log(kleur.dim('Many sprites were removed at once — re-reading the full manifest to stay in sync.'));
      }
      since = undefined;
      snapshot = await fetchManifestSnapshot(config, undefined);
    }
    manifest = snapshot.entries;
    removedRemoteKeys = snapshot.removedKeys;
    observedUpdatedAt = maxIsoTimestamp(manifest.map((e) => e.updated_at));

    const projectInfo = getLastProjectInfo();
    const projectSuffix = projectInfo && verbose
      ? kleur.dim(` · project: ${projectInfo.name ?? projectInfo.id.slice(0, 8)}`)
      : '';
    spinner?.succeed(
      `Manifest: ${manifest.length} asset${manifest.length === 1 ? '' : 's'}${since ? kleur.dim(' (incremental)') : ''}${projectSuffix}`,
    );
    // Fresh full sync + zero assets = almost always a project-scope mismatch
    // (the exact case the "0 assets" support flow hits). Server includes a
    // ready-to-print hint on the empty-fresh-sync response; surface it once
    // so the user isn't left wondering why sync "did nothing".
    if (!since && manifest.length === 0 && projectInfo?.hint && verbose) {
      console.log();
      console.log(kleur.yellow(`! ${projectInfo.hint}`));
    }
  } catch (e) {
    spinner?.fail('Manifest fetch failed');
    // One-shot sync / first-run: still import local sprites (ingest is a
    // different host). Watch ticks skip this — otherwise a 546 would POST
    // every PNG every poll.
    if (!runOpts.watchMode) {
      const pushed = await maybePushLocalSprites(config.push, verbose);
      if (verbose && pushed && pushed.created > 0) {
        console.log();
        console.log(kleur.green(`✓ pushed ${pushed.created} working-set sprite${pushed.created === 1 ? '' : 's'} into MagicPixel anyway.`));
        console.log(kleur.dim('  Refresh Connected in the library to see them, then re-run sync to pull.'));
      }
    }
    throw e;
  }

  // Unity projects sync only the artboards flagged "Sync to Unity" in the
  // editor (parity with the in-app sync button). `unitySyncAll: true` in
  // magicpixel.json opts back into everything.
  onStatus?.('Looking through your game sprites…');
  const projectKind = await detectProjectKind();
  const gameIndex = runOpts.gameIndex
    ?? (isEngineKind(projectKind)
      ? await indexGamePngs(projectKind, process.cwd(), config.outDir, {
          onProgress: (p) => {
            const n = p.pngs.toLocaleString('en-US');
            const f = p.folders.toLocaleString('en-US');
            onStatus?.(
              p.current
                ? `Looking through your game sprites…  ${n} sprites · ${f} folders  ·  ${p.current}`
                : p.folders > 0
                  ? `Looking through your game sprites…  ${n} sprites · ${f} folders`
                  : `Looking through your game sprites…  ${n}`,
            );
          },
        })
      : { files: [], capped: false });
  if (!runOpts.gameIndex) runOpts.onGameIndex?.(gameIndex);
  const connected = matchConnectGlobs(gameIndex, config.connect ?? []);
  const sourceByKey = collectSourceRelMap(connected.entries, state.synced);
  aliasCollisionKeys(sourceByKey, manifest.map((e) => e.key));
  if (verbose && gameIndex.capped) {
    console.log(kleur.yellow(`! ${GAME_INDEX_CAP_HINT}`));
  }
  if (verbose && connected.capped) {
    console.log(kleur.yellow(`! ${connectCapMessage(connected.total, connected.entries.length)}`));
  }
  if (verbose && isEngineKind(projectKind)) {
    console.log(
      kleur.dim(
        `  game index → ${gameIndex.files.length} PNG${gameIndex.files.length === 1 ? '' : 's'} · working set ${connected.entries.length}` +
          (connected.capped ? ` of ${connected.total} matched` : ''),
      ),
    );
  }
  const pathForKey = (key: string): string =>
    syncDiskPathFromKey(config.outDir, key, sourceByKey);
  const workingSet = workingSetPullKeys(sourceByKey, state.synced);
  // Files whose artboard is no longer flagged for Unity. Deleted even in
  // incremental mode: un-checking the box in the editor must actually remove
  // the sprite from the game project, not leave a stale copy behind.
  // Working-set (sourceRel) files are never deleted — they're the user's art.
  const deselectedPaths: string[] = [];
  // Sprites whose "Sync to Unity" flag the server omitted. Not downloaded
  // (strict opt-in) but explicitly shielded from pruning: a transient server
  // response must never delete art from someone's game project.
  const unknownFlagPaths = new Set<string>();
  if (projectKind === 'Unity') {
    const filtered = applyUnityPullPolicy(manifest, {
      syncAll: config.unitySyncAll,
      alwaysPull: (entry) => isWorkingSetEntry(entry, workingSet),
    });
    if (filtered.unknown.length > 0) {
      const n = filtered.unknown.length;
      const msg = `${n} artboard${n === 1 ? '' : 's'} came back without a "Sync to Unity" flag — skipped (existing files kept).`;
      if (verbose) {
        console.log(kleur.yellow(`! ${msg}`));
        console.log(kleur.dim(`  Fix: re-run \`${cmd('sync')}\` in a moment, or upgrade with \`npm i -D @magicpixelart/cli@latest\`.`));
      } else {
        onStatus?.(msg);
      }
    }
    const unknownSet = new Set(filtered.unknown);
    const pullSet = new Set(filtered.entries);
    for (const entry of manifest) {
      if (pullSet.has(entry)) continue;
      const p = pathForKey(entry.key);
      if (unknownSet.has(entry)) {
        unknownFlagPaths.add(p);
        continue;
      }
      if (sourceByKey.has(entry.key)) continue;
      if (existsSync(p)) deselectedPaths.push(p);
    }

    if (filtered.noneFlagged) {
      // Nothing flagged for pull — don't dump the library, and don't prune.
      // Local sprites still go up so they appear in MagicPixel on connect.
      if (verbose) {
        console.log();
        console.log(kleur.yellow('! No artboards are flagged "Sync to Unity" — nothing to pull.'));
        console.log(kleur.dim(`  Working-set sprites (\`connect\` in magicpixel.json) still push into MagicPixel.`));
        console.log(kleur.dim('  Flag folders/artboards in the library to pull them back into Unity.'));
      }
      const empty: SyncResult = {
        added: [],
        modified: [],
        removed: [],
        unchanged: 0,
        failed: 0,
        bytesIn: 0,
        bytesSaved: 0,
        renamed: [],
        conflicts: [],
      };
      // Persist validators even when the cursor didn't move, so the next
      // one-shot run starts from a conditional GET.
      const lastSync =
        observedUpdatedAt && !(state.lastSync && state.lastSync > observedUpdatedAt)
          ? observedUpdatedAt
          : state.lastSync;
      await saveState({
        ...state,
        ...(lastSync ? { lastSync } : {}),
        ...(since ? {} : { lastReconcile: startedAt }),
        manifestEtags: manifestEtagsSnapshot(),
      });

      await maybePushLocalSprites(config.push, verbose, gameIndex, live && !!runOpts.watchMode, onStatus);
      return empty;
    }
    const skipped = manifest.length - filtered.entries.length;
    manifest = filtered.entries;
    if (verbose && skipped > 0) {
      console.log(
        kleur.dim(`  unity → ${skipped} artboard${skipped === 1 ? '' : 's'} not flagged for sync (skipped)`),
      );
    }
  }

  // Detect renames: same id, different key vs prior snapshot.
  const renamed: RenameInfo[] = [];
  for (const entry of manifest) {
    const prevKey = previousAssets[entry.id];
    if (prevKey && prevKey !== entry.key) {
      renamed.push({ id: entry.id, oldKey: prevKey, newKey: entry.key });
    }
  }

  for (const r of renamed) {
    const rel = sourceByKey.get(r.oldKey);
    if (rel && !sourceByKey.has(r.newKey)) sourceByKey.set(r.newKey, rel);
  }

  // Compute the disk path once per entry and reuse it across the diff /
  // orphan / download loops — saves three resolves + two security asserts
  // per asset on large projects. Every entry in `manifest` is pre-seeded, so
  // the lookup never misses; non-null assertion is safe.
  const diskPathById = new Map<string, string>();
  for (const entry of manifest) {
    diskPathById.set(entry.id, pathForKey(entry.key));
  }
  const pathFor = (entry: ManifestEntry): string => diskPathById.get(entry.id)!;

  // Diff against disk. SHA pre-check runs through the same concurrency pool
  // used for downloads — on a 1k-asset project that's all-unchanged this is
  // the dominant wall-clock cost of an incremental sync. We cache each result
  // so the download loop can reuse it for `If-None-Match` ETags instead of
  // re-hashing the same file moments later.
  onStatus?.(
    manifest.length > 0
      ? `Comparing ${manifest.length.toLocaleString('en-US')} sprite${manifest.length === 1 ? '' : 's'} with files on disk…`
      : 'Checking MagicPixel…',
  );
  const diffLimit = createLimit(concurrency);
  const shaByEntryId = new Map<string, string | null>();
  const toDownload: ManifestEntry[] = [];
  const conflicts: string[] = [];
  let bytesSaved = 0;
  let unchanged = 0;
  const synced = state.synced ?? {};
  const cloudShaByAssetId = new Map<string, string | 'ambiguous'>();
  for (const s of Object.values(synced)) {
    if (!s.assetId || !s.sha256) continue;
    const prev = cloudShaByAssetId.get(s.assetId);
    if (prev && prev !== s.sha256) cloudShaByAssetId.set(s.assetId, 'ambiguous');
    else if (!prev) cloudShaByAssetId.set(s.assetId, s.sha256);
  }
  const previousCloudSha = (entry: ManifestEntry): string | undefined => {
    const direct = synced[entry.key]?.sha256;
    if (direct) return direct;
    for (const k of entry.previous_keys ?? []) {
      const sha = synced[k]?.sha256;
      if (sha) return sha;
    }
    if (entry.asset_id) {
      const sha = cloudShaByAssetId.get(entry.asset_id);
      if (sha && sha !== 'ambiguous') return sha;
    }
    return undefined;
  };
  await Promise.all(
    manifest.map((entry) =>
      diffLimit(async () => {
        const previousCloudSha256 = previousCloudSha(entry);
        const inWorkingSet = isWorkingSetEntry(entry, workingSet);
        // Unchanged cloud composite: skip hashing the original PNG (it almost
        // never matches) unless the file is gone and we need to restore it.
        if (entry.sha256 && previousCloudSha256 === entry.sha256 && existsSync(pathFor(entry))) {
          shaByEntryId.set(entry.id, null);
          unchanged++;
          if (entry.size_bytes) bytesSaved += entry.size_bytes;
          return;
        }
        const localSha = await fileSha256(pathFor(entry));
        shaByEntryId.set(entry.id, localSha);
        const decision = decidePull({
          cloudSha256: entry.sha256,
          localSha256: localSha,
          previousCloudSha256,
          lastPushedDiskSha256: synced[entry.key]?.diskSha256,
          inWorkingSet,
        });
        if (decision === 'conflict') {
          conflicts.push(entry.key);
        } else if (decision === 'skip') {
          unchanged++;
          if (entry.size_bytes) bytesSaved += entry.size_bytes;
        } else {
          toDownload.push(entry);
        }
      }),
    ),
  );

  // Orphan detection only when we have the full picture.
  // (Renames also produce a stale path on disk — collected separately below.)
  let orphans: string[] = [];
  const remoteDiskPaths = new Set(manifest.map((e) => pathFor(e)));
  const remoteKeySet = new Set(manifest.map((e) => e.key));
  const previousKeySet = new Set(Object.values(previousAssets));

  const localPngs = needsLocalPngWalk(since, toDownload.length)
    ? await walkOutDirPngs(config.outDir)
    : [];

  // Every key we have ever synced, indexed by the disk path it maps to. Used
  // both for orphan tracking and to look up a prune candidate's edit baseline.
  const keyByPath = new Map<string, string>();
  for (const key of Object.keys(state.synced ?? {}).concat(Object.values(previousAssets))) {
    try {
      const p = pathForKey(key);
      if (!keyByPath.has(p)) keyByPath.set(p, key);
    } catch {
      /* unusable key — nothing to track */
    }
  }

  // Sprites created in Unity (or any PNG we never pulled) are pending a
  // push into MagicPixel, not orphans — see prunePolicy.ts.
  if (!since) {
    const policy = selectFullSyncOrphans({
      localPaths: localPngs.map((a) => a.abs),
      remoteDiskPaths,
      protectedPaths: unknownFlagPaths,
      isTracked: (p) => keyByPath.has(p),
    });
    orphans = policy.orphans;
  }

  // Heuristic-rename fallback for incremental mode.
  //
  // If `state.json` was lost or got out of sync (rare, but the 0.5.x leak of
  // `state.json.<pid>.<hex>.tmp` files proved it happens in practice — see
  // CHANGELOG 0.5.1), `previousAssets` won't have the mapping needed to mark
  // a renamed artboard. The old `<oldSlug>.png` then lingers forever next to
  // the new `<newSlug>.png` because incremental mode skips the full orphan
  // sweep.
  //
  // Bridge that gap: for every download-bound entry, look for a stranded
  // local PNG (path not in this manifest) whose sha256 matches the entry's.
  // Same bytes + manifest no longer references that path = same artboard,
  // renamed. We add the stranded path to `renameStalePaths` and record a
  // RenameInfo so the CLI prints the migration hint.
  if (since && toDownload.length > 0) {
    const strandedBySha = new Map<string, string>();
    for (const local of localPngs) {
      if (remoteDiskPaths.has(local.abs)) continue;
      const sha = await fileSha256(local.abs);
      if (sha) strandedBySha.set(sha, local.abs);
    }
    if (strandedBySha.size > 0) {
      const outRoot = resolve(process.cwd(), config.outDir);
      const seenRenameIds = new Set(renamed.map((r) => r.id));
      for (const entry of toDownload) {
        if (!entry.sha256) continue;
        if (seenRenameIds.has(entry.id)) continue;
        const strandedPath = strandedBySha.get(entry.sha256);
        if (!strandedPath) continue;
        // Derive the disk key from the stranded path so the rename hint reads
        // naturally (`cards/artboard-1 → cards/tree`).
        const rel = relative(outRoot, strandedPath).replace(/\\/g, '/');
        const oldKey = rel.endsWith('.png') ? rel.slice(0, -4) : rel;
        renamed.push({ id: entry.id, oldKey, newKey: entry.key });
        seenRenameIds.add(entry.id);
      }
    }
  }

  // Stale paths from detected renames (always pruned, even in incremental mode —
  // otherwise the old PNG silently lingers next to the renamed copy).
  const outRoot = resolve(process.cwd(), config.outDir);
  const renameStalePaths = renamed
    .map((r) => {
      try {
        return pathForKey(r.oldKey);
      } catch {
        return '';
      }
    })
    .filter((p) => p && existsSync(p) && isPathInside(p, outRoot));
  // Every prune candidate goes through `addOrphan`, so no source can bypass the
  // local-edit guard applied below. De-duplicates vs the full-sync orphan list.
  const orphanSet = new Set(orphans);
  const addOrphan = (p: string) => {
    if (existsSync(p) && isPathInside(p, outRoot)) orphanSet.add(p);
  };
  for (const p of renameStalePaths) addOrphan(p);
  // Un-checked "Sync to Unity" artboards: their PNG (and .meta) leaves the
  // Unity project on the next sync, incremental or not. Working-set originals
  // are never in this list.
  for (const p of deselectedPaths) addOrphan(p);

  // Server-side rename history. Each manifest entry carries the composite
  // keys this row was previously emitted under (populated by the editor when
  // a doc/artboard is renamed). For each prior key whose file is still on
  // disk and is NOT shadowed by a live manifest entry, we add a rename hint
  // + prune target — so cruft like `untitled-19/untitled.png` evaporates on
  // the next sync without the user having to clean it up manually.
  const prevKeyResult = computePreviousKeyOrphans({
    manifest,
    remoteDiskPaths,
    resolveDiskPath: (key) => pathForKey(key),
    fileExists: existsSync,
  });
  for (const p of prevKeyResult.orphanPaths) addOrphan(p);
  for (const r of prevKeyResult.renames) {
    if (!renamed.some((x) => x.id === r.id && x.oldKey === r.oldKey)) {
      renamed.push(r);
    }
  }

  // Cloud-side removals (document trashed, or converted into a component
  // master). These rows leave the manifest entirely, so an incremental run has
  // no other way to learn about them — without this the PNG would live on in
  // the game project forever. Only keys we pulled ourselves are eligible:
  // a same-named sprite authored in Unity is pending push, not an orphan.
  for (const key of removedRemoteKeys) {
    if (remoteKeySet.has(key)) continue; // still live under another row
    if (!synced[key] && !previousKeySet.has(key)) continue; // never ours
    try {
      addOrphan(pathForKey(key));
    } catch {
      continue;
    }
  }

  // A locally-edited file is never deleted, whatever put it in the prune set
  // (deselected "Sync to Unity", trashed document, rename fallback,
  // previous-key sweep): that edit is the only copy of the work until the user
  // pushes it or discards it. Manifest-resident conflicts were already detected
  // during the diff, so they skip the re-hash.
  const conflictPaths = new Set<string>();
  for (const key of conflicts) {
    try {
      conflictPaths.add(pathForKey(key));
    } catch {
      /* unusable key — nothing to protect */
    }
  }
  orphans = [];
  const keptFromPrune: string[] = [];
  for (const p of orphanSet) {
    if (conflictPaths.has(p)) continue;
    const key = keyByPath.get(p);
    if (
      key &&
      (await hasUnpushedLocalEdit({ absPath: p, baselineDiskSha256: synced[key]?.diskSha256 }))
    ) {
      keptFromPrune.push(key);
      continue;
    }
    orphans.push(p);
  }
  conflicts.push(...keptFromPrune);


  // Legacy-suffix folder sweep — always runs, even in incremental mode.
  //
  // Background: server-side slug uniqueness rules have changed over time
  // (e.g. per-user → per-project). A doc that used to live under
  // `outDir/cards-2/` may now report slug `cards` in the manifest. If the
  // CLI's prior snapshot doesn't have the old id→key mapping (fresh clone,
  // CI runner, snapshot wipe), rename detection finds nothing and the stale
  // folder lingers next to the current one, breaking the user's imports of
  // `@/assets/.../cards-2/...`.
  //
  // We detect this by looking for top-level disk folders whose name matches
  // `<currentSlug>-<n>` for any slug currently in the manifest. Those are
  // unambiguously legacy suffix collisions. We prune the whole folder
  // (when --prune is on) and surface a clear "update your imports" notice
  // so the user knows their source code references must be migrated.
  // Build the "known top-level slugs" set from BOTH the current manifest AND
  // the prior id→key snapshot. In incremental (`--watch`) mode the manifest
  // only contains rows changed since `lastSync`, so a user with two
  // legitimate sibling slugs (`tiles/` + `tiles-2/`) would lose `tiles-2/`
  // the moment only `tiles` appeared in a delta. Pulling from
  // `previousAssets` (the persisted full snapshot) closes that hole.
  const knownFolderSlugs = new Set<string>();
  for (const e of manifest) {
    if (e.folder) knownFolderSlugs.add(e.folder.split('/')[0]);
  }
  for (const key of Object.values(previousAssets)) {
    const top = key.split('/')[0];
    if (top) knownFolderSlugs.add(top);
  }
  const legacyFolders = await findLegacySuffixFolders(config.outDir, knownFolderSlugs);

  if (verbose) {
    console.log();
    console.log(kleur.bold('Plan:'));
    console.log(`  ${kleur.green('+')} download ${toDownload.length}`);
    console.log(`  ${kleur.dim('=')} unchanged ${unchanged}${bytesSaved ? kleur.dim(` (~${formatBytes(bytesSaved)} saved)`) : ''}`);
    if (renamed.length) console.log(`  ${kleur.cyan('↪')} renamed ${renamed.length}`);
    if (legacyFolders.length) {
      const verb = shouldPrune ? kleur.red('delete') : kleur.yellow('keep');
      console.log(`  ${verb} ${legacyFolders.length} legacy slug folder${legacyFolders.length === 1 ? '' : 's'}`);
    }
    if (since && !renamed.length) {
      console.log(`  ${kleur.dim('orphan check skipped (incremental — use --full)')}`);
    } else if (orphans.length > 0) {
      const verb = shouldPrune ? kleur.red('delete') : kleur.yellow('keep (orphan)');
      console.log(`  ${verb} ${orphans.length}`);
    }
    console.log();
  }

  if (conflicts.length > 0) {
    if (live) {
      printConflicts(conflicts, new Set(keptFromPrune));
    }
    onStatus?.(
      `${conflicts.length} sprite${conflicts.length === 1 ? '' : 's'} changed in both places — kept your local copy.`,
    );
  }

  if (opts.dryRun) {
    if (verbose) {
      console.log(kleur.dim('--dry-run: no files written.'));
      if (renamed.length > 0) printRenames(renamed, { withHints: false });
      if (orphans.length > 0) printOrphans(orphans);
      if (legacyFolders.length > 0) printLegacyFolders(legacyFolders);
    }
    return {
      added: [],
      modified: [],
      unchanged,
      removed: [],
      renamed,
      failed: 0,
      bytesIn: 0,
      bytesSaved,
      conflicts,
    };
  }

  const result: SyncResult = {
    added: [],
    modified: [],
    unchanged,
    removed: [],
    renamed,
    failed: 0,
    bytesIn: 0,
    bytesSaved,
    conflicts,
  };

  let progress: Ora | null = null;
  if (live && toDownload.length > 0) {
    onStatus?.(`Pulling ${toDownload.length.toLocaleString('en-US')} updated sprite${toDownload.length === 1 ? '' : 's'}…`);
    progress = ora({ text: progressText(0, toDownload.length, 0), spinner: 'dots' }).start();
  }

  const run = createLimit(concurrency);
  let done = 0;
  await Promise.all(
    toDownload.map((entry) =>
      run(async () => {
        const diskPath = pathFor(entry);
        const existedBefore = existsSync(diskPath);
        try {
          // Reuse the SHA computed during the diff pre-check — re-hashing the
          // same file moments later was a measurable cost on large projects.
          const localSha = shaByEntryId.get(entry.id) ?? null;
          const bytes = await fetchAssetBytes(config, entry.key, localSha);
          if (bytes === null) {
            // Server returned 304 (ETag matched). Credit the asset's manifest
            // size to bytesSaved so the end-of-sync summary reflects the
            // bandwidth the conditional GET avoided.
            //
            // Invariant: we only reach here for entries that made it into
            // `toDownload`, i.e. the disk-SHA pre-check above did NOT credit
            // them (typically because `entry.sha256` was null in the manifest
            // but the ETag still matched server-side). So no double-counting.
            result.unchanged++;
            if (entry.size_bytes) result.bytesSaved += entry.size_bytes;
          } else {
            // Do not require bytes to match `entry.sha256`. Single-artboard
            // downloads serve storage_path (so 2048/4096 Unity tiles do not
            // 546 the isolate); that PNG can differ from a cached composite hash.
            //
            // NOTE: Asset PNGs deliberately use a direct writeFile rather than
            // atomicWrite. Vite's chokidar watcher only suppresses atomic-rename
            // unlink/add pairs when the tmp filename starts with '.' or ends
            // with '~'; our pattern <name>.<pid>.<hex>.tmp matches neither, so
            // rename-over emits unlink+add instead of change, which breaks
            // instant HMR for image imports in the browser (user has to hard
            // refresh to see the new asset). A torn write here is self-healing
            // on the next watch tick (re-download by sha mismatch), so the
            // atomicity guarantee isn't worth the HMR regression. Do not
            // "fix" this back to atomicWrite without also changing the
            // tmp-name pattern AND verifying HMR end-to-end in a consumer app.
            try {
              await assertSafeIoPath(diskPath, process.cwd(), { forWrite: true });
              await mkdir(dirname(diskPath), { recursive: true });
              await writeFile(diskPath, bytes);
            } catch (fsErr) {
              throw friendlyFsError(fsErr, {
                operation: `Writing asset`,
                path: diskPath,
                hint: sourceByKey.has(entry.key)
                  ? 'Sync can\'t continue until the original game file is writable.'
                  : `Sync can't continue until outDir (${config.outDir}) is writable.`,
              });
            }
            if (existedBefore) result.modified.push(entry.key);
            else result.added.push(entry.key);
            result.bytesIn += bytes.byteLength;
          }
        } catch (e) {
          result.failed++;
          progress?.stop();
          // Multi-line messages come from friendlyFsError — print all lines
          // so the user sees the fix hint. Single-line errors stay terse.
          const msg = (e as Error).message ?? String(e);
          if (msg.includes('\n')) {
            console.log(`  ${kleur.red('!')} ${entry.key}:`);
            for (const line of msg.split('\n')) console.log(`     ${line}`);
          } else {
            console.log(`  ${kleur.red('!')} ${entry.key}: ${msg}`);
          }
          progress?.start();
        } finally {
          done++;
          if (progress) progress.text = progressText(done, toDownload.length, result.bytesIn);
        }
      }),
    ),
  );
  const downloaded = result.added.length + result.modified.length;
  if (progress) {
    if (runOpts.watchMode) {
      progress.stop();
    } else if (result.failed === 0) {
      progress.succeed(`Downloaded ${downloaded} (${formatBytes(result.bytesIn)})`);
    } else {
      progress.warn(`Downloaded ${downloaded}, failed ${result.failed} (${formatBytes(result.bytesIn)})`);
    }
  }

  // Unity: write pixel-art-correct `.meta` sidecars so sprites import with
  // point filtering / no compression instead of Unity's blurry defaults —
  // parity with the in-app "Sync to Unity" button. Only missing sidecars are
  // written, so importer settings the user tweaked in Unity are preserved.
  if (projectKind === 'Unity') {
    const meta = await writeMissingUnityMetas(
      manifest
        .filter((entry) => !sourceByKey.has(entry.key))
        .map((entry) => ({ id: entry.id, pngPath: pathFor(entry) })),
      config.unityPpu ?? DEFAULT_UNITY_PPU,
    );
    if (verbose && meta.written > 0) {
      console.log(
        kleur.dim(`  unity → ${meta.written} .meta file${meta.written === 1 ? '' : 's'} written`),
      );
    }
    if (verbose && meta.failed > 0) {
      console.log(
        kleur.yellow(
          `  ! ${meta.failed} .meta file${meta.failed === 1 ? '' : 's'} could not be written — Unity will use default import settings.`,
        ),
      );
    }
  }

  // Prune (now default — pass --no-prune to opt out).
  if (shouldPrune && orphans.length > 0) {
    const pruneRoot = resolve(process.cwd(), config.outDir);
    for (const p of orphans) {
      if (!isPathInside(p, pruneRoot)) continue;
      assertPathInsideRoot(p, pruneRoot, 'outDir');
      try {
        await unlink(p);
        // Unity sidecar follows its PNG — a stranded .meta shows up in Unity
        // as a missing-asset warning.
        await unlink(`${p}.meta`).catch(() => {});
        const relPath = relative(pruneRoot, p).replace(/\\/g, '/');
        const key = relPath.endsWith('.png') ? relPath.slice(0, -4) : relPath;
        result.removed.push(key);
        if (verbose) console.log(`  ${kleur.red('-')} ${relative(process.cwd(), p)}`);
      } catch (e) {
        if (verbose) console.log(`  ${kleur.yellow('!')} failed to prune ${relative(process.cwd(), p)}: ${(e as Error).message}`);
      }
    }
    await pruneEmptyDirs(resolve(process.cwd(), config.outDir));
  } else if (verbose && orphans.length > 0) {
    printOrphans(orphans);
  }

  // Legacy-suffix folder sweep. Runs in BOTH full and incremental mode so a
  // user who is hot off a server-side slug rule change recovers without
  // having to remember `--full`. Folders are deleted whole (children
  // included) because every PNG inside is, by definition, stale; their
  // canonical copies live under the de-suffixed folder we just downloaded.
  if (shouldPrune && legacyFolders.length > 0) {
    const outRoot = resolve(process.cwd(), config.outDir);
    for (const lf of legacyFolders) {
      assertPathInsideRoot(lf.abs, outRoot, 'outDir');
      try {
        await rm(lf.abs, { recursive: true, force: true });
        // Push a synthetic key so the watch loop's changedCount picks this up
        // (otherwise a tick that ONLY swept legacy folders reports "no changes").
        result.removed.push(`${lf.legacyName}/ (legacy)`);
        if (verbose) {
          console.log(
            `  ${kleur.red('-')} ${relative(process.cwd(), lf.abs)} ${kleur.dim(`(legacy slug — now ${lf.currentSlug}/)`)}`,
          );
        }
      } catch (e) {
        if (verbose) console.log(`  ${kleur.yellow('!')} failed to remove legacy folder ${relative(process.cwd(), lf.abs)}: ${(e as Error).message}`);
      }
    }
    // Always surface the import-update notice — even in --quiet/watch mode
    // — because user source code now references paths that no longer exist.
    printLegacyFolders(legacyFolders);
  } else if (verbose && legacyFolders.length > 0) {
    printLegacyFolders(legacyFolders);
  }

  // Always persist the id → key snapshot so rename detection survives even
  // when `emitIndex` is toggled off-then-on. `lastSync` only advances on a
  // clean run, so partial-failure syncs are retried from the prior cursor.
  const nextAssets: Record<string, string> = { ...previousAssets };
  // Drop renamed ids (they'll be re-added with the new key below).
  for (const r of renamed) delete nextAssets[r.id];
  for (const e of manifest) nextAssets[e.id] = e.key;
  // Drop ids whose key was pruned (orphans we just removed from disk).
  if (result.removed.length > 0) {
    const removedKeys = new Set(result.removed);
    for (const [id, key] of Object.entries(nextAssets)) {
      if (removedKeys.has(key)) delete nextAssets[id];
    }
  }
  // Address book for `magicpixel push`: composite key → artboard + the sha we
  // just put on disk. Keyed by key (not id) so a disk walk can look it up
  // without re-fetching the manifest. Renamed/pruned keys are dropped so a
  // stale entry can never send an edit to the wrong artboard.
  const nextSynced: Record<string, SyncedSprite> = { ...(state.synced ?? {}) };
  for (const r of renamed) {
    delete nextSynced[r.oldKey];
  }
  for (const key of result.removed) delete nextSynced[key];
  const writtenKeys = new Set([...result.added, ...result.modified]);
  const conflictSet = new Set(conflicts);
  for (const entry of manifest) {
    if (!entry.asset_id) continue;
    // Conflicted keys keep their old baselines: recording the new cloud sha
    // (with the locally-edited disk sha) would make both halves believe they
    // are in sync and freeze the divergence forever.
    if (conflictSet.has(entry.key)) continue;
    const sha = entry.sha256 ?? (await fileSha256(pathFor(entry)));
    if (!sha) continue;
    const prev = nextSynced[entry.key];
    const diskSha256 = writtenKeys.has(entry.key)
      ? sha
      : (shaByEntryId.get(entry.id) ?? prev?.diskSha256 ?? sha);
    const sourceRel = sourceByKey.get(entry.key);
    // Legacy single-PNG rows have no artboard address (`layer_idx: -1`). Record
    // them anyway, flagged, so `push` skips them with a hint instead of
    // adopting the same art as a second document.
    if (typeof entry.layer_idx !== 'number' || entry.layer_idx < 0) {
      nextSynced[entry.key] = { assetId: entry.asset_id, layerIdx: 0, sha256: sha, diskSha256, legacy: true, ...(sourceRel ? { sourceRel } : {}) };
      continue;
    }
    nextSynced[entry.key] = {
      assetId: entry.asset_id,

      layerIdx: entry.layer_idx,
      sha256: sha,
      diskSha256,
      ...(typeof entry.layer_count === 'number' ? { layers: entry.layer_count } : {}),
      ...(sourceRel ? { sourceRel } : {}),
    };
  }
  const nextState: SyncState = {
    ...state,
    assets: nextAssets,
    synced: nextSynced,
    manifestEtags: manifestEtagsSnapshot(),
    // A completed full pass is the only run that can prove nothing is orphaned.
    ...(!since && result.failed === 0 ? { lastReconcile: startedAt } : {}),
  };

  // Unresolved conflicts hold the cursor, exactly like a failed download: the
  // next sync must see the same rows again and re-report them.
  if (result.failed === 0 && conflicts.length === 0) {
    // Advance the cursor to the newest row we actually observed, NOT the
    // wall-clock time the sync started. Using startedAt silently skipped
    // rows whose `updated_at` lived in the gap between the manifest snapshot
    // and the next poll (notably when only metadata changed — e.g. artboard
    // renames — and the row updated between fetch start and save).
    const maxUpdatedAt = observedUpdatedAt ?? maxIsoTimestamp(manifest.map((e) => e.updated_at));
    if (maxUpdatedAt) {
      // Take the later of: newest row we saw, or the prior cursor. Never
      // rewind — an incremental sync that returned 0 rows must keep the
      // existing lastSync (otherwise we'd re-download history next tick).
      nextState.lastSync =
        state.lastSync && state.lastSync > maxUpdatedAt ? state.lastSync : maxUpdatedAt;
    } else if (state.lastSync) {
      nextState.lastSync = state.lastSync;
    } else {
      // No prior cursor and an empty manifest (fresh project): fall back to
      // startedAt so future incremental polls have a baseline.
      nextState.lastSync = startedAt;
    }
    delete nextState.lastError;
  } else if (result.failed > 0) {
    nextState.lastError = `${result.failed} download${result.failed === 1 ? '' : 's'} failed at ${startedAt}`;
  } else {
    nextState.lastError =
      `${conflicts.length} sprite${conflicts.length === 1 ? '' : 's'} changed both locally and in MagicPixel at ${startedAt}` +
      ` (${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? ', …' : ''})`;
  }

  // Emit typed index from the filesystem — never from the manifest. This
  // guarantees the barrel can never disagree with what bundlers see on disk,
  // and removes the silent-failure mode where a flaky manifest call left
  // `index.ts` stale despite the PNGs being fresh.
  if (config.emitIndex) {
    const idByKey: Record<string, string> = {};
    for (const [id, key] of Object.entries(nextAssets)) idByKey[key] = id;
    const diskEntries = await scanDiskAssets(config.outDir);
    for (const e of diskEntries) {
      if (idByKey[e.key]) e.id = idByKey[e.key];
    }
    const indexPath = await emitTypedIndex(config.outDir, diskEntries);
    if (verbose) console.log(kleur.dim(`  index → ${relative(process.cwd(), indexPath)}`));
  }

  // AGENTS.md hint is always written — `public/` and `static/` users
  // (emitIndex: false) need the absolute-URL snippet just as much as
  // bundler-importable outDir users need the ES-import one.
  // `ensureAgentsDoc` no-ops once our marker section is present.
  try {
    const agentsResult = await ensureAgentsDoc(config.outDir);
    if (verbose && agentsResult !== 'unchanged') {
      console.log(kleur.dim(`  AGENTS.md ${agentsResult}`));
    }
  } catch {
    // Never let an AGENTS.md write failure break sync.
  }

  await saveState(nextState);

  if (result.failed > 0 && verbose) {
    console.log(kleur.yellow(`\n${result.failed} download${result.failed === 1 ? '' : 's'} failed — lastSync not advanced. Re-run to retry.`));
  }

  if (verbose) {
    console.log();
    const summary =
      `downloaded ${downloaded} (added ${result.added.length}, modified ${result.modified.length}), ` +
      `unchanged ${result.unchanged}` +
      (result.bytesSaved ? kleur.dim(` (~${formatBytes(result.bytesSaved)} saved)`) : '') +
      (shouldPrune ? `, pruned ${result.removed.length}` : '') +
      (renamed.length ? `, renamed ${renamed.length}` : '') +
      (result.failed ? `, failed ${result.failed}` : '');
    console.log(result.failed ? kleur.yellow(`done with errors. ${summary}`) : kleur.green(`✓ done. ${summary}`));
    // Per-file change list. Suppress renames here — printRenames below owns
    // the rename block (it adds the import-update hints). Letting both fire
    // would print each rename twice.
    printChanges(result, '  ', { includeRenames: renamed.length === 0 });
    if (renamed.length > 0) printRenames(renamed, { withHints: true });
  }

  onStatus?.('Checking your game files…');
  const pushed = await maybePushLocalSprites(
    config.push,
    verbose,
    gameIndex,
    live && !!runOpts.watchMode,
    onStatus,
  );

  if (result.failed) process.exitCode = 1;
  return { ...result, pushed };
}

async function maybePushLocalSprites(
  pushEnabled: boolean | undefined,
  verbose: boolean,
  gameIndex?: GameIndex,
  announceErrors = verbose,
  onStatus?: (msg: string) => void,
): Promise<PushSummary | null> {
  if (pushEnabled === false) return null;
  try {
    return await runPush({ quiet: !verbose, gameIndex, onStatus });
  } catch (e) {
    if (announceErrors) {
      console.log();
      console.log(kleur.yellow(`! could not update MagicPixel from your game files: ${(e as Error).message}`));
      console.log(kleur.dim(`  Fix: run \`${cmd('push')}\` once the connection is healthy.`));
    }
    return null;
  }
}

const CHANGE_PRINT_CAP = 50;

function printChanges(r: SyncResult, indent: string, opts: { includeRenames: boolean } = { includeRenames: true }): void {
  const lines: string[] = [];
  for (const k of r.added) lines.push(`${indent}${kleur.green('+')} ${k}`);
  for (const k of r.modified) lines.push(`${indent}${kleur.cyan('~')} ${k}`);
  if (opts.includeRenames) {
    for (const r2 of r.renamed) lines.push(`${indent}${kleur.cyan('↪')} ${r2.oldKey} → ${r2.newKey}`);
  }
  for (const k of r.removed) lines.push(`${indent}${kleur.red('-')} ${k}`);
  if (lines.length === 0) return;
  if (lines.length <= CHANGE_PRINT_CAP) {
    for (const l of lines) console.log(l);
  } else {
    for (const l of lines.slice(0, CHANGE_PRINT_CAP)) console.log(l);
    console.log(`${indent}${kleur.dim(`…and ${lines.length - CHANGE_PRINT_CAP} more`)}`);
  }
}

function printRenames(renamed: RenameInfo[], opts: { withHints: boolean }): void {
  if (renamed.length === 0) return;
  console.log();
  console.log(opts.withHints ? kleur.bold('Renamed assets — update imports:') : kleur.cyan('Renames detected:'));
  for (const r of renamed) {
    console.log(`  ${kleur.cyan('↪')} ${r.oldKey} → ${r.newKey}`);
    if (opts.withHints) {
      console.log(`    ${kleur.dim(`MagicPixelAssets['${r.oldKey}']  →  MagicPixelAssets['${r.newKey}']`)}`);
      console.log(`    ${kleur.dim(`or pin to id:  MagicPixelAssetsById['${r.id}']  (survives future renames)`)}`);
    }
  }
}

function progressText(done: number, total: number, bytes: number): string {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const barWidth = 24;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  return `${bar}  ${done}/${total}  ${kleur.dim(formatBytes(bytes))}`;
}

function timestamp(): string {
  const d = new Date();
  return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
}

function humanTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Both-sides-changed report. Printed on every run that has conflicts (also in
 * watch mode) because the alternative — staying silent — is what makes a lost
 * edit feel like a sync bug.
 */
function printConflicts(keys: string[], removedRemotely: ReadonlySet<string> = new Set()) {
  console.log();
  console.log(
    kleur.yellow(`${keys.length} sprite${keys.length === 1 ? '' : 's'} changed in both places — not overwritten:`),
  );
  for (const key of keys) {
    const note = removedRemotely.has(key) ? kleur.dim(' (no longer synced from MagicPixel)') : '';
    console.log(`  ${kleur.yellow('~')} ${key}${note}`);
  }
  console.log(
    kleur.dim(
      `  Keep the local edit: run \`${cmd('push')}\` (it will report the cloud change), or delete the PNG to accept MagicPixel's copy.`,
    ),
  );
  if (removedRemotely.size > 0) {
    console.log(
      kleur.dim(
        `  Marked (no longer synced): re-check "Sync to Unity" (or restore the document) to push the edit up, or delete the PNG to accept the removal.`,
      ),
    );
  }
}

function printOrphans(orphans: string[]) {
  console.log();
  console.log(kleur.yellow(`Orphaned local files (not in manifest):`));
  for (const p of orphans) {
    console.log(`  ${kleur.dim('?')} ${relative(process.cwd(), p)}`);
  }
  console.log(kleur.dim('  You passed --no-prune, so these were kept. Remove the flag to delete them.'));
}

export interface LegacyFolder {
  /** Absolute path of the stale `<slug>-N/` folder on disk. */
  abs: string;
  /** Just the folder basename, e.g. `cards-2`. */
  legacyName: string;
  /** The de-suffixed slug currently in the manifest, e.g. `cards`. */
  currentSlug: string;
}

/**
 * Find top-level disk folders whose name matches `<currentSlug>-<n>` for some
 * slug present in the manifest. These are unambiguously legacy artifacts
 * from a server-side slug rule change (e.g. per-user → per-project
 * uniqueness) — the canonical copy now lives under `<currentSlug>/`, and the
 * suffixed folder's PNGs are stale.
 *
 * Only scans the FIRST level under outDir; nested folders are user content.
 * Returns `[]` when outDir doesn't exist or when no remote slugs are known
 * (defensive — never wipe folders when we have no manifest to compare to).
 */
export async function findLegacySuffixFolders(
  outDir: string,
  knownFolderSlugs: Set<string>,
  cwd: string = process.cwd(),
): Promise<LegacyFolder[]> {
  if (knownFolderSlugs.size === 0) return [];
  const root = resolve(cwd, outDir);
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LegacyFolder[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    // Skip folders that ARE known slugs — only suffixed siblings are suspect.
    if (knownFolderSlugs.has(ent.name)) continue;
    const m = /^(.+)-(\d+)$/.exec(ent.name);
    if (!m) continue;
    const base = m[1];
    if (!knownFolderSlugs.has(base)) continue;
    out.push({
      abs: resolve(root, ent.name),
      legacyName: ent.name,
      currentSlug: base,
    });
  }
  return out;
}

function printLegacyFolders(legacy: LegacyFolder[]): void {
  if (legacy.length === 0) return;
  console.log();
  console.log(kleur.bold('Legacy slug folders removed — update your imports:'));
  for (const lf of legacy) {
    console.log(`  ${kleur.red('-')} ${lf.legacyName}/  ${kleur.dim(`→ now ${lf.currentSlug}/`)}`);
    console.log(`    ${kleur.dim(`Find/replace in your project:  ${lf.legacyName}/  →  ${lf.currentSlug}/`)}`);
  }
}

// Note: orphan scan delegates to `walkOutDirPngs` in util/paths.ts (shared
// with the typed-index emitter). `maxIsoTimestamp` lives in util/iso.ts.
