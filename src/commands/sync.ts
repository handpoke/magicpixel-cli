import kleur from 'kleur';
import ora, { type Ora } from 'ora';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { loadConfig, loadState, saveState, type SyncState } from '../config.js';
import { fetchAllManifest, fetchAssetBytes, ApiError, type ManifestEntry } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { assetDiskPath, assetDiskPathFromKey } from '../util/paths.js';
import { createLimit } from '../util/limit.js';
import { emitTypedIndex, ensureAgentsDoc, scanDiskAssets } from '../util/emitIndex.js';
import { assertPathInsideRoot, tmpPathFor } from '../util/security.js';

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
  // Floor stays at 2s to keep accidental thrashing in check; users who need
  // less can pass `--watch 5`.
  const intervalSec = typeof opts.watch === 'string' ? Math.max(2, parseInt(opts.watch, 10) || 2) : 2;

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
  console.log(kleur.dim(`   Polling:  every ${intervalSec}s   ·   Stop: Ctrl+C`));
  console.log();

  let stopping = false;
  let inFlight = false;
  let resolveIdle: (() => void) | null = null;
  let backoffSec = intervalSec;
  let pausedForAuth = false;
  // Adaptive idle backoff: after a few minutes of nothing-to-do we slow the
  // poll from 2s → 5s → 10s so a dev who walked away isn't hammering the
  // manifest endpoint. ANY change OR error resets this back to intervalSec,
  // so the "edit → see it" promise stays intact the moment the user comes
  // back. Error backoff (2→60s) is separate and continues to win.
  let consecutiveIdleTicks = 0;

  const onSigint = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\x1b[2K\r');
    if (inFlight) {
      console.log(kleur.dim('[watch] finishing current sync… (Ctrl+C again to force quit)'));
      process.once('SIGINT', () => process.exit(130));
    } else {
      console.log(kleur.dim('[watch] stopped.'));
      process.exit(0);
    }
  };
  process.on('SIGINT', onSigint);

  const tick = async () => {
    if (inFlight || stopping) return;
    inFlight = true;
    try {
      const r = await runOnce({ ...opts, watch: false }, { watchMode: true });
      // Reset backoff + auth-pause flags on any successful tick.
      backoffSec = intervalSec;
      pausedForAuth = false;
      const changedCount = r.added.length + r.modified.length + r.removed.length + r.renamed.length;
      if (changedCount > 0) {
        // Snap back to the fast interval the moment anything changes.
        consecutiveIdleTicks = 0;
        backoffSec = intervalSec;
      } else {
        consecutiveIdleTicks++;
        // Thresholds in *ticks*; at intervalSec=2 these are ~3 min and ~15 min.
        if (consecutiveIdleTicks >= 300) backoffSec = Math.max(intervalSec, 10);
        else if (consecutiveIdleTicks >= 90) backoffSec = Math.max(intervalSec, 5);
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

      if (apiErr && (apiErr.status === 401 || apiErr.status === 403)) {
        if (!pausedForAuth) {
          console.log(`${kleur.dim(timestamp())} ${kleur.red('✗')} Your key looks invalid or rotated.`);
          console.log(kleur.dim('   Fix: run `magicpixel login` (this watcher will keep retrying every 30s).'));
        }
        pausedForAuth = true;
        backoffSec = 30;
      } else if (isNetworkError(err)) {
        if (backoffSec < 30) {
          console.log(
            `${kleur.dim(timestamp())} ${kleur.yellow('!')} MagicPixel is offline or your internet is. ` +
              `Sprites you already have still work. Retrying in ${Math.min(backoffSec * 2, 60)}s.`,
          );
        }
        backoffSec = Math.min(backoffSec * 2, 60);
      } else {
        console.log(`${kleur.dim(timestamp())} ${kleur.red('!')} ${firstLine}`);
        backoffSec = Math.min(backoffSec * 2, 60);
      }
    } finally {
      inFlight = false;
      resolveIdle?.();
      resolveIdle = null;
    }
  };
  await tick();
  while (!stopping) {
    await new Promise((r) => setTimeout(r, backoffSec * 1000));
    if (stopping) break;
    await tick();
  }
  if (inFlight) {
    await new Promise<void>((r) => {
      resolveIdle = r;
    });
  }
  console.log(kleur.dim('[watch] stopped.'));
  process.exit(0);
}

