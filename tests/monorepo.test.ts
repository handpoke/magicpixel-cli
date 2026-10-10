import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { indexGamePngs, matchConnectGlobs } from '../src/util/gameScan.js';
import { detectWorkspaceMembers, findWorkspaceRoot, resolveInvokedPath } from '../src/util/workspace.js';
import { resolveSyncScope, keyInScope } from '../src/util/syncScope.js';
import { parseFolderArg } from '../src/commands/resync.js';
import { readCredentialsSync, writeCredentials } from '../src/util/credentials.js';
import { consolidateCommand, mergeSetups } from '../src/commands/consolidate.js';
import { explainSprite } from '../src/commands/why.js';
import { placeBesideSiblings } from '../src/util/strayGuard.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c63f8cfc0f01f0005000201a5b1d8d50000000049454e44ae426082',
  'hex',
);

function put(path: string, body: string | Buffer = PNG): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** kr-unity-monorepo in miniature: a UPM package + a Unity project with .SpineRaw. */
function monorepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'mp-ws-'));
  // kr-core: package (Runtime + root .meta)
  put(join(root, 'kr-core', 'Runtime.meta'), 'meta');
  put(join(root, 'kr-core', 'Runtime', 'Sprites', 'decorations', 'cactus.png'));
  put(join(root, 'kr-core', 'Runtime', 'Sprites', 'decorations', 'statue_rabbit.png'));
  // kr-remote-bundles: Unity project with Assets/ + hidden .SpineRaw
  put(join(root, 'kr-remote-bundles', 'Assets', 'x.meta'), 'meta');
  put(join(root, 'kr-remote-bundles', 'Assets', 'Bundles', 'logo.png'));
  put(join(root, 'kr-remote-bundles', '.SpineRaw', 'rabbit', 'body', 'head.png'));
  put(join(root, 'kr-remote-bundles', '.SpineRaw', 'rabbit_nft', 'poseidon', 'body.png'));
  put(join(root, 'kr-remote-bundles', 'Assets', 'Deep', '.Hidden', 'gem.png'));
  put(join(root, 'kr-remote-bundles', '.git', 'x.png'));
  put(join(root, 'kr-remote-bundles', 'Library', 'cache.png'));
  // not a game folder
  put(join(root, 'docs', 'readme.md'), '#');
  return root;
}

const cwd0 = process.cwd();
afterEach(() => process.chdir(cwd0));

