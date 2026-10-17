/**
 * Spine rig auto-detection: find the game's exported skeleton JSONs, work out
 * which synced library folders hold their part PNGs, and describe the rigs the
 * MagicPixel preview should use.
 *
 * King Rabbit layout (the case this was built for):
 *   Editor/RemoteBundleAssets/rabbit/base/rabbit_{front,side,back}.json   skeletons (not synced)
 *   .SpineRaw/rabbit/<skin>/head_front.png …                               one folder per skin
 *   .SpineRaw/rabbit-pixel/…                                               default parts + shadow
 * → one rig "rabbit" with views front/side/back, bound to `rabbit/` (every
 *   skin folder below it), with `rabbit-pixel/` supplying missing parts.
 *
 * Detection is pure apart from `findSkeletonFiles`, so the matching rules are
 * unit-testable without a game tree.
 */
import { createHash } from 'node:crypto';
import { open, opendir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { shouldSkipDir, type GameIndexEntry } from './gameScan.js';
import { gameImportAdoptPath } from './pushPlan.js';
import { createLimit } from './limit.js';

/** The only Spine version the MagicPixel preview reads (major.minor). */
export const SUPPORTED_SPINE_VERSION = '4.3';
/** Server limits (see `src/lib/integration/spine.server.ts`). */
export const MAX_SKELETON_BYTES = 8 * 1024 * 1024;
export const MAX_VIEWS_PER_RIG = 6;
export const MAX_RIGS_PER_REQUEST = 10;
/** Bytes read to decide whether a .json is a skeleton export. */
const HEAD_BYTES = 300;
/** Stop after this many skeletons; a game with more is not what this is for. */
const MAX_SKELETONS = 200;
/** A folder is a skin folder when at least this share of its PNGs are rig images. */
const SKIN_SHARE = 0.5;
/** Base folder / view grouping need at least this share of the rig's images. */
const COVER_SHARE = 0.5;

// ---------- skeleton JSON ----------

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Attachment types that draw an image (no `type` means region). */
const IMAGE_ATTACHMENTS = new Set([undefined, 'region', 'mesh', 'linkedmesh']);

/** Cheap pre-check on the first bytes of a .json: Spine exports open with `{"skeleton":{…"spine":"4.3.23"`. */
export function looksLikeSkeleton(head: string): boolean {
  return head.includes('"skeleton"') && head.includes('"spine"');
}

/** `"4.3.23"` → `"4.3"`; null when it doesn't look like a version. */
export function spineMinorVersion(version: string): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

function sequencePaths(path: string, sequence: JsonObject): string[] {
  const count = Number(sequence.count ?? 0);
  const start = Number(sequence.start ?? 1);
  const digits = Number(sequence.digits ?? 0);
  const out: string[] = [];
  for (let i = 0; i < count && i < 10_000; i++) out.push(path + String(start + i).padStart(digits, '0'));
  return out;
}

function skinEntries(skins: unknown): JsonObject[] {
  if (Array.isArray(skins)) return skins.filter(isObject).map((s) => (isObject(s.attachments) ? s.attachments : {}));
  if (isObject(skins)) return Object.values(skins).filter(isObject);
  return [];
}

/**
 * What matching needs from a skeleton export, mirroring the app's
 * `readSkeletonInfo` (`src/lib/spine/rig.ts`): every image any skin draws
 * (`path ?? name ?? key`, sequences expanded). Null when it isn't a skeleton.
 */
export function readSkeletonImages(json: unknown): { spineVersion: string; images: string[] } | null {
  if (!isObject(json) || !isObject(json.skeleton) || !Array.isArray(json.bones)) return null;
  const images = new Set<string>();
  for (const slots of skinEntries(json.skins)) {
    for (const attachments of Object.values(slots)) {
      if (!isObject(attachments)) continue;
      for (const [key, attachment] of Object.entries(attachments)) {
        if (!isObject(attachment)) continue;
        if (!IMAGE_ATTACHMENTS.has(attachment.type as string | undefined)) continue;
        const path = String(attachment.path ?? attachment.name ?? key);
        if (isObject(attachment.sequence)) sequencePaths(path, attachment.sequence).forEach((p) => images.add(p));
        else images.add(path);
      }
    }
  }
  return { spineVersion: String(json.skeleton.spine ?? ''), images: [...images].sort() };
}

/** File-name key an image path matches: its last segment, lower-cased. */
export function imageKey(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Short view names: the part after the shared prefix (`rabbit_front.json`,
 * `rabbit_side.json` → "front", "side"). Same rule as the app's `viewNames`.
 */
export function viewNames(fileNames: string[]): string[] {
  const bases = fileNames.map((f) => f.replace(/\.json$/i, ''));
  if (bases.length < 2) return bases;
  let prefix = bases[0];
  for (const b of bases) while (!b.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-'), prefix.lastIndexOf('.')) + 1;
  const names = bases.map((b) => b.slice(cut));
  return names.every(Boolean) && new Set(names).size === names.length ? names : bases;
}

/** Rig name: the shared file prefix (`rabbit`), else the file / directory name. */
export function rigName(fileNames: string[], dirName: string): string {
  const bases = fileNames.map((f) => f.replace(/\.json$/i, ''));
  if (bases.length === 1) return bases[0];
  const views = viewNames(fileNames);
  if (views.some((v, i) => v !== bases[i]) && views.every((v, i) => bases[i].endsWith(v))) {
    const prefix = bases[0].slice(0, bases[0].length - views[0].length).replace(/[_.-]+$/, '');
    if (prefix) return prefix;
  }
  return dirName;
}

const VIEW_ORDER = ['front', 'side', 'back'];
function viewRank(name: string): number {
  const i = VIEW_ORDER.indexOf(name.toLowerCase());
  return i === -1 ? VIEW_ORDER.length : i;
}

// ---------- finding skeletons on disk ----------

export interface SkeletonFile {
  abs: string;
  /** Path relative to the setup folder, for messages. */
  rel: string;
  /** Raw file text (sent as-is so the hash matches what's uploaded). */
  text: string;
  json: unknown;
  spineVersion: string;
  images: string[];
}

async function readHead(abs: string): Promise<string> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export interface FindSkeletonsResult {
  skeletons: SkeletonFile[];
  /** Skeleton exports that couldn't be used (too big, unreadable). */
  skipped: { rel: string; reason: string }[];
}

/**
 * Walk `roots` for Spine skeleton JSONs. Skips the same engine/VCS folders as
 * the sprite scan (Library, Temp, node_modules, .git, …) and `skipDirs`.
 */
export async function findSkeletonFiles(
  roots: readonly string[],
  base: string,
  skipDirs: readonly string[] = [],
): Promise<FindSkeletonsResult> {
  const skip = new Set(skipDirs.map((d) => resolve(d).replace(/\\/g, '/').toLowerCase()));
  const io = createLimit(8);
  const candidates: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 24 || skip.has(dir.replace(/\\/g, '/').toLowerCase())) return;
    const subdirs: string[] = [];
    await io(async () => {
      let dh;
      try {
        dh = await opendir(dir);
      } catch {
        return;
      }
      try {
        for await (const ent of dh) {
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (!shouldSkipDir(ent.name)) subdirs.push(resolve(dir, ent.name));
          } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
            candidates.push(resolve(dir, ent.name));
          }
        }
      } catch {
        /* unreadable mid-listing */
      }
    });
    await Promise.all(subdirs.map((d) => walk(d, depth + 1)));
  };
  for (const root of new Set(roots.map((r) => resolve(r)))) await walk(root, 0);
  candidates.sort();

  const skeletons: SkeletonFile[] = [];
  const skipped: FindSkeletonsResult['skipped'] = [];
  await Promise.all(candidates.map((abs) => io(async () => {
    if (skeletons.length >= MAX_SKELETONS) return;
    const rel = relative(base, abs).replace(/\\/g, '/');
    try {
      if (!looksLikeSkeleton(await readHead(abs))) return;
      const size = (await stat(abs)).size;
      if (size > MAX_SKELETON_BYTES) {
        skipped.push({ rel, reason: 'larger than 8 MB' });
        return;
      }
      const text = await readFile(abs, 'utf8');
      const json: unknown = JSON.parse(text);
      const info = readSkeletonImages(json);
      if (!info) return;
      skeletons.push({ abs, rel, text, json, ...info });
    } catch {
      /* not JSON after all / unreadable — not a skeleton we can use */
    }
  })));
  skeletons.sort((a, b) => a.abs.localeCompare(b.abs));
  skipped.sort((a, b) => a.rel.localeCompare(b.rel));
  return { skeletons, skipped };
}

