import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { indexGamePngs, matchConnectGlobs } from '../src/util/gameScan.js';
import {
  batchRigs,
  describeRig,
  detectRigs,
  findSkeletonFiles,
  looksLikeSkeleton,
  readSkeletonImages,
  rigName,
  rigsToUpload,
  syncedPngsFromEntries,
  viewNames,
  type SkeletonFile,
  type SyncedPng,
} from '../src/util/spine.js';
import { __resetSpineWarnedForTesting, runSpineRigs, syncSpineRigsQuietly } from '../src/commands/spine.js';
import type { PushSpineRig, SpineRigResult } from '../src/api.js';
import type { MagicPixelConfig } from '../src/config.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c63f8cfc0f01f0005000201a5b1d8d50000000049454e44ae426082',
  'hex',
);

function put(path: string, body: string | Buffer = PNG): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A Spine 4.x export (skins as an array) drawing `images` from one slot each. */
function skeleton(images: string[], version = '4.3.23'): Record<string, unknown> {
  return {
    skeleton: { hash: 'x', spine: version, x: 0, y: 0, width: 10, height: 10 },
    bones: [{ name: 'root' }],
    slots: images.map((i) => ({ name: i, bone: 'root', attachment: i })),
    skins: [{ name: 'default', attachments: Object.fromEntries(images.map((i) => [i, { [i]: { width: 1, height: 1 } }])) }],
    animations: { run: {}, idle: {} },
  };
}

const PARTS = ['head', 'body', 'ear_left', 'ear_right', 'arm', 'leg'];
const viewParts = (view: string) => PARTS.map((p) => `${p}_${view}`);
const SKINS = ['spider', 'agni', 'poseidon'];

/** King Rabbit in miniature (one game folder of a monorepo). */
function krRepo(opts: { sharedImages?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'mp-spine-'));
  const kr = join(root, 'kr-remote-bundles');
  put(join(kr, 'Assets', 'x.meta'), 'meta');
  const base = join(kr, 'Editor', 'RemoteBundleAssets', 'rabbit', 'base');
  for (const view of ['front', 'side', 'back']) {
    // Per-view part names (head_front …), or every view drawing every part.
    const imgs = opts.sharedImages ? ['front', 'side', 'back'].flatMap(viewParts) : viewParts(view);
    put(join(base, `rabbit_${view}.json`), JSON.stringify(skeleton([...imgs, 'shadow'])));
  }
  put(join(base, 'rabbit.atlas.txt'), 'atlas');
  put(join(base, 'rabbit.png'));
  put(join(kr, 'Editor', 'RemoteBundleAssets', 'ring', 'ring.json'), JSON.stringify(skeleton(['ring_gem', 'ring_band'])));
  // An older export of the ring (Spine 3.8) binds to the same folder: the 4.3 one wins.
  put(join(kr, 'Editor', 'RemoteBundleAssets', 'old', 'ring_old.json'), JSON.stringify(skeleton(['ring_gem', 'ring_band'], '3.8.99')));
  // A Spine 3.8 rig of its own: found, but not uploaded.
  put(join(kr, 'Editor', 'RemoteBundleAssets', 'bow', 'bow.json'), JSON.stringify(skeleton(['bow_a', 'bow_b'], '3.8.99')));
  put(join(kr, '.SpineRaw', 'bow', 'red', 'bow_a.png'));
  put(join(kr, '.SpineRaw', 'bow', 'red', 'bow_b.png'));
  put(join(kr, 'package.json'), JSON.stringify({ name: 'kr-remote-bundles', skeleton: false }));
  // A skeleton inside an ignored folder is never found.
  put(join(kr, 'Library', 'cache', 'rabbit_front.json'), JSON.stringify(skeleton(viewParts('front'))));
  for (const skin of SKINS) {
    for (const view of ['front', 'side', 'back']) for (const img of viewParts(view)) put(join(kr, '.SpineRaw', 'rabbit', skin, `${img}.png`));
  }
  // A partial skin: only some parts, still mostly rig images.
  put(join(kr, '.SpineRaw', 'rabbit', 'mini', 'head_front.png'));
  put(join(kr, '.SpineRaw', 'rabbit', 'mini', 'Body_Front.png'));
  for (const view of ['front', 'side', 'back']) for (const img of viewParts(view)) put(join(kr, '.SpineRaw', 'rabbit-pixel', `${img}.png`));
  put(join(kr, '.SpineRaw', 'rabbit-pixel', 'shadow.png'));
  // Rings: one skin folder only.
  put(join(kr, '.SpineRaw', 'ring', 'gold', 'ring_gem.png'));
  put(join(kr, '.SpineRaw', 'ring', 'gold', 'ring_band.png'));
  // Unrelated art.
  put(join(kr, 'Assets', 'UI', 'logo.png'));
  put(join(kr, 'Assets', 'UI', 'head_front.png'));
  writeFileSync(
    join(root, 'magicpixel.json'),
    JSON.stringify({ outDir: 'Assets/MagicPixel', include: ['**/*'], exclude: [], connect: ['**'], workspace: true, members: ['kr-remote-bundles'] }),
  );
  return root;
}