describe('monorepo workspace', () => {
  it('finds the game folders and keeps the per-folder sprite names', async () => {
    const root = monorepo();
    expect(detectWorkspaceMembers(root)).toEqual(['kr-core', 'kr-remote-bundles']);
    const alone = await indexGamePngs('Unity', join(root, 'kr-core'), '');
    writeFileSync(join(root, 'magicpixel.json'), JSON.stringify({ workspace: true, members: ['kr-core', 'kr-remote-bundles'] }));
    const ws = await indexGamePngs('Unity', root, '');
    const cactus = ws.files.find((f) => f.sourceRel === 'kr-core/Runtime/Sprites/decorations/cactus.png');
    expect(cactus?.key).toBe(alone.files.find((f) => f.sourceRel === 'Runtime/Sprites/decorations/cactus.png')?.key);
  });

  it('scans hidden folders at any depth but never .git or Library', async () => {
    const root = monorepo();
    writeFileSync(join(root, 'magicpixel.json'), JSON.stringify({ workspace: true, members: ['kr-remote-bundles'] }));
    const rels = (await indexGamePngs('Unity', root, '')).files.map((f) => f.sourceRel);
    expect(rels).toContain('kr-remote-bundles/.SpineRaw/rabbit/body/head.png');
    expect(rels).toContain('kr-remote-bundles/Assets/Deep/.Hidden/gem.png');
    expect(rels.some((r) => r.includes('.git/') || r.includes('Library/'))).toBe(false);
  });

  it('keeps rabbit_nft excluded and uploads .SpineRaw/rabbit after the merge', async () => {
    const root = monorepo();
    const merged = mergeSetups(['kr-core', 'kr-remote-bundles'], [
      { member: 'kr-core', config: { connect: ['**'], outDir: 'Assets/MagicPixel' }, state: {} },
      { member: 'kr-remote-bundles', config: { connect: ['**'], exclude: ['**/rabbit_nft/**'] }, state: {} },
    ]);
    expect(merged.config.exclude).toEqual(['kr-remote-bundles/**/rabbit_nft/**']);
    writeFileSync(join(root, 'magicpixel.json'), JSON.stringify(merged.config));
    const index = await indexGamePngs('Unity', root, merged.config.outDir);
    const rels = matchConnectGlobs(index, merged.config.connect, merged.config.exclude).entries.map((e) => e.sourceRel);
    expect(rels).toContain('kr-remote-bundles/.SpineRaw/rabbit/body/head.png');
    expect(rels.some((r) => r.includes('rabbit_nft'))).toBe(false);
  });

  it('keeps already-synced files unchanged (no mass re-upload)', async () => {
    const root = monorepo();
    const alone = await indexGamePngs('Unity', join(root, 'kr-core'), '');
    const cactus = alone.files.find((f) => f.sourceRel.endsWith('cactus.png'))!;
    const sha = createHash('sha256').update(PNG).digest('hex');
    const merged = mergeSetups(['kr-core'], [{
      member: 'kr-core',
      config: { connect: ['**'] },
      state: { synced: { [cactus.key]: { assetId: 'a', layerIdx: 0, sha256: 'c', diskSha256: sha, sourceRel: cactus.sourceRel } } },
    }]);
    expect(merged.state.synced?.[cactus.key]?.sourceRel).toBe(`kr-core/${cactus.sourceRel}`);
    writeFileSync(join(root, 'magicpixel.json'), JSON.stringify(merged.config));
    const entry = (await indexGamePngs('Unity', root, '')).files.find((f) => f.key === cactus.key)!;
    expect(explainSprite(entry, merged.config, merged.state.synced!, sha).kind).toBe('unchanged');
  });

  it('refuses to merge folders linked to different MagicPixel projects', () => {
    expect(() => mergeSetups(['a', 'b'], [
      { member: 'a', config: {}, state: { projectId: 'p1' } },
      { member: 'b', config: {}, state: { projectId: 'p2' } },
    ])).toThrow(/different MagicPixel projects/);
  });

  it('finds the root setup from inside a game folder', () => {
    const root = monorepo();
    writeFileSync(join(root, 'magicpixel.json'), JSON.stringify({ workspace: true, members: ['kr-core'] }));
    expect(findWorkspaceRoot(join(root, 'kr-core', 'Runtime'))).toBe(root);
    expect(findWorkspaceRoot(root)).toBeNull();
  });

  it('merges old setups, backs them up, deletes stray copies and never touches game PNGs', async () => {
    const root = monorepo();
    for (const m of ['kr-core', 'kr-remote-bundles']) {
      put(join(root, m, 'magicpixel.json'), JSON.stringify({ outDir: 'Assets/MagicPixel', connect: ['**'] }));
      put(join(root, m, '.magicpixel', 'state.json'), JSON.stringify({ projectId: 'p1', synced: {} }));
    }
    // A stray copy of kr-core's cactus written into kr-remote-bundles' outDir.
    const coreKey = (await indexGamePngs('Unity', join(root, 'kr-core'), '')).files.find((f) => f.sourceRel.endsWith('cactus.png'))!.key;
    const stray = join(root, 'kr-remote-bundles', 'Assets', 'MagicPixel', `${coreKey}.png`);
    put(stray);
    put(`${stray}.meta`, 'meta');
    process.chdir(root);
    expect(await consolidateCommand({ yes: true })).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, 'magicpixel.json'), 'utf8'));
    expect(cfg.workspace).toBe(true);
    expect(existsSync(join(root, 'kr-core', 'magicpixel.json'))).toBe(false);
    expect(existsSync(join(root, 'kr-remote-bundles', '.magicpixel'))).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(join(root, 'kr-core', 'Runtime', 'Sprites', 'decorations', 'cactus.png'))).toBe(true);
    expect(existsSync(join(root, 'kr-remote-bundles', '.SpineRaw', 'rabbit', 'body', 'head.png'))).toBe(true);
    const backups = readdirSync(join(root, '.magicpixel', 'backup'));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(root, '.magicpixel', 'backup', backups[0]!, 'kr-core', 'magicpixel.json'))).toBe(true);
    // Running it again changes nothing and makes no second backup.
    expect(await consolidateCommand({ yes: true })).toBe(false);
    expect(readdirSync(join(root, '.magicpixel', 'backup'))).toHaveLength(1);
  });

  it('keeps the root login and your own files in old output folders', async () => {
    const root = monorepo();
    for (const m of ['kr-core', 'kr-remote-bundles']) {
      put(join(root, m, 'magicpixel.json'), JSON.stringify({ outDir: 'Assets/MagicPixel', connect: ['**'] }));
      put(join(root, m, '.magicpixel', 'state.json'), JSON.stringify({ projectId: 'p1', synced: {} }));
    }
    await writeCredentials('mp_root_key', root);
    await writeCredentials('mp_child_key', join(root, 'kr-core'));
    const mine = join(root, 'kr-remote-bundles', 'Assets', 'MagicPixel', 'notes', 'mine.txt');
    put(mine, 'keep me');
    put(join(root, 'kr-remote-bundles', 'Assets', 'MagicPixel', 'empty', 'gone.png.meta'), 'meta');
    process.chdir(root);
    expect(await consolidateCommand({ yes: true })).toBe(true);
    expect(readCredentialsSync(root)?.apiKey).toBe('mp_root_key');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.magicpixel');
    expect(readFileSync(mine, 'utf8')).toBe('keep me');
    expect(existsSync(join(root, 'kr-remote-bundles', 'Assets', 'MagicPixel', 'empty'))).toBe(false);
  });

  it('reads folder names typed inside a game folder against the root setup', () => {
    const root = monorepo();
    writeFileSync(join(root, 'magicpixel.json'), JSON.stringify({ workspace: true, members: ['kr-core', 'kr-remote-bundles'] }));
    process.chdir(root);
    process.env.MAGICPIXEL_INVOKED_FROM = join(root, 'kr-core');
    try {
      expect(resolveInvokedPath('Runtime')).toBe('kr-core/Runtime');
      expect(resolveInvokedPath('Runtime/**')).toBe('kr-core/Runtime/**');
    } finally {
      delete process.env.MAGICPIXEL_INVOKED_FROM;
    }
    // MagicPixel-only files (no local path) match by library folder, without the game-folder name.
    expect(parseFolderArg('kr-core/Runtime/Sprites')).toEqual(['runtime', 'sprites']);
    const scope = resolveSyncScope(['kr-core/Runtime'])!;
    expect(keyInScope(scope, 'runtime/doc/art')).toBe(true);
    expect(keyInScope(scope, 'other/doc/art')).toBe(false);
    expect(keyInScope(scope, 'runtime/doc/art', 'kr-remote-bundles/Runtime/doc.png')).toBe(false);
  });
});

describe('new art beside its siblings', () => {
  it('writes a new variant next to its sibling, in the sibling naming style', () => {
    const map = new Map([['runtime/deco/statue-rabbit/statue-rabbit', 'kr-core/Runtime/deco/statue_rabbit.png']]);
    placeBesideSiblings(map, [{ key: 'runtime/deco/statue-rabbit-gold/statue-rabbit-gold', game: true }], new Set());
    expect(map.get('runtime/deco/statue-rabbit-gold/statue-rabbit-gold')).toBe('kr-core/Runtime/deco/statue_rabbit_gold.png');
  });

  it('never claims a path another game file already uses', () => {
    const map = new Map([['a/deco/x/x', 'g/deco/x.png']]);
    placeBesideSiblings(map, [{ key: 'a/deco/y/y', game: true }], new Set(['g/deco/y.png']));
    expect(map.has('a/deco/y/y')).toBe(false);
  });
});