function isNetworkError(err: Error): boolean {
  // The api layer wraps fetch failures as `manifest: network error (...)`;
  // bare ENOTFOUND/ETIMEDOUT/etc. also surface here from `fetchAssetBytes`.
  const msg = err.message;
  return (
    /network error/i.test(msg) ||
    /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(msg) ||
    /fetch failed/i.test(msg)
  );
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

  // Diff against disk
  const toDownload: ManifestEntry[] = [];
  let bytesSaved = 0;
  let unchanged = 0;
  for (const entry of manifest) {
    const diskPath = assetDiskPath(config.outDir, entry);
    const localSha = await fileSha256(diskPath);
    if (entry.sha256 && localSha && entry.sha256 === localSha) {
      unchanged++;
      if (entry.size_bytes) bytesSaved += entry.size_bytes;
    } else {
      toDownload.push(entry);
    }
  }

  // Orphan detection only when we have the full picture.
  // (Renames also produce a stale path on disk — collected separately below.)
  let orphans: string[] = [];
  if (!since) {
    const remoteDiskPaths = new Set(manifest.map((e) => assetDiskPath(config.outDir, e)));
    orphans = (await findLocalPngs(resolve(process.cwd(), config.outDir)))
      .filter((p) => !remoteDiskPaths.has(p));
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

  if (verbose) {
    console.log();
    console.log(kleur.bold('Plan:'));
    console.log(`  ${kleur.green('+')} download ${toDownload.length}`);
    console.log(`  ${kleur.dim('=')} unchanged ${unchanged}${bytesSaved ? kleur.dim(` (~${formatBytes(bytesSaved)} saved)`) : ''}`);
    if (renamed.length) console.log(`  ${kleur.cyan('↪')} renamed ${renamed.length}`);
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
        const diskPath = assetDiskPath(config.outDir, entry);
        const existedBefore = existsSync(diskPath);
        try {
          const localSha = await fileSha256(diskPath);
          const bytes = await fetchAssetBytes(config, entry.key, localSha);
          if (bytes === null) {
            result.unchanged++;
          } else {
            if (entry.sha256) {
              const actual = createHash('sha256').update(bytes).digest('hex');
              if (actual !== entry.sha256) {
                throw new Error(
                  `sha256 mismatch (expected ${entry.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
                );
              }
            }
            await mkdir(dirname(diskPath), { recursive: true });
            const tmp = tmpPathFor(diskPath);
            assertPathInsideRoot(tmp, resolve(process.cwd(), config.outDir), 'outDir');
            await writeFile(tmp, bytes);
            await rename(tmp, diskPath);
            if (existedBefore) result.modified.push(entry.key);
            else result.added.push(entry.key);
            result.bytesIn += bytes.byteLength;
          }
        } catch (e) {
          result.failed++;
          progress?.stop();
          console.log(`  ${kleur.red('!')} ${entry.key}: ${(e as Error).message.split('\n')[0]}`);
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
    nextState.lastSync = startedAt;
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

    // Nudge AI tools toward the typed index. Idempotent — `ensureAgentsDoc`
    // no-ops once our marker section is present.
    try {
      const agentsResult = await ensureAgentsDoc(config.outDir);
      if (verbose && agentsResult !== 'unchanged') {
        console.log(kleur.dim(`  AGENTS.md ${agentsResult}`));
      }
    } catch {
      // Never let an AGENTS.md write failure break sync.
    }
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
    printChanges(result, '  ');
    if (renamed.length > 0) printRenames(renamed, { withHints: true });
  }
  if (result.failed) process.exitCode = 1;
  return result;
}

const CHANGE_PRINT_CAP = 50;

function printChanges(r: SyncResult, indent: string): void {
  const lines: string[] = [];
  for (const k of r.added) lines.push(`${indent}${kleur.green('+')} ${k}`);
  for (const k of r.modified) lines.push(`${indent}${kleur.cyan('~')} ${k}`);
  for (const r2 of r.renamed) lines.push(`${indent}${kleur.cyan('↪')} ${r2.oldKey} → ${r2.newKey}`);
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  console.log(kleur.dim('  Pruning is on by default. Re-run without --no-prune to delete them.'));
}

async function findLocalPngs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const root = resolve(dir);
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = resolve(d, ent.name);
      try {
        assertPathInsideRoot(full, root, 'outDir');
      } catch {
        continue;
      }
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue;
        await walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.png')) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function pruneEmptyDirs(root: string): Promise<void> {
  if (!existsSync(root)) return;
  async function walk(d: string): Promise<boolean> {
    const entries = await readdir(d, { withFileTypes: true });
    let isEmpty = true;
    for (const ent of entries) {
      const full = resolve(d, ent.name);
      if (ent.isDirectory()) {
        const childEmpty = await walk(full);
        if (childEmpty) {
          await rm(full, { recursive: true, force: true });
        } else {
          isEmpty = false;
        }
      } else {
        isEmpty = false;
      }
    }
    return isEmpty;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const full = resolve(root, ent.name);
      const empty = await walk(full);
      if (empty) await rm(full, { recursive: true, force: true });
    }
  }
}
