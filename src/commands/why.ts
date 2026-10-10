import kleur from 'kleur';
import { spinner as makeSpinner } from '../util/ui.js';
import { loadConfig, loadState, type MagicPixelConfig, type SyncedSprite } from '../config.js';
import { detectProjectKind, isEngineKind } from '../util/framework.js';
import { countingSpritesText, entryMatchesGlob, indexGamePngs, rootSpriteDotDirs, type GameIndexEntry } from '../util/gameScan.js';
import { hashFile } from '../util/hash.js';
import { indexSyncedBySourceRel, resolveSyncedKey } from '../util/pushPlan.js';
import { normalizeScopeFolder } from '../util/syncScope.js';
import { cmd } from '../util/invoke.js';
import { resolveInvokedPath } from '../util/workspace.js';
import { relative } from 'node:path';

export type WhyVerdict =
  | { kind: 'not-watched' }
  | { kind: 'excluded'; rule: string }
  | { kind: 'new' }
  | { kind: 'changed'; layers?: number }
  | { kind: 'unchanged' }
  | { kind: 'legacy' };

/** What the next sync does with one game PNG — no network, local facts only. */
export function explainSprite(
  entry: GameIndexEntry,
  config: Pick<MagicPixelConfig, 'connect' | 'exclude'>,
  synced: Record<string, SyncedSprite>,
  currentSha: string | null,
): WhyVerdict {
  const hit = (g: string) => entryMatchesGlob(entry, g);
  if (!(config.connect ?? []).some(hit)) return { kind: 'not-watched' };
  const rule = (config.exclude ?? []).find(hit);
  if (rule !== undefined) return { kind: 'excluded', rule };
  const stateKey = resolveSyncedKey({ key: entry.key, sourceRel: entry.sourceRel }, synced, indexSyncedBySourceRel(synced));
  const known = stateKey ? synced[stateKey] : undefined;
  if (!known) return { kind: 'new' };
  if (known.legacy) return { kind: 'legacy' };
  if (currentSha && known.diskSha256 === currentSha) return { kind: 'unchanged' };
  return { kind: 'changed', ...(typeof known.layers === 'number' ? { layers: known.layers } : {}) };
}

export function describeVerdict(v: WhyVerdict, config: Pick<MagicPixelConfig, 'connect'>): string {
  switch (v.kind) {
    case 'not-watched':
      return `not watched — no "connect" pattern matches it (${(config.connect ?? []).join(', ') || 'none'}). Fix: ${cmd('connect')} '<folder>/**'`;
    case 'excluded':
      return `skipped by exclude rule "${v.rule}" — remove it from "exclude" in magicpixel.json to sync this file`;
    case 'new':
      return 'new — the next sync adds it to MagicPixel';
    case 'changed':
      return v.layers && v.layers > 1
        ? `changed locally, but the MagicPixel artboard has ${v.layers} layers — run \`${cmd('push')} --flatten\` to replace it`
        : 'changed locally — the next sync uploads it';
    case 'unchanged':
      return 'unchanged since the last sync';
    case 'legacy':
      return 'linked to a legacy single-image file — open it in MagicPixel and save once, then sync again';
  }
}

export async function whyCommand(pathArg: string): Promise<void> {
  const config = await loadConfig();
  const state = await loadState();
  const kind = await detectProjectKind();
  if (!isEngineKind(kind)) {
    console.log(kleur.yellow('This folder is not a Unity/Godot/GameMaker project — sync only downloads here, it never uploads.'));
    return;
  }
  const target = normalizeScopeFolder(resolveInvokedPath(pathArg)).toLowerCase();
  const spinner = makeSpinner({ text: countingSpritesText(0), spinner: 'dots' }).start();
  const index = await indexGamePngs(kind, process.cwd(), config.outDir, {
    onProgress: (p) => { spinner.text = countingSpritesText(p); },
  });
  spinner.stop();
  const files = index.files.filter((e) => {
    const rel = e.sourceRel.toLowerCase();
    return rel === target || rel.startsWith(`${target}/`);
  });
  if (files.length === 0) {
    const dots = (await rootSpriteDotDirs(process.cwd())).map((d) => relative(process.cwd(), d));
    console.log(kleur.yellow(`No PNGs found under ${pathArg} (scanned ${index.files.length.toLocaleString('en-US')} PNGs).`));
    const scanned = config.members?.length ? config.members.map((m) => `${m}/`).join(', ') : `Assets/${dots.length ? `, ${dots.join(', ')}` : ''}`;
    console.log(kleur.dim(`  Paths are relative to ${process.cwd()}. Scanned: ${scanned}.`));
    return;
  }
  const synced = state.synced ?? {};
  const counts = new Map<string, number>();
  const lines: string[] = [];
  for (const e of files) {
    const sha = (await hashFile(e.abs))?.sha256 ?? null;
    const text = describeVerdict(explainSprite(e, config, synced, sha), config);
    counts.set(text, (counts.get(text) ?? 0) + 1);
    if (lines.length < 20) lines.push(`  ${e.sourceRel}\n    ${kleur.dim('→')} ${text}`);
  }
  console.log(kleur.bold(`${files.length.toLocaleString('en-US')} PNG${files.length === 1 ? '' : 's'} under ${pathArg}:`));
  for (const [text, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kleur.cyan(String(n).padStart(5))}  ${text}`);
  }
  console.log();
  console.log(lines.join('\n'));
  if (files.length > lines.length) console.log(kleur.dim(`  …and ${files.length - lines.length} more`));
}
