/**
 * `magicpixel push` — disk → MagicPixel (the Unity → MagicPixel half of
 * two-way sync).
 *
 * Walks `outDir` plus the `connect` working set (original game PNGs), hashes
 * every PNG, and sends the ones that changed (or are brand new on disk) to
 * `POST /api/public/integration/ingest`.
 */

import kleur from 'kleur';
import ora from 'ora';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { relative, resolve } from 'node:path';

import { loadConfig, loadState, saveState, type MagicPixelConfig, type SyncState, type SyncedSprite } from '../config.js';
import { PUSH_BATCH_SIZE, pushSprites, type PushResult, type PushSprite } from '../api.js';
import { hashFile } from '../util/hash.js';
import { createLimit } from '../util/limit.js';
import { assetDiskPathFromKey, walkOutDirPngs } from '../util/paths.js';
import { applyDiskFingerprints, indexSyncedBySourceRel, planPush, resolveSyncedKey, type PushCandidate } from '../util/pushPlan.js';
import { cmd } from '../util/invoke.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { indexGamePngs, matchConnectGlobs, GAME_INDEX_CAP_HINT, connectCapMessage, countingSpritesText, type GameIndex } from '../util/gameScan.js';
import { collectSourceRelMap, remapAbsToCloudKeys } from '../util/syncPath.js';
import { assertSafeIoPath } from '../util/security.js';

/** Parallel hashing / path checks — enough to saturate disk, low enough to stay polite. */
const PUSH_SCAN_CONCURRENCY = 8;

/** Paths already verified this process; hashFile still refuses a later symlink swap. */
const verifiedIoPaths = new Set<string>();

export interface PushOpts {
  dryRun?: boolean;
  flatten?: boolean;
  /** Suppress spinners and the "nothing to push" line (watch / nested sync). */
  quiet?: boolean;
  /** Skip a second game-tree walk when the caller already indexed. */
  gameIndex?: GameIndex;
}

export interface PushSummary {
  created: number;
  updated: number;
  unchanged: number;
  conflict: number;
  error: number;
  imported: number;
}

export async function pushCommand(opts: PushOpts = {}): Promise<void> {
  await runPush(opts);
}

/**
 * Scan local PNGs and upload new/changed ones into the MagicPixel library.
 * Used by `magicpixel push` and by `sync` (so a committed `connect` working
 * set is ingested without a second command).
 */
export async function runPush(opts: PushOpts = {}): Promise<PushSummary> {
  const config = await loadConfig();
  const state = await loadState();
  return runPushWith(config, state, opts);
}

