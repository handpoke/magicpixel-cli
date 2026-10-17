/**
 * `magicpixel spine` (and the tail of every `sync` / `start`): find the game's
 * Spine skeleton exports, match them to the synced part folders, and upload
 * them so MagicPixel's animated preview appears without attaching anything by
 * hand. Only rigs whose skeletons or folders changed since the last upload are
 * sent (hash remembered in `.magicpixel/state.json`).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import kleur from 'kleur';

import { loadConfig, loadState, saveState, type MagicPixelConfig } from '../config.js';
import { ApiError, pushSpineRigs, type SpineRigStatus } from '../api.js';
import { detectProjectKind, isEngineKind, readWorkspaceMembers } from '../util/framework.js';
import { indexGamePngs, matchConnectGlobs, type GameIndex } from '../util/gameScan.js';
import {
  batchRigs,
  describeRig,
  detectRigs,
  findSkeletonFiles,
  rigsToUpload,
  rigVersionSupported,
  SUPPORTED_SPINE_VERSION,
  syncedPngsFromEntries,
  type DetectedRig,
} from '../util/spine.js';
import { icon, spinner as makeSpinner, ui } from '../util/ui.js';

export type SpineRigOutcomeStatus = SpineRigStatus | 'up-to-date' | 'unsupported' | 'dry-run';

export interface SpineRigOutcome {
  rig: DetectedRig;
  status: SpineRigOutcomeStatus;
  error?: string;
}

export interface SpineRunOutcome {
  /** Skeleton exports found on disk. */
  skeletons: number;
  rigs: SpineRigOutcome[];
  skippedFiles: { rel: string; reason: string }[];
}

export interface SpineRunOpts {
  dryRun?: boolean;
  /** Send every rig, even when its hash matches the last upload. */
  force?: boolean;
  config?: MagicPixelConfig;
  /** Reuse the game index a sync already built. */
  gameIndex?: GameIndex;
  cwd?: string;
  /** Test seam. */
  upload?: typeof pushSpineRigs;
}

/** Folders to look for skeleton exports in: each game folder of a workspace, else the setup folder. */
export function skeletonRoots(cwd: string): string[] {
  const members = readWorkspaceMembers(cwd);
  if (!members) return [cwd];
  const dirs = members.map((m) => resolve(cwd, m)).filter((d) => existsSync(d));
  return dirs.length ? dirs : [cwd];
}

export async function runSpineRigs(opts: SpineRunOpts = {}): Promise<SpineRunOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const empty: SpineRunOutcome = { skeletons: 0, rigs: [], skippedFiles: [] };
  const config = opts.config ?? (await loadConfig(cwd));
  const kind = await detectProjectKind(cwd);
  if (!isEngineKind(kind)) return empty;
  const index = opts.gameIndex ?? (await indexGamePngs(kind, cwd, config.outDir));
  const entries = matchConnectGlobs(index, config.connect ?? [], config.exclude).entries;

  const found = await findSkeletonFiles(skeletonRoots(cwd), cwd, [
    resolve(cwd, config.outDir),
    resolve(cwd, '.magicpixel'),
  ]);
  if (found.skeletons.length === 0) return { ...empty, skippedFiles: found.skipped };
  const rigs = entries.length ? detectRigs(found.skeletons, syncedPngsFromEntries(entries), cwd) : [];

  const state = await loadState(cwd);
  const pending = new Set(opts.force ? rigs : rigsToUpload(rigs, state.spineRigs));
  const outcomes = new Map<DetectedRig, SpineRigOutcome>(
    rigs.map((rig) => [rig, { rig, status: pending.has(rig) ? 'dry-run' : 'up-to-date' }]),
  );
  for (const rig of pending) {
    if (!rigVersionSupported(rig)) {
      outcomes.set(rig, {
        rig,
        status: 'unsupported',
        error: `exported from Spine ${rig.spineVersion || 'an unknown version'}; the preview reads Spine ${SUPPORTED_SPINE_VERSION} exports`,
      });
      pending.delete(rig);
    }
  }

  if (!opts.dryRun && pending.size > 0) {
    const upload = opts.upload ?? pushSpineRigs;
    const record: Record<string, string> = {};
    for (const batch of batchRigs([...pending])) {
      try {
        const results = await upload(batch.map((r) => ({
          name: r.name,
          folderPath: r.folderPath,
          baseFolderPath: r.baseFolderPath,
          views: r.views.map((v) => ({ name: v.name, json: v.file.json })),
          hash: r.hash,
        })));
        batch.forEach((rig, i) => {
          const res = results[i]?.name === rig.name ? results[i] : results.find((x) => x?.name === rig.name);
          const status: SpineRigStatus = res?.status ?? 'error';
          outcomes.set(rig, { rig, status, ...(res?.error || !res ? { error: res?.error ?? 'no result from the server' } : {}) });
          if (status === 'saved' || status === 'unchanged') record[rig.folderPath.join('/')] = rig.hash;
        });
      } catch (e) {
        const message = spineErrorMessage(e);
        for (const rig of batch) outcomes.set(rig, { rig, status: 'error', error: message });
      }
    }
    if (Object.keys(record).length > 0) {
      // Re-read: the push that just ran saved its own state.
      const fresh = await loadState(cwd);
      fresh.spineRigs = { ...(fresh.spineRigs ?? {}), ...record };
      await saveState(fresh, cwd);
    }
  }
  return { skeletons: found.skeletons.length, rigs: rigs.map((r) => outcomes.get(r)!), skippedFiles: found.skipped };
}

function spineErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return 'this MagicPixel server does not accept Spine rigs yet';
  return ((e as Error)?.message ?? String(e)).split('\n')[0];
}

/** One line per rig, in the CLI's status-line style. */
export function formatSpineOutcome(o: SpineRigOutcome): string {
  const line = describeRig(o.rig);
  switch (o.status) {
    case 'saved':
      return `${icon('up')} ${line}`;
    case 'unchanged':
    case 'up-to-date':
      return `${icon('ok')} ${kleur.dim(line)}`;
    case 'dry-run':
      return `${icon('ghost')} ${line}`;
    case 'missing-folder':
      return ui.warn(`${line} — that folder isn't in MagicPixel yet`);
    case 'unsupported':
    case 'error':
      return ui.warn(`${line}: ${o.error ?? 'upload failed'}`);
  }
}

let warnedThisProcess = false;

/**
 * Sync hook: never throws. `verbose` prints every rig; otherwise only uploads
 * and problems. A failure is reported once per process.
 */
export async function syncSpineRigsQuietly(opts: {
  config: MagicPixelConfig;
  gameIndex?: GameIndex;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
  /** Test seam. */
  run?: typeof runSpineRigs;
}): Promise<SpineRunOutcome | null> {
  try {
    const outcome = await (opts.run ?? runSpineRigs)({ config: opts.config, gameIndex: opts.gameIndex, dryRun: opts.dryRun });
    if (opts.quiet) return outcome;
    const lines = outcome.rigs.filter((o) => {
      if (opts.verbose) return true;
      if (o.status === 'saved') return true;
      if (o.status === 'error' || o.status === 'missing-folder' || o.status === 'unsupported') {
        if (warnedThisProcess) return false;
        return true;
      }
      return false;
    });
    if (lines.some((o) => o.status === 'error' || o.status === 'missing-folder' || o.status === 'unsupported')) {
      warnedThisProcess = true;
    }
    if (lines.length) {
      console.log();
      for (const o of lines) console.log(formatSpineOutcome(o));
    }
    return outcome;
  } catch (e) {
    if (!opts.quiet && !warnedThisProcess) {
      warnedThisProcess = true;
      console.log();
      console.log(ui.warn(`couldn't upload Spine rigs: ${spineErrorMessage(e)}`));
    }
    return null;
  }
}

/** Test seam. */
export function __resetSpineWarnedForTesting(): void {
  warnedThisProcess = false;
}

export async function spineCommand(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<void> {
  const spin = makeSpinner('Looking for Spine skeleton exports…').start();
  let outcome: SpineRunOutcome;
  try {
    outcome = await runSpineRigs(opts);
  } finally {
    spin.stop();
  }
  for (const f of outcome.skippedFiles) console.log(ui.warn(`${f.rel}: ${f.reason}, skipped`));
  if (outcome.skeletons === 0) {
    console.log(`${icon('tip')} No Spine skeleton exports (.json) found in this project.`);
    return;
  }
  if (outcome.rigs.length === 0) {
    console.log(ui.warn(
      `Found ${outcome.skeletons} Spine skeleton${outcome.skeletons === 1 ? '' : 's'}, but no synced folder holds their part PNGs.`,
    ));
    console.log(kleur.dim('   Parts are matched by file name (head_front.png for a "head_front" attachment).'));
    return;
  }
  for (const o of outcome.rigs) console.log(formatSpineOutcome(o));
  if (opts.dryRun) {
    console.log();
    console.log(ui.dryRun());
    return;
  }
  const failed = outcome.rigs.filter((o) => o.status === 'error' || o.status === 'missing-folder').length;
  if (failed) process.exitCode = 1;
}
