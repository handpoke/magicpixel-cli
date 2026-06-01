import kleur from 'kleur';
import ora, { type Ora } from 'ora';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { loadConfig, loadState, saveState } from '../config.js';
import { fetchAllManifest, fetchAssetBytes, type ManifestEntry } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { assetDiskPath } from '../util/paths.js';
import { createLimit } from '../util/limit.js';
import { emitTypedIndex } from '../util/emitIndex.js';
import { assertPathInsideRoot, tmpPathFor } from '../util/security.js';

interface SyncOpts {
  prune?: boolean;
  dryRun?: boolean;
  full?: boolean;
  concurrency?: number;
  watch?: boolean | string;  // boolean for --watch, string from -w "<seconds>"
  quiet?: boolean;
}

interface SyncResult {
  downloaded: number;
  unchanged: number;
  pruned: number;
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
  const intervalSec = typeof opts.watch === 'string' ? Math.max(2, parseInt(opts.watch, 10) || 10) : 10;
  console.log(kleur.dim(`[watch] polling every ${intervalSec}s. Ctrl+C to stop.`));

  let stopping = false;
  let inFlight = false;
  let resolveIdle: (() => void) | null = null;

  const onSigint = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\x1b[2K\r');
    if (inFlight) {
      // Let the current sync drain so we don't leave half-written *.tmp files
      // or an unflushed lastSync state. Second Ctrl+C hard-exits.
      console.log(kleur.dim('[watch] finishing current sync… (Ctrl+C again to force quit)'));
      process.once('SIGINT', () => process.exit(130));
    } else {
      console.log(kleur.dim('[watch] stopped.'));
      process.exit(0);
    }
  };
  process.on('SIGINT', onSigint);

  // Run once eagerly so first sync isn't delayed by the interval.
  const tick = async () => {
    if (inFlight || stopping) return;
    inFlight = true;
    try {
      const r = await runOnce({ ...opts, quiet: true, watch: false });
      if (r.downloaded > 0 || r.pruned > 0) {
        process.stdout.write('\x1b[2K\r');
        console.log(
          `${kleur.dim(timestamp())} ${kleur.green('✓')} ${r.downloaded} downloaded` +
            (r.pruned ? `, ${r.pruned} pruned` : '') +
            (r.failed ? kleur.yellow(`, ${r.failed} failed`) : ''),
        );
      } else {
        process.stdout.write(`\r\x1b[2K${kleur.dim(`${timestamp()} no changes (${r.unchanged} unchanged)`)}`);
      }
    } catch (e) {
      console.log(`\n${kleur.dim(timestamp())} ${kleur.red('!')} ${(e as Error).message.split('\n')[0]}`);
    } finally {
      inFlight = false;
      resolveIdle?.();
      resolveIdle = null;
    }
  };
  await tick();
  while (!stopping) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    if (stopping) break;
    await tick();
  }
  // SIGINT arrived mid-tick — wait for it to drain, then exit cleanly.
  if (inFlight) {
    await new Promise<void>((r) => {
      resolveIdle = r;
    });
  }
  console.log(kleur.dim('[watch] stopped.'));
  process.exit(0);
}

