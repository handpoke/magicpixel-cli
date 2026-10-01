import { describe, it, expect } from 'vitest';
import { resetStateIfProjectChanged, type SyncState } from '../src/config.js';

const rec = (): SyncState => ({ synced: { a: {} as never }, assets: { id: 'a' }, manifestEtags: { x: 'y' }, lastReconcile: 't' });

describe('resetStateIfProjectChanged', () => {
  it('resets when the project id differs', () => {
    const s = { ...rec(), projectId: 'old' };
    expect(resetStateIfProjectChanged(s, 'new', false)).toBe(true);
    expect(s.synced).toBeUndefined();
    expect(s.assets).toBeUndefined();
    expect(s.manifestEtags).toBeUndefined();
    expect(s.projectId).toBe('new');
  });
  it('keeps the record for the same project, even when empty', () => {
    const s = { ...rec(), projectId: 'p' };
    expect(resetStateIfProjectChanged(s, 'p', true)).toBe(false);
    expect(s.synced).toBeDefined();
  });
  it('treats a legacy record as stale against an empty project', () => {
    const s = rec();
    expect(resetStateIfProjectChanged(s, 'p', true)).toBe(true);
    expect(s.synced).toBeUndefined();
  });
  it('adopts the project id on a legacy record when the cloud has files', () => {
    const s = rec();
    expect(resetStateIfProjectChanged(s, 'p', false)).toBe(false);
    expect(s.synced).toBeDefined();
    expect(s.projectId).toBe('p');
  });
  it('does nothing without a project id', () => {
    const s = rec();
    expect(resetStateIfProjectChanged(s, null, true)).toBe(false);
    expect(s.projectId).toBeUndefined();
  });
});