// ---------- synced folders ----------

export interface SyncedPng {
  /** Library folder slugs, exactly as push sends them in `path` (`spineraw/rabbit/spider`). */
  folder: string[];
  /** Display names for `folder` (disk names), same length. */
  folderNames: string[];
  /** File name without `.png`, lower-cased. */
  name: string;
}

/**
 * Library folder of each connected game PNG. Uses the same disk → library
 * mapping as push (`gameImportAdoptPath`), so `.SpineRaw/rabbit/spider/head_front.png`
 * lives in folder `spineraw / rabbit / spider`.
 */
export function syncedPngsFromEntries(entries: readonly GameIndexEntry[]): SyncedPng[] {
  const out: SyncedPng[] = [];
  for (const e of entries) {
    const adopted = gameImportAdoptPath(e.adoptRel.replace(/\.png$/i, '').split('/'));
    const n = adopted.path.length - 2;
    if (n < 1) continue;
    out.push({
      folder: adopted.path.slice(0, n),
      folderNames: adopted.pathNames.slice(0, n),
      name: basename(e.abs).replace(/\.png$/i, '').toLowerCase(),
    });
  }
  return out;
}

interface FolderInfo {
  key: string;
  segments: string[];
  names: string[];
  pngs: Set<string>;
}

function indexFolders(pngs: readonly SyncedPng[]): Map<string, FolderInfo> {
  const folders = new Map<string, FolderInfo>();
  for (const p of pngs) {
    const key = p.folder.join('/');
    let f = folders.get(key);
    if (!f) folders.set(key, (f = { key, segments: p.folder, names: p.folderNames, pngs: new Set() }));
    f.pngs.add(p.name);
  }
  return folders;
}

