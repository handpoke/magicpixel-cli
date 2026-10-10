import kleur from 'kleur';
import { ui } from '../util/ui.js';
import { confirm } from '../util/prompt.js';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { stdin } from 'node:process';
import {
  configPath, defaultConfig, loadState, saveConfig, saveState,
  type MagicPixelConfig, type SyncState, type SyncedSprite,
} from '../config.js';
import { readCredentialsSync, writeCredentials } from '../util/credentials.js';
import { indexGamePngs } from '../util/gameScan.js';
import { walkOutDirPngs } from '../util/paths.js';
import { anchorGlob, detectWorkspaceMembers } from '../util/workspace.js';
import { detectEngineKind, readWorkspaceMembers } from '../util/framework.js';
import { cmd } from '../util/invoke.js';
import { ensureGitignore } from './init.js';

/** One game folder's old, stand-alone setup. */
export interface ChildSetup {
  member: string;
  /** Raw `magicpixel.json` (null when the folder never had one). */
  config: Partial<MagicPixelConfig> | null;
  state: SyncState;
}

export interface MergedSetup {
  config: MagicPixelConfig;
  state: SyncState;
}

function earliest(values: (string | undefined)[]): string | undefined {
  return values.filter((v): v is string => !!v).sort()[0];
}

/**
 * Fold per-folder setups into one workspace setup. Globs and game paths are
 * re-anchored at the root; sprite keys are untouched, so nothing re-uploads.
 */
export function mergeSetups(members: string[], children: ChildSetup[]): MergedSetup {
  const projects = new Set(children.map((c) => c.state.projectId).filter((p): p is string => !!p));
  if (projects.size > 1) {
    throw new Error(
      `These folders are linked to different MagicPixel projects:\n` +
        children.filter((c) => c.state.projectId).map((c) => `  ${c.member}: ${c.state.projectId}`).join('\n') +
        `\n  Fix: run \`${cmd('logout')}\` in the folder you don't want to keep, then run this again.`,
    );
  }
  const configured = children.filter((c) => c.config);
  const first = configured[0]?.config ?? {};
  const uniq = (xs: string[]) => [...new Set(xs)];
  const connect = uniq(configured.flatMap((c) => {
    const globs = c.config!.connect?.length ? c.config!.connect : ['**'];
    return globs.map((g) => anchorGlob(c.member, g));
  }));
  const exclude = uniq(configured.flatMap((c) => (c.config!.exclude ?? []).map((g) => anchorGlob(c.member, g))));
  const include = uniq(configured.flatMap((c) => c.config!.include ?? defaultConfig.include));
  const firstWithOut = configured.find((c) => typeof c.config!.outDir === 'string');
  const outDir = firstWithOut ? `${firstWithOut.member}/${firstWithOut.config!.outDir}` : `${members[0]}/Assets/MagicPixel`;

  const config: MagicPixelConfig = {
    outDir,
    include: include.length ? include : defaultConfig.include,
    exclude,
    connect,
    ...(first.endpoint ? { endpoint: first.endpoint } : {}),
    ...(first.unityPpu ? { unityPpu: first.unityPpu } : {}),
    ...(first.push === false ? { push: false } : {}),
    workspace: true,
    members,
  };

  const synced: Record<string, SyncedSprite> = {};
  const assets: Record<string, string> = {};
  for (const c of children) {
    for (const [k, v] of Object.entries(c.state.synced ?? {})) {
      const next = v.sourceRel ? { ...v, sourceRel: `${c.member}/${v.sourceRel}` } : v;
      if (!synced[k] || (!synced[k].sourceRel && next.sourceRel)) synced[k] = next;
    }
    Object.assign(assets, c.state.assets ?? {});
  }
  const state: SyncState = {
    synced,
    assets,
    ...(projects.size === 1 ? { projectId: [...projects][0] } : {}),
    ...(earliest(children.map((c) => c.state.lastSync)) ? { lastSync: earliest(children.map((c) => c.state.lastSync)) } : {}),
    ...(earliest(children.map((c) => c.state.lastReconcile)) ? { lastReconcile: earliest(children.map((c) => c.state.lastReconcile)) } : {}),
  };
  return { config, state };
}

/** CLI-written AGENTS.md: delete when it's only our section, else strip it. */
export function stripAgentsSection(text: string): string | null {
  const start = text.indexOf('<!-- magicpixel:start -->');
  const endTag = '<!-- magicpixel:end -->';
  const end = text.indexOf(endTag);
  if (start < 0 || end < start) return text;
  const rest = (text.slice(0, start) + text.slice(end + endTag.length)).replace(/\n{3,}/g, '\n\n').trim();
  return rest === '' || rest === '# AGENTS' ? null : `${rest}\n`;
}

interface Move { from: string; reason: string }