const config: MagicPixelConfig = { outDir: 'Assets/MagicPixel', include: ['**/*'], exclude: [], connect: ['**'], workspace: true, members: ['kr-remote-bundles'] };

async function scan(root: string) {
  const index = await indexGamePngs('Unity', root, config.outDir);
  const pngs = syncedPngsFromEntries(matchConnectGlobs(index, config.connect, config.exclude).entries);
  const found = await findSkeletonFiles([join(root, 'kr-remote-bundles')], root);
  return { index, pngs, found };
}

describe('skeleton detection', () => {
  it('pre-checks the head of a .json cheaply', () => {
    expect(looksLikeSkeleton('{"skeleton":{"hash":"abc","spine":"4.3.23","x":0')).toBe(true);
    expect(looksLikeSkeleton('{"name":"kr-remote-bundles","version":"1.0.0"}')).toBe(false);
    expect(looksLikeSkeleton('{"skeleton": true}')).toBe(false);
  });

  it('reads attachment images like the app (path ?? name, sequences, 3.x object skins)', () => {
    const v4 = {
      skeleton: { spine: '4.3.23' },
      bones: [],
      skins: [{
        name: 'default',
        attachments: {
          a: { head: {}, hat: { name: 'parts/hat_front' }, arm: { path: 'arm_alt' }, box: { type: 'boundingbox' } },
          b: { blink: { type: 'mesh', sequence: { count: 3, start: 1, digits: 2 } }, link: { type: 'linkedmesh', path: 'leg' } },
        },
      }],
    };
    expect(readSkeletonImages(v4)).toEqual({
      spineVersion: '4.3.23',
      images: ['arm_alt', 'blink01', 'blink02', 'blink03', 'head', 'leg', 'parts/hat_front'],
    });
    const v3 = { skeleton: { spine: '3.8.99' }, bones: [], skins: { default: { s: { tail: {} } } } };
    expect(readSkeletonImages(v3)?.images).toEqual(['tail']);
    expect(readSkeletonImages({ skeleton: {} })).toBeNull();
  });

  it('finds skeleton exports anywhere in the game folder, but not in Library', async () => {
    const root = krRepo();
    const { found } = await scan(root);
    expect(found.skeletons.map((s) => s.rel)).toEqual([
      'kr-remote-bundles/Editor/RemoteBundleAssets/bow/bow.json',
      'kr-remote-bundles/Editor/RemoteBundleAssets/old/ring_old.json',
      'kr-remote-bundles/Editor/RemoteBundleAssets/rabbit/base/rabbit_back.json',
      'kr-remote-bundles/Editor/RemoteBundleAssets/rabbit/base/rabbit_front.json',
      'kr-remote-bundles/Editor/RemoteBundleAssets/rabbit/base/rabbit_side.json',
      'kr-remote-bundles/Editor/RemoteBundleAssets/ring/ring.json',
    ]);
  });
});