export async function runPushWith(
  config: MagicPixelConfig,
  state: SyncState,
  opts: PushOpts = {},
): Promise<PushSummary> {
  const quiet = opts.quiet === true;
  const empty: PushSummary = { created: 0, updated: 0, unchanged: 0, conflict: 0, error: 0, imported: 0 };

  const spinner = quiet ? null : ora(countingSpritesText(0)).start();
  const kind = await detectProjectKind();
  const index = opts.gameIndex
    ?? (isEngineKind(kind)
      ? await indexGamePngs(kind, process.cwd(), config.outDir, {
          onProgress: spinner ? (n) => { spinner.text = countingSpritesText(n); } : undefined,
        })
      : { files: [], capped: false });
  const matched = matchConnectGlobs(index, config.connect ?? []);
  const sourceByKey = collectSourceRelMap(matched.entries, state.synced);

  const disk = await walkOutDirPngs(config.outDir);
  const absByKey = new Map(disk.map((a) => [a.key, a.abs]));
  const entryByKey = new Map(matched.entries.map((e) => [e.key, e]));
  for (const e of matched.entries) {
    absByKey.set(e.key, e.abs);
  }
  remapAbsToCloudKeys(absByKey, matched.entries, state.synced);
  const entryBySourceRel = new Map(matched.entries.map((e) => [e.sourceRel, e]));
  for (const [k, rel] of sourceByKey) {
    const e = entryBySourceRel.get(rel);
    if (e) entryByKey.set(k, e);
  }

  const candidates: PushCandidate[] = [];
  const cwdAbs = resolve(process.cwd());
  let skippedUnsafe = 0;
  const synced = state.synced ?? {};
  const byRel = indexSyncedBySourceRel(synced);
  const scan = createLimit(PUSH_SCAN_CONCURRENCY);
  await Promise.all(
    [...absByKey.entries()].map(([key, abs]) =>
      scan(async () => {
        try {
          if (!verifiedIoPaths.has(abs)) {
            await assertSafeIoPath(abs, cwdAbs);
            verifiedIoPaths.add(abs);
          }
        } catch {
          skippedUnsafe++;
          return;
        }
        const entry = entryByKey.get(key);
        const sourceRel = entry?.sourceRel ?? sourceByKey.get(key);
        const stateKey = resolveSyncedKey({ key, sourceRel }, synced, byRel);
        const known = stateKey ? synced[stateKey] : undefined;
        const hint =
          known?.diskSha256 && known.diskMtimeMs != null && known.diskSize != null
            ? { sha256: known.diskSha256, mtimeMs: known.diskMtimeMs, size: known.diskSize }
            : undefined;
        const hashed = await hashFile(abs, hint);
        if (!hashed) return;
        const segments = entry
          ? entry.adoptRel.replace(/\.png$/i, '').split('/')
          : key.split('/');
        candidates.push({
          key,
          segments,
          diskSha256: hashed.sha256,
          ...(sourceRel ? { sourceRel } : {}),
          diskMtimeMs: hashed.mtimeMs,
          diskSize: hashed.size,
        });
      }),
    ),
  );

  const folderTreeKeys = new Set(matched.entries.map((e) => e.key));
  for (const k of absByKey.keys()) {
    if (sourceByKey.has(k)) folderTreeKeys.add(k);
  }
  const actions = planPush(candidates, state.synced, { flatten: opts.flatten, folderTreeKeys });
  const skipped = actions.filter((a) => a.kind === 'skip' && a.reason !== 'legacy').length;
  const legacy = actions.filter((a) => a.kind === 'skip' && a.reason === 'legacy');
  const flattenBlocked = actions.filter((a) => a.kind === 'needs-flatten');
  const sendable = actions.filter((a) => a.kind === 'update' || a.kind === 'adopt');
  spinner?.succeed(
    `Local sprites: ${candidates.length} · to push ${sendable.length} · unchanged ${skipped}` +
      (matched.entries.length ? ` · connected ${matched.entries.length}` : ''),
  );

  if (index.capped && !quiet) {
    console.log(kleur.yellow(`! ${GAME_INDEX_CAP_HINT}`));
  }
  if (matched.capped && !quiet) {
    console.log(kleur.yellow(`! ${connectCapMessage(matched.total, matched.entries.length)}`));
  }

  if (skippedUnsafe > 0 && !quiet) {
    console.log(
      kleur.yellow(
        `! skipped ${skippedUnsafe} path${skippedUnsafe === 1 ? '' : 's'} that were not regular files inside the project.`,
      ),
    );
  }
  if (legacy.length > 0 && !quiet) {
    console.log();
    console.log(
      kleur.yellow(
        `! ${legacy.length} sprite${legacy.length === 1 ? '' : 's'} came from a legacy single-image file — skipped.`,
      ),
    );
    console.log(kleur.dim(`  Fix: open the file in MagicPixel and save it once, then re-run \`${cmd('sync')}\`.`));
  }

  if (flattenBlocked.length > 0 && !quiet) {
    console.log();
    console.log(
      kleur.yellow(
        `! ${flattenBlocked.length} sprite${flattenBlocked.length === 1 ? '' : 's'} would flatten a multi-layer artboard — skipped.`,
      ),
    );
    for (const a of flattenBlocked.slice(0, 10)) {
      console.log(kleur.dim(`    ${a.key} (${'layers' in a ? a.layers : '?'} layers)`));
    }
    console.log(kleur.dim('  Fix: re-run with --flatten to replace them with the flat disk image.'));
  }

  if (sendable.length === 0) {
    await persistDiskFingerprints(state, candidates);
    if (!quiet) console.log(kleur.green('✓ nothing to push.'));
    return { ...empty, imported: matched.entries.length, unchanged: skipped };
  }

  if (opts.dryRun) {
    if (!quiet) {
      console.log();
      for (const a of sendable) {
        const verb = a.kind === 'update' ? kleur.yellow('~') : kleur.green('+');
        console.log(`  ${verb} ${a.key}${a.kind === 'adopt' ? kleur.dim(' (new)') : ''}`);
      }
      console.log(kleur.dim('--dry-run: nothing sent.'));
    }
    return { ...empty, imported: matched.entries.length };
  }

  const outRoot = resolve(process.cwd(), config.outDir);
  const shaByKey = new Map(candidates.map((c) => [c.key, c.diskSha256]));
  const fpByKey = new Map(candidates.map((c) => [c.key, c]));
  const sprites: PushSprite[] = [];
  for (const a of sendable) {
    const abs = absByKey.get(a.key);
    if (!abs) continue;
    await assertSafeIoPath(abs, cwdAbs);
    const pngBase64 = (await readFile(abs)).toString('base64');
    const diskSha256 = shaByKey.get(a.key)!;
    if (a.kind === 'update') {
      sprites.push({
        key: a.key,
        pngBase64,
        diskSha256,
        assetId: a.assetId,
        layerIdx: a.layerIdx,
        baseSha256: a.baseSha256,
        flatten: opts.flatten === true,
      });
    } else if (a.kind === 'adopt') {
      sprites.push({ key: a.key, pngBase64, diskSha256, path: a.path, pathNames: a.pathNames, name: a.name });
    }
  }

  const progress = quiet ? null : ora(`Pushing 0/${sprites.length}…`).start();
  const results: PushResult[] = [];
  for (let i = 0; i < sprites.length; i += PUSH_BATCH_SIZE) {
    const batch = sprites.slice(i, i + PUSH_BATCH_SIZE);
    const batchResults = await pushSprites(batch);
    results.push(...batchResults);
    if (progress) progress.text = `Pushing ${Math.min(i + batch.length, sprites.length)}/${sprites.length}…`;
  }

  const counts = { created: 0, updated: 0, unchanged: 0, conflict: 0, error: 0 };
  const failedKeys = new Set(
    results.filter((r) => r.status === 'conflict' || r.status === 'error').map((r) => r.key),
  );
  const fingerprinted = applyDiskFingerprints(
    state.synced ?? {},
    candidates.filter((c) => !failedKeys.has(c.key)),
  );
  const nextSynced: Record<string, SyncedSprite> = { ...fingerprinted.next };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const stateKey = r.cloudKey && r.cloudKey !== r.key ? r.cloudKey : r.key;
    const sourceRel = sourceByKey.get(r.key) ?? sourceByKey.get(stateKey);
    if (stateKey !== r.key && (r.status === 'created' || r.status === 'updated')) {
      if (!sourceRel) await renameLocalSprite(config.outDir, r.key, stateKey);
    }
    if ((r.status === 'created' || r.status === 'updated' || r.status === 'unchanged') && r.assetId && r.sha256) {
      if (stateKey !== r.key) delete nextSynced[r.key];
      const diskSha256 = shaByKey.get(r.key) ?? shaByKey.get(stateKey) ?? nextSynced[stateKey]?.diskSha256;
      const fp = fpByKey.get(r.key) ?? fpByKey.get(stateKey);
      nextSynced[stateKey] = {
        assetId: r.assetId,
        layerIdx: typeof r.layerIdx === 'number' ? r.layerIdx : (nextSynced[stateKey]?.layerIdx ?? 0),
        sha256: r.sha256,
        layers: 1,
        ...(diskSha256 ? { diskSha256 } : {}),
        ...(fp?.diskMtimeMs != null ? { diskMtimeMs: fp.diskMtimeMs } : {}),
        ...(fp?.diskSize != null ? { diskSize: fp.diskSize } : {}),
        ...(sourceRel ? { sourceRel } : {}),
      };
    }
  }
  await saveState({ ...state, synced: nextSynced });

  const failed = counts.conflict + counts.error;
  const summary =
    `created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}` +
    (counts.conflict ? `, conflicts ${counts.conflict}` : '') +
    (counts.error ? `, errors ${counts.error}` : '');
  if (progress) {
    if (failed) progress.warn(`Push finished with issues. ${summary}`);
    else progress.succeed(`Pushed. ${summary}`);
  }

  if (!quiet) {
    for (const r of results) {
      if (r.status === 'conflict') {
        console.log(`  ${kleur.yellow('!')} ${r.key}: ${conflictHint(r.reason)}`);
      } else if (r.status === 'error') {
        console.log(`  ${kleur.red('!')} ${r.key}: ${r.message ?? 'push failed'}`);
      }
    }
    if (counts.created > 0) {
      console.log(
        kleur.dim(
          `  ${counts.created} new sprite${counts.created === 1 ? '' : 's'} now live in your MagicPixel library ` +
            `(working set + ${relative(process.cwd(), outRoot)}). They appear in Connected as they import.`,
        ),
      );
    }
  }
  if (failed) process.exitCode = 1;
  return { ...counts, imported: matched.entries.length };
}

