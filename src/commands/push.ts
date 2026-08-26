/**
 * `magicpixel push` — disk → MagicPixel (the Unity → MagicPixel half of
 * two-way sync).
 *
 * Walks `outDir`, hashes every PNG, and sends the ones that changed (or are
 * brand new on disk) to `POST /api/public/integration/ingest`:
 *
 *   - known key + changed sha → write back into that artboard, using the sha
 *     the CLI last pulled as the conflict baseline. If the cloud moved on the
 *     server refuses with `conflict` and nothing is lost.
 *   - unknown key            → adopt: the server mirrors the disk folders into
 *     the library and appends/creates the document.
 */

import kleur from 'kleur';
import ora from 'ora';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { relative, resolve } from 'node:path';

import { loadConfig, loadState, saveState, type SyncedSprite } from '../config.js';
import { PUSH_BATCH_SIZE, pushSprites, type PushResult, type PushSprite } from '../api.js';
import { fileSha256 } from '../util/hash.js';
import { assetDiskPathFromKey, walkOutDirPngs } from '../util/paths.js';
import { planPush, type PushCandidate } from '../util/pushPlan.js';
import { cmd } from '../util/invoke.js';

interface PushOpts {
  dryRun?: boolean;
  flatten?: boolean;
}

export async function pushCommand(opts: PushOpts): Promise<void> {
  const config = await loadConfig();
  const state = await loadState();

  const spinner = ora('Scanning local sprites…').start();
  const disk = await walkOutDirPngs(config.outDir);
  const candidates: PushCandidate[] = [];
  for (const asset of disk) {
    const sha = await fileSha256(asset.abs);
    if (!sha) continue;
    candidates.push({
      key: asset.key,
      segments: asset.key.split('/'),
      diskSha256: sha,
    });
  }
  const actions = planPush(candidates, state.synced, { flatten: opts.flatten });
  const skipped = actions.filter((a) => a.kind === 'skip' && a.reason !== 'legacy').length;
  const legacy = actions.filter((a) => a.kind === 'skip' && a.reason === 'legacy');
  const flattenBlocked = actions.filter((a) => a.kind === 'needs-flatten');
  const sendable = actions.filter((a) => a.kind === 'update' || a.kind === 'adopt');
  spinner.succeed(
    `Local sprites: ${candidates.length} · to push ${sendable.length} · unchanged ${skipped}`,
  );

  if (legacy.length > 0) {
    console.log();
    console.log(
      kleur.yellow(
        `! ${legacy.length} sprite${legacy.length === 1 ? '' : 's'} came from a legacy single-image file — skipped.`,
      ),
    );
    console.log(kleur.dim(`  Fix: open the file in MagicPixel and save it once, then re-run \`${cmd('sync')}\`.`));
  }


  if (flattenBlocked.length > 0) {
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
    console.log(kleur.green('✓ nothing to push.'));
    return;
  }

  if (opts.dryRun) {
    console.log();
    for (const a of sendable) {
      const verb = a.kind === 'update' ? kleur.yellow('~') : kleur.green('+');
      console.log(`  ${verb} ${a.key}${a.kind === 'adopt' ? kleur.dim(' (new)') : ''}`);
    }
    console.log(kleur.dim('--dry-run: nothing sent.'));
    return;
  }

  const outRoot = resolve(process.cwd(), config.outDir);
  const shaByKey = new Map(candidates.map((c) => [c.key, c.diskSha256]));
  const sprites: PushSprite[] = [];
  for (const a of sendable) {
    const abs = resolve(outRoot, `${a.key}.png`);
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

  const progress = ora(`Pushing 0/${sprites.length}…`).start();
  const results: PushResult[] = [];
  for (let i = 0; i < sprites.length; i += PUSH_BATCH_SIZE) {
    const batch = sprites.slice(i, i + PUSH_BATCH_SIZE);
    const batchResults = await pushSprites(batch);
    results.push(...batchResults);
    progress.text = `Pushing ${Math.min(i + batch.length, sprites.length)}/${sprites.length}…`;
  }

  const counts = { created: 0, updated: 0, unchanged: 0, conflict: 0, error: 0 };
  const nextSynced: Record<string, SyncedSprite> = { ...(state.synced ?? {}) };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    // The server may have stored the document under a different slug than the
    // disk folder (collision suffix, slugified name). Move the local files to
    // the key the manifest will report, or the next `sync` downloads a second
    // copy alongside this one.
    const stateKey = r.cloudKey && r.cloudKey !== r.key ? r.cloudKey : r.key;
    if (stateKey !== r.key && (r.status === 'created' || r.status === 'updated')) {
      await renameLocalSprite(config.outDir, r.key, stateKey);
    }
    // Store the sha the cloud now reports so the next `push` is a no-op and
    // the next `sync` doesn't see a phantom change.
    if ((r.status === 'created' || r.status === 'updated' || r.status === 'unchanged') && r.assetId && r.sha256) {
      if (stateKey !== r.key) delete nextSynced[r.key];
      nextSynced[stateKey] = {
        assetId: r.assetId,
        layerIdx: typeof r.layerIdx === 'number' ? r.layerIdx : (nextSynced[stateKey]?.layerIdx ?? 0),
        sha256: r.sha256,
        // A push always leaves the artboard single-layer (the flat disk image).
        layers: 1,
      };
    }
  }
  await saveState({ ...state, synced: nextSynced });

  const failed = counts.conflict + counts.error;
  const summary =
    `created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}` +
    (counts.conflict ? `, conflicts ${counts.conflict}` : '') +
    (counts.error ? `, errors ${counts.error}` : '');
  if (failed) progress.warn(`Push finished with issues. ${summary}`);
  else progress.succeed(`Pushed. ${summary}`);

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
          `(folders mirrored from ${relative(process.cwd(), outRoot)}).`,
      ),
    );
  }
  if (failed) process.exitCode = 1;
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
 * re-downloads the sprite under its cloud name.
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