describe('view grouping and names', () => {
  it('names views after the shared prefix', () => {
    expect(viewNames(['rabbit_front.json', 'rabbit_side.json', 'rabbit_back.json'])).toEqual(['front', 'side', 'back']);
    expect(rigName(['rabbit_front.json', 'rabbit_side.json'], 'base')).toBe('rabbit');
    expect(rigName(['ring.json'], 'ring')).toBe('ring');
    expect(rigName(['a.json', 'b.json'], 'base')).toBe('base');
  });

  it.each([false, true])('groups rabbit_front/side/back into one rig (shared images: %s)', async (sharedImages) => {
    const root = krRepo({ sharedImages });
    const { pngs, found } = await scan(root);
    const rigs = detectRigs(found.skeletons, pngs, root);
    const rabbit = rigs.find((r) => r.name === 'rabbit')!;
    expect(rabbit.views.map((v) => v.name)).toEqual(['front', 'side', 'back']);
  });

  it('keeps unrelated skeletons in one folder apart', () => {
    const mk = (abs: string, images: string[]): SkeletonFile => ({ abs, rel: abs, sha256: 'x', size: 2, spineVersion: '4.3.1', images });
    const pngs: SyncedPng[] = [
      ...['bat_wing', 'bat_body'].map((name) => ({ folder: ['enemies', 'bat'], folderNames: ['Enemies', 'bat'], name })),
      ...['slime_body', 'slime_eye'].map((name) => ({ folder: ['enemies', 'slime'], folderNames: ['Enemies', 'slime'], name })),
    ];
    const rigs = detectRigs([mk('/x/enemy_bat.json', ['bat_wing', 'bat_body']), mk('/x/enemy_slime.json', ['slime_body', 'slime_eye'])], pngs, '/');
    expect(rigs.map((r) => [r.name, r.folderPath.join('/')])).toEqual([
      ['enemy_bat', 'enemies/bat'],
      ['enemy_slime', 'enemies/slime'],
    ]);
  });
});

describe('a big game', () => {
  it('finds the rabbit among hundreds of exports and ignores look-alikes', async () => {
    const root = krRepo();
    const kr = join(root, 'kr-remote-bundles');
    // Hundreds of other exports sorted after the rabbit's, like KR's skins.
    for (let i = 0; i < 260; i++) put(join(kr, 'Editor', 'RemoteBundleAssets', `zz${i}`, `zz${i}.json`), JSON.stringify(skeleton([`zz${i}_a`])));
    // A props folder: unrelated exports side by side, and a goat drawn from the rabbit's parts.
    const props = join(kr, 'Runtime', 'Resources', 'Spine');
    for (const view of ['front', 'side', 'back']) put(join(props, `goat_${view}.json`), JSON.stringify(skeleton(viewParts(view))));
    put(join(props, 'carrot.json'), JSON.stringify(skeleton(['head_front', 'carrot'])));
    put(join(props, 'glyph_bug.json'), JSON.stringify(skeleton(['bug'])));
    const { pngs, found } = await scan(root);
    expect(found.skeletons.length).toBeGreaterThan(260);
    const rigs = detectRigs(found.skeletons, pngs, root);
    const onRabbit = rigs.filter((r) => r.folderPath.join('/') === 'spineraw/rabbit');
    expect(onRabbit.map((r) => [r.name, r.views.map((v) => v.name)])).toEqual([['rabbit', ['front', 'side', 'back']]]);
  });
});