/** Persist disk sha256 onto existing synced rows so the next scan can skip. */
async function persistDiskFingerprints(state: SyncState, candidates: readonly PushCandidate[]): Promise<void> {
  const { next, changed } = applyDiskFingerprints(state.synced ?? {}, candidates);
  if (!changed) return;
  await saveState({ ...state, synced: next });
}

function conflictHint(reason?: string): string {
  switch (reason) {
    case 'cloud-changed':
      return `changed in MagicPixel since the last sync — run \`${cmd('sync')}\` first, then re-push.`;
    case 'would-flatten':
      return 'artboard has multiple layers or frames — re-run with --flatten to replace it.';
    case 'legacy-document':
      return 'document predates layer storage — open and save it once in MagicPixel.';
    case 'not-found':
      return `artboard no longer exists in MagicPixel — run \`${cmd('sync')}\` to refresh.`;
    default:
      return `conflict — run \`${cmd('sync')}\` and try again.`;
  }
}

/**
 * Move a pushed sprite (and its `.meta` sidecar) to the disk path matching the
 * key the cloud assigned. Best effort: a failed move only means the next sync
 * re-downloads the sprite under its cloud name. Never used for sourceRel files.
 */
async function renameLocalSprite(outDir: string, fromKey: string, toKey: string): Promise<void> {
  const from = assetDiskPathFromKey(outDir, fromKey);
  const to = assetDiskPathFromKey(outDir, toKey);
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    await rename(`${from}.meta`, `${to}.meta`).catch(() => {});
  } catch {
    // Leave the file where it is; sync reconciles.
  }
}
