import kleur from 'kleur';
import ora, { type Ora } from 'ora';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, rename, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { loadConfig, loadState, saveState, type SyncState } from '../config.js';
import { fetchAllManifest, fetchAssetBytes, ApiError, type ManifestEntry } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { assetDiskPath, assetDiskPathFromKey, pruneEmptyDirs, walkOutDirPngs } from '../util/paths.js';
import { createLimit } from '../util/limit.js';
import { emitTypedIndex, ensureAgentsDoc, scanDiskAssets } from '../util/emitIndex.js';
import { assertPathInsideRoot, tmpPathFor } from '../util/security.js';
import { friendlyFsError } from '../util/errors.js';
import { maxIsoTimestamp } from '../util/iso.js';
import { formatBytes } from '../util/format.js';

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
}

export async function syncCommand(opts: SyncOpts): Promise<void> {
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

  // Header — print once on start. Project/asset count is best-effort; if the
  // first manifest fetch fails we still want the loop to come up and retry.
  let headerCount: number | null = null;
  try {
    const state = await loadState();
    headerCount = state.assets ? Object.keys(state.assets).length : null;
  } catch {
    // ignore — header is cosmetic
  }
  console.log(kleur.bold('👀 MagicPixel watching for changes…'));
  console.log(`   Edit at:  ${kleur.cyan('https://magicpixel.art')}`);
  if (headerCount !== null) console.log(kleur.dim(`   Sprites:  ${headerCount}`));
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
  // Adaptive idle backoff: after a few minutes of nothing-to-do we slow the
  // poll from intervalSec → 5s → 10s so a dev who walked away isn't hammering
  // the manifest endpoint. ANY change OR error resets this back to intervalSec,
  // so the "edit → see it" promise stays intact the moment the user comes
  // back. Error backoff (2→60s) is separate and continues to win.
  let consecutiveIdleTicks = 0;
  // Thresholds in seconds (NOT ticks) so a `--watch 10` user gets the same
  // ~3 min / ~15 min UX as a default `--watch 2` user. Previously these were
  // tick counts (90 / 300) which made the slowdown timing scale with intervalSec.
  const IDLE_SOFT_BACKOFF_SECONDS = 180;
  const IDLE_HARD_BACKOFF_SECONDS = 900;

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
    if (inFlight) {
      console.log(kleur.dim(`[watch] finishing current sync… (${signal} again to force quit)`));
      process.once(signal, () => process.exit(signal === 'SIGINT' ? 130 : 143));
    } else {
      if (!opts.quiet) console.log(kleur.dim('[watch] stopped.'));
      // Preserve any exit code already set by a prior failed tick.
      process.exit(process.exitCode ?? 0);
    }
  };
  process.on('SIGINT', onStopSignal);
  process.on('SIGTERM', onStopSignal);

  const tick = async () => {
    if (inFlight || stopping) return;
    inFlight = true;
    try {
      const r = await runOnce({ ...opts, watch: false }, { watchMode: true });
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
      if (changedCount > 0) {
        // Snap back to the fast interval the moment anything changes.
        consecutiveIdleTicks = 0;
        backoffSec = intervalSec;
      } else {
        consecutiveIdleTicks++;
        backoffSec = nextBackoffForIdle(consecutiveIdleTicks, intervalSec, {
          softSec: IDLE_SOFT_BACKOFF_SECONDS,
          hardSec: IDLE_HARD_BACKOFF_SECONDS,
        });
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
        process.stdout.write(`\r\x1b[2K${kleur.dim(`${timestamp()} no changes (${r.unchanged} unchanged)`)}`);
      }
    } catch (e) {
      const err = e as Error;
      const apiErr = err instanceof ApiError ? err : null;
      const firstLine = err.message.split('\n')[0];
      process.stdout.write('\x1b[2K\r');
      // Any error breaks the idle streak so we come back fast once it clears.
      consecutiveIdleTicks = 0;

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
          console.log(kleur.dim('   Fix: run `magicpixel login` (this watcher will keep retrying every 30s).'));
        }
        pausedForAuth = true;
        consecutiveAuthFailures = decision.consecutiveAuthFailures;
        backoffSec = decision.nextBackoffSec;
        if (decision.giveUp) {
          console.log(
            `${kleur.dim(timestamp())} ${kleur.red('✗')} Giving up after ${MAX_AUTH_FAILURES} consecutive auth failures.`,
          );
          console.log(kleur.dim('   Fix: run `magicpixel login` with a fresh key, then restart the watcher.'));
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
  if (!opts.quiet) console.log(kleur.dim('[watch] stopped.'));
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
 * Pure helper: given how many consecutive idle ticks we've seen and the
 * configured poll interval, return the next backoff in seconds. Exported so
 * the watch-mode regression test can guard the "ticks vs seconds" bug fixed
 * in 0.4.0 without exercising the full watch loop.
 */
export function nextBackoffForIdle(
  consecutiveIdleTicks: number,
  intervalSec: number,
  thresholds: { softSec: number; hardSec: number } = { softSec: 180, hardSec: 900 },
): number {
  const idleSeconds = consecutiveIdleTicks * intervalSec;
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
}

async function runOnce(opts: SyncOpts, runOpts: RunOpts = {}): Promise<SyncResult> {
  const config = await loadConfig();
  const state = await loadState();
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  const verbose = !opts.quiet && !runOpts.watchMode;
  const shouldPrune = opts.prune !== false;  // commander: --no-prune sets false

  if (verbose && config.endpoint) {
    console.log(kleur.yellow(`! using custom endpoint: ${config.endpoint}`));
  }

  const since = opts.full ? undefined : state.lastSync;
  const previousAssets = state.assets ?? {};  // id → key from prior sync

  const spinner: Ora | null = verbose
    ? ora(since ? `Fetching manifest since ${humanTime(since)}…` : 'Fetching manifest…').start()
    : null;
  let manifest: ManifestEntry[];
  try {
    manifest = await fetchAllManifest(config, since);
    spinner?.succeed(
      `Manifest: ${manifest.length} asset${manifest.length === 1 ? '' : 's'}${since ? kleur.dim(' (incremental)') : ''}`,
    );
  } catch (e) {
    spinner?.fail('Manifest fetch failed');
    throw e;
  }

  // Detect renames: same id, different key vs prior snapshot.
  const renamed: RenameInfo[] = [];
  for (const entry of manifest) {
    const prevKey = previousAssets[entry.id];
    if (prevKey && prevKey !== entry.key) {
      renamed.push({ id: entry.id, oldKey: prevKey, newKey: entry.key });
    }
  }

  // Compute the disk path once per entry and reuse it across the diff /
  // orphan / download loops — saves three resolves + two security asserts
  // per asset on large projects. Every entry in `manifest` is pre-seeded, so
  // the lookup never misses; non-null assertion is safe.
  const diskPathById = new Map<string, string>();
  for (const entry of manifest) {
    diskPathById.set(entry.id, assetDiskPath(config.outDir, entry));
  }
  const pathFor = (entry: ManifestEntry): string => diskPathById.get(entry.id)!;

  // Diff against disk. SHA pre-check runs through the same concurrency pool
  // used for downloads — on a 1k-asset project that's all-unchanged this is
  // the dominant wall-clock cost of an incremental sync. We cache each result
  // so the download loop can reuse it for `If-None-Match` ETags instead of
  // re-hashing the same file moments later.
  const diffLimit = createLimit(concurrency);
  const shaByEntryId = new Map<string, string | null>();
  const toDownload: ManifestEntry[] = [];
  let bytesSaved = 0;
  let unchanged = 0;
  await Promise.all(
    manifest.map((entry) =>
      diffLimit(async () => {
        const localSha = await fileSha256(pathFor(entry));
        shaByEntryId.set(entry.id, localSha);
        if (entry.sha256 && localSha && entry.sha256 === localSha) {
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
  if (!since) {
    const remoteDiskPaths = new Set(manifest.map((e) => pathFor(e)));
    const localPngs = await walkOutDirPngs(config.outDir);
    orphans = localPngs.map((a) => a.abs).filter((p) => !remoteDiskPaths.has(p));
  }
  // Stale paths from detected renames (always pruned, even in incremental mode —
  // otherwise the old PNG silently lingers next to the renamed copy).
  const renameStalePaths = renamed
    .map((r) => assetDiskPathFromKey(config.outDir, r.oldKey))
    .filter((p) => existsSync(p));
  // De-duplicate vs the full-sync orphan list.
  const orphanSet = new Set(orphans);
  for (const p of renameStalePaths) orphanSet.add(p);
  orphans = [...orphanSet];

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
  };

  let progress: Ora | null = null;
  if (verbose && toDownload.length > 0) {
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
            if (entry.sha256) {
              const actual = createHash('sha256').update(bytes).digest('hex');
              if (actual !== entry.sha256) {
                throw new Error(
                  `sha256 mismatch (expected ${entry.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
                );
              }
            }
            // Wrap any of mkdir/writeFile/rename so the user sees a friendly
            // multi-line diagnostic instead of a raw `EACCES: permission denied`.
            try {
              await mkdir(dirname(diskPath), { recursive: true });
              const tmp = tmpPathFor(diskPath);
              assertPathInsideRoot(tmp, resolve(process.cwd(), config.outDir), 'outDir');
              await writeFile(tmp, bytes);
              await rename(tmp, diskPath);
            } catch (fsErr) {
              throw friendlyFsError(fsErr, {
                operation: `Writing asset`,
                path: diskPath,
                hint: `Sync can't continue until outDir (${config.outDir}) is writable.`,
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
    if (result.failed === 0) progress.succeed(`Downloaded ${downloaded} (${formatBytes(result.bytesIn)})`);
    else progress.warn(`Downloaded ${downloaded}, failed ${result.failed} (${formatBytes(result.bytesIn)})`);
  }

  // Prune (now default — pass --no-prune to opt out).
  if (shouldPrune && orphans.length > 0) {
    const outRoot = resolve(process.cwd(), config.outDir);
    for (const p of orphans) {
      assertPathInsideRoot(p, outRoot, 'outDir');
      try {
        await unlink(p);
        const relPath = relative(outRoot, p).replace(/\\/g, '/');
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
  const nextState: SyncState = { ...state, assets: nextAssets };
  if (result.failed === 0) {
    // Advance the cursor to the newest row we actually observed, NOT the
    // wall-clock time the sync started. Using startedAt silently skipped
    // rows whose `updated_at` lived in the gap between the manifest snapshot
    // and the next poll (notably when only metadata changed — e.g. artboard
    // renames — and the row updated between fetch start and save).
    const maxUpdatedAt = maxIsoTimestamp(manifest.map((e) => e.updated_at));
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
  } else {
    nextState.lastError = `${result.failed} download${result.failed === 1 ? '' : 's'} failed at ${startedAt}`;
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
  if (result.failed) process.exitCode = 1;
  return result;
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
