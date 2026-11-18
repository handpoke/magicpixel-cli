import { describe, expect, it } from 'vitest';
import { planPush } from '../src/util/pushPlan.js';
import { rememberRefusedDiskShas } from '../src/commands/push.js';
import type { SyncedSprite } from '../src/config.js';

const row = (extra: Partial<SyncedSprite> = {}): SyncedSprite => ({
  assetId: 'asset-1', layerIdx: 0, sha256: 'cloud', layers: 1, diskSha256: 'disk-old', ...extra,
});
const candidate = (sha: string) => ({ key: 'items/saw/skull', segments: ['items', 'saw', 'skull'], diskSha256: sha });

describe('refused sprites are not re-sent by sync', () => {
  it('remembers the refused disk bytes and the reason', () => {
    const synced: Record<string, SyncedSprite> = { 'items/saw/skull': row() };
    const changed = rememberRefusedDiskShas(
      synced,
      [{ key: 'items/saw/skull', status: 'conflict', reason: 'would-flatten' }],
      new Map([['items/saw/skull', 'disk-new']]),
    );
    expect(changed).toBe(true);
    expect(synced['items/saw/skull']).toMatchObject({ refusedDiskSha256: 'disk-new', refusedReason: 'would-flatten' });
    // Same answer again: nothing to save.
    expect(rememberRefusedDiskShas(
      synced,
      [{ key: 'items/saw/skull', status: 'conflict', reason: 'would-flatten' }],
      new Map([['items/saw/skull', 'disk-new']]),
    )).toBe(false);
  });

  it('a watcher tick holds the same bytes back, with the reason', () => {
    const synced = { 'items/saw/skull': row({ refusedDiskSha256: 'disk-new', refusedReason: 'cloud-changed' }) };
    expect(planPush([candidate('disk-new')], synced, { skipRefused: true })).toEqual([
      { kind: 'refused', key: 'items/saw/skull', reason: 'cloud-changed' },
    ]);
  });

  it('new bytes on disk are sent again', () => {
    const synced = { 'items/saw/skull': row({ refusedDiskSha256: 'disk-new' }) };
    expect(planPush([candidate('disk-newer')], synced, { skipRefused: true })[0].kind).toBe('update');
  });

  it('an explicit push and a folder resync still send them', () => {
    const synced = { 'items/saw/skull': row({ refusedDiskSha256: 'disk-new' }) };
    expect(planPush([candidate('disk-new')], synced)[0].kind).toBe('update');
    expect(planPush([candidate('disk-new')], synced, { skipRefused: true, replace: true })[0].kind).toBe('update');
  });
});

import { watchIdleLine, watchUnchangedLine } from '../src/commands/sync.js';

describe('watch lines', () => {
  it('never says "0 up to date"', () => {
    expect(watchIdleLine(0)).toBe('Watching · all in sync');
    expect(watchIdleLine(3)).toBe('Watching · all in sync (3 up to date)');
  });
  it('names the sprites a pull found already in the game', () => {
    expect(watchUnchangedLine(3)).toBe('= 3 already up to date in your game');
  });
});