describe('folder matching', () => {
  it('binds the rabbit to rabbit/ with rabbit-pixel/ as fallback, the ring to its one skin', async () => {
    const root = krRepo();
    const { pngs, found } = await scan(root);
    const rigs = detectRigs(found.skeletons, pngs, root);
    expect(rigs.map((r) => r.name)).toEqual(['bow', 'rabbit', 'ring']);
    const rabbit = rigs.find((r) => r.name === 'rabbit')!;
    expect(rabbit.folderPath).toEqual(['spineraw', 'rabbit']);
    expect(rabbit.skins).toBe(4); // spider, agni, poseidon, mini
    expect(rabbit.baseFolderPath).toEqual(['spineraw', 'rabbit-pixel']);
    expect(describeRig(rabbit)).toBe('Spine rig rabbit (front, side, back) → rabbit/ (4 skins), parts fallback rabbit-pixel/');

    const ring = rigs.find((r) => r.name === 'ring')!;
    expect(ring.folderPath).toEqual(['spineraw', 'ring', 'gold']);
    expect(ring.baseFolderPath).toBeNull();
    expect(describeRig(ring)).toBe('Spine rig ring → gold/');
  });

  it('uses the same folder segments push sends for a PNG in that folder', async () => {
    const root = krRepo();
    const { index } = await scan(root);
    const spider = index.files.find((f) => f.sourceRel === 'kr-remote-bundles/.SpineRaw/rabbit/spider/head_front.png')!;
    // push `path` = [...folders, doc, artboard]
    expect(spider.key).toBe('spineraw/rabbit/spider/head-front/head-front');
    expect(syncedPngsFromEntries([spider])[0]).toEqual({
      folder: ['spineraw', 'rabbit', 'spider'],
      folderNames: ['.SpineRaw', 'rabbit', 'spider'],
      name: 'head_front',
    });
  });

  it('skips rigs whose images no synced folder holds', () => {
    const s: SkeletonFile = { abs: '/x/hero.json', rel: 'hero.json', sha256: 'x', size: 2, spineVersion: '4.3.1', images: ['cape'] };
    expect(detectRigs([s], [{ folder: ['ui'], folderNames: ['UI'], name: 'logo' }], '/')).toEqual([]);
  });

  it('binds to the best single folder when skins do not share a parent', () => {
    const s: SkeletonFile = { abs: '/x/hero.json', rel: 'hero.json', sha256: 'x', size: 2, spineVersion: '4.3.1', images: ['a', 'b', 'c', 'd'] };
    const pngs: SyncedPng[] = [
      ...['a', 'b', 'c', 'd'].map((name) => ({ folder: ['chars', 'hero'], folderNames: ['Chars', 'Hero'], name })),
      ...['a', 'b', 'x'].map((name) => ({ folder: ['misc'], folderNames: ['Misc'], name })),
    ];
    const [rig] = detectRigs([s], pngs, '/');
    expect(rig.folderPath).toEqual(['chars', 'hero']);
    expect(rig.skins).toBe(1);
    // misc/ is outside the bound folder and holds half the images → fallback.
    expect(rig.baseFolderPath).toEqual(['misc']);
  });
});