/** Remove `dir` and its sub-folders when they hold nothing but `.meta`/`.DS_Store` leftovers. */
async function pruneEmptyTree(dir: string): Promise<boolean> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
  let empty = true;
  for (const e of entries) {
    const p = resolve(dir, e.name);
    if (e.name === '.DS_Store') continue;
    if (e.isDirectory() && !e.isSymbolicLink()) {
      if (!(await pruneEmptyTree(p))) empty = false;
    } else if (e.isFile() && e.name.endsWith('.meta') && !existsSync(p.slice(0, -5))) {
      await rm(p, { force: true }); // sidecar whose file or folder is gone
    } else if (!(e.isFile() && e.name.endsWith('.meta'))) {
      empty = false; // any real file keeps the folder
    }
  }
  if (!empty) return false;
  try {
    const left = (await readdir(dir)).filter((n) => n !== '.DS_Store');
    if (left.length > 0) return false;
    await rm(resolve(dir, '.DS_Store'), { force: true });
    await rmdir(dir);
    await rm(`${dir}.meta`, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}


/** True when this folder holds old per-game-folder setups worth merging. */
export function needsConsolidation(root: string = process.cwd()): boolean {
  const members = readWorkspaceMembers(root);
  if (members) {
    return members.some((m) => existsSync(resolve(root, m, 'magicpixel.json')));
  }
  return detectWorkspaceMembers(root).length >= 2;
}

/**
 * Merge every game folder's old setup into one at `root`, back up and remove
 * the leftovers, and delete copies that duplicate a real game file.
 * Returns false when the user declined or nothing was done.
 */
export async function consolidateCommand(opts: { yes?: boolean; dryRun?: boolean } = {}): Promise<boolean> {
  const root = resolve(process.cwd());
  const existing = readWorkspaceMembers(root);
  if (!existing && existsSync(configPath(root))) {
    throw new Error(
      `${root} already has its own magicpixel.json (not a monorepo setup).\n` +
        `  Fix: move it aside and run \`${cmd('consolidate')}\` again to merge every game folder here.`,
    );
  }
  const members = existing ?? detectWorkspaceMembers(root);
  if (members.length === 0) {
    console.log(kleur.yellow('No game folders found here. Run this in the folder that contains your Unity projects.'));
    return false;
  }

  const children: ChildSetup[] = [];
  for (const member of members) {
    const dir = resolve(root, member);
    const config = await readJson<Partial<MagicPixelConfig>>(resolve(dir, 'magicpixel.json'));
    const state = existsSync(resolve(dir, '.magicpixel')) ? await loadState(dir) : {};
    children.push({ member, config, state });
  }
  const withSetup = children.filter((c) => c.config || Object.keys(c.state).length);
  const merged = mergeSetups(members, children);
  if (existing) {
    // Re-run on an existing workspace: root records already use root-relative paths.
    const rootState = await loadState(root);
    merged.state.synced = { ...merged.state.synced, ...(rootState.synced ?? {}) };
    merged.state.assets = { ...merged.state.assets, ...(rootState.assets ?? {}) };
    const current = await readJson<MagicPixelConfig>(configPath(root));
    if (current) {
      merged.config = {
        ...current,
        connect: [...new Set([...(current.connect ?? []), ...merged.config.connect])],
        exclude: [...new Set([...(current.exclude ?? []), ...merged.config.exclude])],
      };
    }
  }

  // Plan the cleanup.
  const moves: Move[] = [];
  for (const c of withSetup) {
    const dir = resolve(root, c.member);
    for (const name of ['magicpixel.json', 'magicpixel.json.meta', '.magicpixel']) {
      if (existsSync(resolve(dir, name))) moves.push({ from: resolve(dir, name), reason: 'old setup' });
    }
  }
  const agentsEdits: { path: string; next: string | null }[] = [];
  for (const c of withSetup) {
    const path = resolve(root, c.member, 'AGENTS.md');
    if (!existsSync(path)) continue;
    const text = await readFile(path, 'utf8');
    const next = stripAgentsSection(text);
    if (next !== text) agentsEdits.push({ path, next });
  }

  // Copies under a folder's old outDir that duplicate a real game file
  // (each folder indexed on its own — same keys the workspace will use).
  const liveKeys = new Set<string>();
  for (const m of members) {
    const kind = detectEngineKind(resolve(root, m));
    if (!kind) continue;
    (await indexGamePngs(kind, resolve(root, m), '', {})).files.forEach((f) => liveKeys.add(f.key));
  }
  const rootOut = resolve(root, merged.config.outDir);
  const relocate: { from: string; to: string }[] = [];
  for (const c of withSetup) {
    if (typeof c.config?.outDir !== 'string') continue;
    const childOut = resolve(root, c.member, c.config.outDir);
    if (!existsSync(childOut)) continue;
    for (const d of await walkOutDirPngs(c.config.outDir, resolve(root, c.member))) {
      if (liveKeys.has(d.key)) moves.push({ from: d.abs, reason: 'copy of a game file' });
      else if (resolve(childOut) !== rootOut) relocate.push({ from: d.abs, to: resolve(rootOut, relative(childOut, d.abs)) });
    }
  }
  const strayCount = moves.filter((m) => m.reason === 'copy of a game file').length;
  if (existing && moves.length === 0 && agentsEdits.length === 0 && relocate.length === 0) {
    console.log(ui.ok('Already one MagicPixel setup here — nothing to merge.'));
    return false;
  }

  // Show the plan.
  const rel = (p: string) => relative(root, p) || '.';
  console.log(kleur.bold(`One MagicPixel setup for ${rel(root) === '.' ? root : rel(root)}`));
  console.log(`  Game folders: ${members.map((m) => (withSetup.some((c) => c.member === m) ? kleur.cyan(m) : kleur.dim(`${m} (not connected)`))).join(', ')}`);
  console.log(`  Watching:     ${merged.config.connect.join(', ') || kleur.dim('nothing yet')}`);
  if (merged.config.exclude.length) console.log(`  Skipping:     ${merged.config.exclude.join(', ')}`);
  console.log(`  New art goes: next to its sibling files, otherwise ${merged.config.outDir}`);
  const oldSetups = moves.filter((m) => m.reason === 'old setup');
  if (oldSetups.length) console.log(`  Removing old setup files: ${oldSetups.map((m) => rel(m.from)).join(', ')}`);
  if (agentsEdits.length) console.log(`  Removing generated notes from: ${agentsEdits.map((a) => rel(a.path)).join(', ')}`);
  if (strayCount) console.log(`  Deleting ${strayCount} stray cop${strayCount === 1 ? 'y' : 'ies'} of game files (and their .meta)`);
  if (relocate.length) console.log(`  Moving ${relocate.length} MagicPixel-only file${relocate.length === 1 ? '' : 's'} into ${merged.config.outDir}`);
  const unconnected = members.filter((m) => !withSetup.some((c) => c.member === m));
  if (unconnected.length) {
    console.log(kleur.dim(`  ${unconnected.join(', ')} stay${unconnected.length === 1 ? 's' : ''} out until you run \`${cmd('connect')} "<folder>/**"\`.`));
  }
  console.log(kleur.dim(`  Everything removed is backed up to .magicpixel/backup/. Your game PNGs are never touched.`));

  if (opts.dryRun) {
    console.log(kleur.dim('--dry-run: nothing changed.'));
    return false;
  }
  if (!opts.yes && !(await confirm('Merge into one setup? (y/N) '))) {
    console.log(kleur.dim(stdin.isTTY ? 'Nothing changed.' : 'Nothing changed. Re-run with --yes to apply.'));
    return false;
  }

  // Apply. The root .magicpixel/ holds the login key and backups — keep it out of git.
  await ensureGitignore(root);
  // Credentials first (they live inside the .magicpixel folders we move).
  if (!readCredentialsSync(root)) {
    const key = withSetup.map((c) => readCredentialsSync(resolve(root, c.member))).find(Boolean)?.apiKey;
    if (key) await writeCredentials(key, root);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = resolve(root, '.magicpixel', 'backup', stamp);
  const backupMove = async (from: string) => {
    const to = resolve(backup, relative(root, from));
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  };
  for (const m of moves) {
    if (!existsSync(m.from)) continue;
    await backupMove(m.from);
    if (m.reason === 'copy of a game file' && existsSync(`${m.from}.meta`)) await backupMove(`${m.from}.meta`);
  }
  for (const r of relocate) {
    if (existsSync(r.to)) { await backupMove(r.from); continue; }
    await mkdir(dirname(r.to), { recursive: true });
    await rename(r.from, r.to);
    if (existsSync(`${r.from}.meta`)) await rename(`${r.from}.meta`, `${r.to}.meta`);
  }
  for (const c of withSetup) {
    if (typeof c.config?.outDir !== 'string') continue;
    const childOut = resolve(root, c.member, c.config.outDir);
    if (resolve(childOut) !== rootOut) await pruneEmptyTree(childOut);
  }
  for (const a of agentsEdits) {
    if (a.next === null) {
      await backupMove(a.path);
      if (existsSync(`${a.path}.meta`)) await backupMove(`${a.path}.meta`);
    } else {
      await writeFile(a.path, a.next);
    }
  }
  await saveConfig(merged.config, root);
  await saveState(merged.state, root);
  console.log(ui.ok(`One setup at ${root}. Run sync from here (or any game folder — it finds this one).`));
  return true;
}
