import { describe, expect, it } from 'vitest';

import { forcedRetrySprites, replaceResultsByKey, rememberRefusedCloudShas } from '../src/commands/push.js';
import type { PushResult, PushSprite } from '../src/api.js';
import type { SyncedSprite } from '../src/config.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const sprite = (over: Partial<PushSprite> = {}): PushSprite => ({
  key: 'props/rock',
  pngBase64: 'iVBOR',
  diskSha256: SHA_A,
  assetId: '11111111-1111-4111-8111-111111111111',
  layerIdx: 2,
  baseSha256: SHA_B,
  ...over,
});

const conflict = (over: Partial<PushResult> = {}): PushResult => ({
  key: 'props/rock',
  status: 'conflict',
  reason: 'cloud-changed',
  assetId: '11111111-1111-4111-8111-111111111111',
  layerIdx: 2,
  sha256: SHA_C,
  ...over,
});

describe('forcedRetrySprites', () => {
  const byKey = new Map([['props/rock', sprite()]]);

  it('re-sends a refused sprite with the live cloud sha as the baseline', () => {
    const out = forcedRetrySprites([conflict()], byKey, false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'props/rock', baseSha256: SHA_C, assetId: sprite().assetId, layerIdx: 2 });
  });

  it('re-sends a hash-less refusal as an update so the server reports one', () => {
    const out = forcedRetrySprites([conflict({ sha256: undefined })], byKey, false);
    expect(out[0]?.baseSha256).toBeNull();
  });

  it('turns an adopt-shaped refusal into an addressed update', () => {
    const adopt = new Map([
      ['props/rock', { key: 'props/rock', pngBase64: 'iVBOR', diskSha256: SHA_A, path: ['props', 'rock'] } as PushSprite],
    ]);
    const out = forcedRetrySprites([conflict({ layerIdx: 5 })], adopt, true);
    expect(out[0]).toMatchObject({ assetId: conflict().assetId, layerIdx: 5, baseSha256: SHA_C, flatten: true });
    expect(out[0]?.path).toBeUndefined();
  });

  it('does not retry the same baseline twice', () => {
    const out = forcedRetrySprites([conflict({ sha256: SHA_B })], byKey, false);
    expect(out).toEqual([]);
  });

  it('ignores other statuses, other reasons, and unaddressed refusals', () => {
    expect(forcedRetrySprites([{ key: 'props/rock', status: 'updated' }], byKey, false)).toEqual([]);
    expect(forcedRetrySprites([conflict({ reason: 'would-flatten' })], byKey, false)).toEqual([]);
    expect(forcedRetrySprites([conflict({ assetId: undefined })], byKey, false)).toEqual([]);
  });
});

describe('replaceResultsByKey', () => {
  it('overwrites the earlier outcome for a retried key', () => {
    const results: PushResult[] = [conflict(), { key: 'props/tree', status: 'updated' }];
    replaceResultsByKey(results, [{ key: 'props/rock', status: 'updated', sha256: SHA_C }]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ key: 'props/rock', status: 'updated' });
  });

  it('appends an outcome for a key that was not in the list', () => {
    const results: PushResult[] = [];
    replaceResultsByKey(results, [{ key: 'props/new', status: 'created' }]);
    expect(results).toHaveLength(1);
  });
});

describe('rememberRefusedCloudShas', () => {
  const known = (): Record<string, SyncedSprite> => ({
    'props/rock': { assetId: conflict().assetId!, layerIdx: 2, sha256: SHA_B, diskSha256: SHA_A },
  });

  it('records the live cloud sha as the pending baseline', () => {
    const synced = known();
    expect(rememberRefusedCloudShas(synced, [conflict()])).toBe(true);
    expect(synced['props/rock']?.pendingCloudSha256).toBe(SHA_C);
    // Untouched baselines: the divergence must stay visible to the next sync.
    expect(synced['props/rock']?.sha256).toBe(SHA_B);
  });

  it('is idempotent and ignores unknown keys or hash-less refusals', () => {
    const synced = known();
    rememberRefusedCloudShas(synced, [conflict()]);
    expect(rememberRefusedCloudShas(synced, [conflict()])).toBe(false);
    expect(rememberRefusedCloudShas({}, [conflict()])).toBe(false);
    expect(rememberRefusedCloudShas(known(), [conflict({ sha256: undefined })])).toBe(false);
  });
});