async function runOnce(opts: SyncOpts): Promise<SyncResult> {
  const config = await loadConfig();
  const state = await loadState();
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  const quiet = !!opts.quiet;

  // Warn loudly when a custom endpoint is configured — easy to forget a test
  // override before committing magicpixel.json to a real repo / CI.
  if (!quiet && config.endpoint) {
    console.log(kleur.yellow(`! using custom endpoint: ${config.endpoint}`));
  }

  // Incremental: only fetch what changed since last successful sync.
  // --full forces a from-scratch fetch.
  const since = opts.full ? undefined : state.lastSync;

  const spinner: Ora | null = quiet
    ? null
    : ora(since ? `Fetching manifest since ${humanTime(since)}…` : 'Fetching manifest…').start();
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

  // Diff
  const toDownload: ManifestEntry[] = [];
  const skipped: ManifestEntry[] = [];
  let bytesSaved = 0;
  for (const entry of manifest) {
    const diskPath = assetDiskPath(config.outDir, entry);
    const localSha = await fileSha256(diskPath);
    if (entry.sha256 && localSha && entry.sha256 === localSha) {
      skipped.push(entry);
      if (entry.size_bytes) bytesSaved += entry.size_bytes;
    } else {
      toDownload.push(entry);
    }
  }

  // Orphan detection only when we have the full picture.
  let orphans: string[] = [];
  if (!since) {
    const remoteDiskPaths = new Set(manifest.map((e) => assetDiskPath(config.outDir, e)));
    orphans = (await findLocalPngs(resolve(process.cwd(), config.outDir)))
      .filter((p) => !remoteDiskPaths.has(p));
  }

  if (!quiet) {
    console.log();
    console.log(kleur.bold('Plan:'));
    console.log(`  ${kleur.green('+')} download ${toDownload.length}`);
    console.log(`  ${kleur.dim('=')} unchanged ${skipped.length}${bytesSaved ? kleur.dim(` (~${formatBytes(bytesSaved)} saved)`) : ''}`);
    if (since) {
      console.log(`  ${kleur.dim('orphan check skipped (incremental — use --full)')}`);
    } else if (orphans.length > 0) {
      const verb = opts.prune ? kleur.red('delete') : kleur.yellow('keep (orphan)');
      console.log(`  ${verb} ${orphans.length}`);
    }
    console.log();
  }

  if (opts.dryRun) {
    if (!quiet) {
      console.log(kleur.dim('--dry-run: no files written.'));
      if (orphans.length > 0) printOrphans(orphans);
    }
    return { downloaded: 0, unchanged: skipped.length, pruned: 0, failed: 0, bytesIn: 0, bytesSaved };
  }

  // Download with progress bar
  const result: SyncResult = {
    downloaded: 0,
    unchanged: skipped.length,
    pruned: 0,
    failed: 0,
    bytesIn: 0,
    bytesSaved,
  };

  let progress: Ora | null = null;
  if (!quiet && toDownload.length > 0) {
    progress = ora({ text: progressText(0, toDownload.length, 0), spinner: 'dots' }).start();
  }

  const run = createLimit(concurrency);
  let done = 0;
  await Promise.all(
    toDownload.map((entry) =>
      run(async () => {
        const diskPath = assetDiskPath(config.outDir, entry);
        try {
          const localSha = await fileSha256(diskPath);
          const bytes = await fetchAssetBytes(config, entry.key, localSha);
          if (bytes === null) {
            result.unchanged++;
          } else {
            // Verify the payload matches what the manifest advertised. Guards
            // against silently writing a corrupted body to disk.
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
            result.downloaded++;
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
  if (progress) {
    if (result.failed === 0) progress.succeed(`Downloaded ${result.downloaded} (${formatBytes(result.bytesIn)})`);
    else progress.warn(`Downloaded ${result.downloaded}, failed ${result.failed} (${formatBytes(result.bytesIn)})`);
  }

  // Prune
  if (opts.prune && orphans.length > 0) {
    const outRoot = resolve(process.cwd(), config.outDir);
    for (const p of orphans) {
      assertPathInsideRoot(p, outRoot, 'outDir');
      await unlink(p);
      if (!quiet) console.log(`  ${kleur.red('-')} ${relative(process.cwd(), p)}`);
    }
    await pruneEmptyDirs(resolve(process.cwd(), config.outDir));
    result.pruned = orphans.length;
  } else if (!quiet && orphans.length > 0) {
    printOrphans(orphans);
  }

  // Emit typed index if enabled AND any file change happened (or first sync).
  // In incremental mode `manifest` only contains changed entries, so we must
  // re-fetch the full manifest (cheap — JSON only) to write a complete index.
  if (config.emitIndex && (result.downloaded > 0 || result.pruned > 0 || !since)) {
    try {
      const fullManifest = since ? await fetchAllManifest(config) : manifest;
      const indexPath = await emitTypedIndex(config.outDir, fullManifest);
      if (!quiet) console.log(kleur.dim(`  index → ${relative(process.cwd(), indexPath)}`));
    } catch (e) {
      if (!quiet) console.log(kleur.yellow(`  index emit failed: ${(e as Error).message}`));
    }
  }

  if (result.failed === 0) {
    await saveState({ lastSync: startedAt });
  } else if (!quiet) {
    console.log(kleur.yellow(`\n${result.failed} download${result.failed === 1 ? '' : 's'} failed — lastSync not advanced. Re-run to retry.`));
  }

  if (!quiet) {
    console.log();
    const summary =
      `downloaded ${result.downloaded}, unchanged ${result.unchanged}` +
      (opts.prune ? `, pruned ${result.pruned}` : '') +
      (result.failed ? `, failed ${result.failed}` : '');
    console.log(result.failed ? kleur.yellow(`done with errors. ${summary}`) : kleur.green(`✓ done. ${summary}`));
  }
  if (result.failed) process.exitCode = 1;
  return result;
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
    const d = new Date(iso);
    return d.toLocaleString();
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
  console.log(kleur.dim('  Run with --prune to delete them.'));
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