describe('upload and hash skipping', () => {
  let root: string;
  const cwd0 = process.cwd();
  beforeEach(() => {
    root = krRepo();
    process.chdir(root);
    __resetSpineWarnedForTesting();
  });
  afterEach(() => process.chdir(cwd0));

  const okUpload = () => vi.fn(async (rigs: PushSpineRig[]): Promise<SpineRigResult[]> => rigs.map((r) => ({ name: r.name, status: 'saved' })));

  it('uploads changed rigs once and remembers their hash', async () => {
    const upload = okUpload();
    const first = await runSpineRigs({ config, cwd: root, upload });
    expect(first.rigs.map((o) => [o.rig.name, o.status])).toEqual([
      ['bow', 'unsupported'],
      ['rabbit', 'saved'],
      ['ring', 'saved'],
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
    const sent = upload.mock.calls[0][0];
    expect(sent.map((r) => r.name)).toEqual(['rabbit', 'ring']);
    expect(sent[0]).toMatchObject({ folderPath: ['spineraw', 'rabbit'], baseFolderPath: ['spineraw', 'rabbit-pixel'] });
    expect(sent[0].views.map((v) => v.name)).toEqual(['front', 'side', 'back']);
    expect((sent[0].views[0].json as { skeleton: { spine: string } }).skeleton.spine).toBe('4.3.23');
    expect(sent[0].hash).toMatch(/^[a-f0-9]{64}$/);

    const state = JSON.parse(readFileSync(join(root, '.magicpixel', 'state.json'), 'utf8'));
    expect(Object.keys(state.spineRigs).sort()).toEqual(['spineraw/rabbit', 'spineraw/ring/gold']);

    const second = await runSpineRigs({ config, cwd: root, upload });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(second.rigs.find((o) => o.rig.name === 'rabbit')?.status).toBe('up-to-date');

    // Editing a skeleton changes the hash → only that rig is sent again.
    const front = join(root, 'kr-remote-bundles', 'Editor', 'RemoteBundleAssets', 'rabbit', 'base', 'rabbit_front.json');
    writeFileSync(front, JSON.stringify({ ...skeleton([...viewParts('front'), 'shadow']), animations: { run: {}, jump: {} } }));
    await runSpineRigs({ config, cwd: root, upload });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0].map((r) => r.name)).toEqual(['rabbit']);
  });

  it('does not remember rigs the server could not attach', async () => {
    const upload = vi.fn(async (rigs: PushSpineRig[]): Promise<SpineRigResult[]> => rigs.map((r) => ({ name: r.name, status: 'missing-folder' })));
    await runSpineRigs({ config, cwd: root, upload });
    await runSpineRigs({ config, cwd: root, upload });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('dry run sends nothing', async () => {
    const upload = okUpload();
    const r = await runSpineRigs({ config, cwd: root, upload, dryRun: true });
    expect(upload).not.toHaveBeenCalled();
    expect(r.rigs.find((o) => o.rig.name === 'rabbit')?.status).toBe('dry-run');
  });

  it('rigsToUpload compares per bound folder', () => {
    const rig = { folderPath: ['a', 'b'], hash: 'h1' } as never;
    expect(rigsToUpload([rig], { 'a/b': 'h1' })).toEqual([]);
    expect(rigsToUpload([rig], { 'a/b': 'h0' })).toEqual([rig]);
    expect(rigsToUpload([rig], undefined)).toEqual([rig]);
  });

  it('batches at most 10 rigs per request', () => {
    const rigs = Array.from({ length: 23 }, (_, i) => ({ name: `r${i}`, views: [{ file: { size: 1 } }] })) as never[];
    expect(batchRigs(rigs).map((b) => b.length)).toEqual([10, 10, 3]);
    expect(batchRigs(rigs, 2).map((b) => b.length)).toEqual(Array(12).fill(2).slice(0, 11).concat([1]));
  });

  it('a failing upload never fails the sync and warns once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const failing = vi.fn(async () => { throw new Error('network down'); });
      // A failed request marks its rigs as errors (nothing remembered)…
      const r = await runSpineRigs({ config, cwd: root, upload: failing });
      expect(r.rigs.find((o) => o.rig.name === 'rabbit')).toMatchObject({ status: 'error', error: 'network down' });
      // …and the sync hook swallows anything thrown, warning once per process.
      const run = vi.fn(async () => { throw new Error('boom\nsecond line'); });
      expect(await syncSpineRigsQuietly({ config, verbose: true, quiet: false, run })).toBeNull();
      expect(await syncSpineRigsQuietly({ config, verbose: true, quiet: false, run })).toBeNull();
      const warnings = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("couldn't upload Spine rigs"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('boom');
      expect(warnings[0]).not.toContain('second line');
    } finally {
      log.mockRestore();
    }
  });
});