function countIn(set: ReadonlySet<string>, keys: ReadonlySet<string>): number {
  let n = 0;
  for (const k of keys) if (set.has(k)) n++;
  return n;
}

function isInside(segments: readonly string[], root: readonly string[]): boolean {
  return segments.length >= root.length && root.every((s, i) => segments[i] === s);
}

// ---------- rigs ----------

export interface DetectedRigView {
  name: string;
  file: SkeletonFile;
}

export interface DetectedRig {
  name: string;
  /** Directory holding the skeletons (setup-relative), for messages. */
  dir: string;
  views: DetectedRigView[];
  spineVersion: string;
  /** Library folder the rig is bound to (applies to it and every folder below). */
  folderPath: string[];
  folderLabel: string;
  /** Skin folders below the bound folder (1 when bound to a single folder). */
  skins: number;
  baseFolderPath: string[] | null;
  baseFolderLabel: string | null;
  /** sha256 over the skeleton files + bound folder paths. */
  hash: string;
}

/** Groups skeletons in one directory into rigs (views of the same character). */
export function groupSkeletons(
  skeletons: readonly SkeletonFile[],
  folders: ReadonlyMap<string, FolderInfo>,
): SkeletonFile[][] {
  const byDir = new Map<string, SkeletonFile[]>();
  for (const s of skeletons) {
    const d = dirname(s.abs);
    byDir.set(d, [...(byDir.get(d) ?? []), s]);
  }
  const groups: SkeletonFile[][] = [];
  for (const files of byDir.values()) {
    const keys = files.map((f) => new Set(f.images.map(imageKey)));
    const parent = files.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (sameRig(keys[i], keys[j], folders)) parent[find(i)] = find(j);
      }
    }
    const byRoot = new Map<number, SkeletonFile[]>();
    files.forEach((f, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), f]));
    groups.push(...byRoot.values());
  }
  return groups;
}

