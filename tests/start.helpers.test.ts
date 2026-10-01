import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/util/auth.js', () => ({ assertKeyValid: vi.fn() }));
import { assertKeyValid } from '../src/util/auth.js';
import { ApiError } from '../src/api.js';
import { checkKey, folderToGlob, shouldAskFolder } from '../src/commands/start.js';

const cfg = {} as never;
describe('start helpers', () => {
  it('maps 401/403 to rejected', async () => {
    vi.mocked(assertKeyValid).mockRejectedValueOnce(new ApiError(401, 'x', 'r'));
    expect(await checkKey('k', cfg)).toBe('rejected');
    vi.mocked(assertKeyValid).mockResolvedValueOnce();
    expect(await checkKey('k', cfg)).toBe('ok');
  });
  it('rethrows non-auth failures', async () => {
    vi.mocked(assertKeyValid).mockRejectedValueOnce(new ApiError(503, 'x', 'r'));
    await expect(checkKey('k', cfg)).rejects.toThrow();
  });
  it('turns folders into globs', () => {
    expect(folderToGlob('Sprites/Enemies/')).toBe('Sprites/Enemies/**');
    expect(folderToGlob('./A\\B')).toBe('A/B/**');
    expect(folderToGlob('A/*.png')).toBe('A/*.png');
  });
  it('asks only for interactive engine projects still syncing everything', () => {
    expect(shouldAskFolder(['**'], true, true)).toBe(true);
    expect(shouldAskFolder([], true, true)).toBe(true);
    expect(shouldAskFolder(['Sprites/**'], true, true)).toBe(false);
    expect(shouldAskFolder(['**'], false, true)).toBe(false);
    expect(shouldAskFolder(['**'], true, false)).toBe(false);
  });
});