/**
 * Two skeletons are views of one rig when their images overlap heavily, or
 * when one synced folder holds most of both (views whose parts are named per
 * view, `head_front` / `head_side`, still share every skin folder).
 */
function sameRig(a: ReadonlySet<string>, b: ReadonlySet<string>, folders: ReadonlyMap<string, FolderInfo>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  if (countIn(a, b) >= COVER_SHARE * Math.min(a.size, b.size)) return true;
  for (const f of folders.values()) {
    if (countIn(f.pngs, a) >= COVER_SHARE * a.size && countIn(f.pngs, b) >= COVER_SHARE * b.size) return true;
  }
  return false;
}

export function rigHash(rig: Pick<DetectedRig, 'name' | 'folderPath' | 'baseFolderPath'> & { views: { name: string; text: string }[] }): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({
    name: rig.name,
    folderPath: rig.folderPath,
    baseFolderPath: rig.baseFolderPath,
    views: rig.views.map((v) => [v.name, createHash('sha256').update(v.text).digest('hex')]),
  }));
  return h.digest('hex');
}

const label = (names: readonly string[]) => `${names[names.length - 1]}/`;

/**
 * Turns skeleton files + the synced PNGs into rigs bound to library folders.
 * Rigs whose images match no synced folder are left out.
 */
export function detectRigs(
  skeletons: readonly SkeletonFile[],
  pngs: readonly SyncedPng[],
  base: string = process.cwd(),
): DetectedRig[] {
  const folders = indexFolders(pngs);
  const rigs: DetectedRig[] = [];
  for (const group of groupSkeletons(skeletons, folders)) {
    const files = [...group].sort((a, b) => a.abs.localeCompare(b.abs)).slice(0, MAX_VIEWS_PER_RIG);
    const names = viewNames(files.map((f) => basename(f.abs)));
    const views = files
      .map((file, i) => ({ name: names[i], file }))
      .sort((a, b) => viewRank(a.name) - viewRank(b.name) || a.name.localeCompare(b.name));
    const keys = new Set(files.flatMap((f) => f.images.map(imageKey)));
    if (keys.size === 0) continue;

    // Skin folders: mostly made of this rig's images.
    const skins: { f: FolderInfo; hits: number }[] = [];
    for (const f of folders.values()) {
      const hits = countIn(f.pngs, keys);
      if (hits > 0 && hits >= SKIN_SHARE * f.pngs.size) skins.push({ f, hits });
    }
    if (skins.length === 0) continue;

    // Several skin folders side by side → bind to their parent (`rabbit/`).
    const byParent = new Map<string, { segments: string[]; names: string[]; count: number; hits: number }>();
    for (const { f, hits } of skins) {
      if (f.segments.length < 2) continue;
      const key = f.segments.slice(0, -1).join('/');
      const p = byParent.get(key) ?? { segments: f.segments.slice(0, -1), names: f.names.slice(0, -1), count: 0, hits: 0 };
      p.count++;
      p.hits += hits;
      byParent.set(key, p);
    }
    const parent = [...byParent.values()]
      .filter((p) => p.count >= 2)
      .sort((a, b) => b.count - a.count || b.hits - a.hits || a.segments.join('/').localeCompare(b.segments.join('/')))[0];
    let folderPath: string[];
    let folderNames: string[];
    let skinCount: number;
    if (parent) {
      folderPath = parent.segments;
      folderNames = parent.names;
      skinCount = parent.count;
    } else {
      const best = [...skins].sort((a, b) => b.hits - a.hits || a.f.key.localeCompare(b.f.key))[0];
      folderPath = best.f.segments;
      folderNames = best.f.names;
      skinCount = 1;
    }

    // Base folder: outside the bound folder, holding the most rig images (≥ half).
    let baseFolder: { f: FolderInfo; hits: number } | null = null;
    for (const f of folders.values()) {
      if (isInside(f.segments, folderPath)) continue;
      const hits = countIn(f.pngs, keys);
      if (!baseFolder || hits > baseFolder.hits || (hits === baseFolder.hits && f.key < baseFolder.f.key)) baseFolder = { f, hits };
    }
    if (baseFolder && baseFolder.hits < COVER_SHARE * keys.size) baseFolder = null;

    const name = rigName(files.map((f) => basename(f.abs)), basename(dirname(files[0].abs)));
    const baseFolderPath = baseFolder?.f.segments ?? null;
    rigs.push({
      name,
      dir: relative(base, dirname(files[0].abs)).replace(/\\/g, '/') || '.',
      views,
      spineVersion: files[0].spineVersion,
      folderPath,
      folderLabel: label(folderNames),
      skins: skinCount,
      baseFolderPath,
      baseFolderLabel: baseFolder ? label(baseFolder.f.names) : null,
      hash: rigHash({ name, folderPath, baseFolderPath, views: views.map((v) => ({ name: v.name, text: v.file.text })) }),
    });
  }
  return onePerFolder(rigs).sort((a, b) => a.name.localeCompare(b.name) || a.folderPath.join('/').localeCompare(b.folderPath.join('/')));
}

/**
 * A folder holds one rig. When several exports bind to the same folder (an
 * old 3.8 copy next to the 4.3 one), keep the one the preview can read, then
 * the one with the most views and images.
 */
function onePerFolder(rigs: DetectedRig[]): DetectedRig[] {
  const score = (r: DetectedRig) => [
    rigVersionSupported(r) ? 1 : 0,
    r.views.length,
    new Set(r.views.flatMap((v) => v.file.images)).size,
  ];
  const best = new Map<string, DetectedRig>();
  for (const r of rigs) {
    const key = r.folderPath.join('/');
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    const [a, b] = [score(r), score(cur)];
    const i = a.findIndex((v, k) => v !== b[k]);
    if (i !== -1 && a[i] > b[i]) best.set(key, r);
  }
  return [...best.values()];
}

/** True when the preview can read this rig's exports. */
export function rigVersionSupported(rig: Pick<DetectedRig, 'views'>): boolean {
  return rig.views.every((v) => spineMinorVersion(v.file.spineVersion) === SUPPORTED_SPINE_VERSION);
}

/** `Spine rig rabbit (front, side, back) → rabbit/ (509 skins), parts fallback rabbit-pixel/` */
export function describeRig(rig: DetectedRig): string {
  const views = rig.views.length > 1 || rig.views[0]?.name !== rig.name ? ` (${rig.views.map((v) => v.name).join(', ')})` : '';
  const skins = rig.skins > 1 ? ` (${rig.skins.toLocaleString('en-US')} skins)` : '';
  const base = rig.baseFolderLabel ? `, parts fallback ${rig.baseFolderLabel}` : '';
  return `Spine rig ${rig.name}${views} → ${rig.folderLabel}${skins}${base}`;
}

/** Rigs whose hash differs from the one last uploaded for that folder. */
export function rigsToUpload(rigs: readonly DetectedRig[], uploaded: Readonly<Record<string, string>> | undefined): DetectedRig[] {
  return rigs.filter((r) => uploaded?.[r.folderPath.join('/')] !== r.hash);
}

/** Batches for the upload endpoint: ≤ 10 rigs and about `maxBytes` of skeleton text each. */
export function batchRigs<T extends DetectedRig>(rigs: readonly T[], maxBytes = 16 * 1024 * 1024): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of rigs) {
    const size = r.views.reduce((n, v) => n + v.file.text.length, 0);
    if (cur.length > 0 && (cur.length >= MAX_RIGS_PER_REQUEST || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
