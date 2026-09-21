import { describe, it, expect } from 'vitest';
import { decidePull } from '../src/util/pullDecision.js';
import { shouldReconcile, RECONCILE_INTERVAL_MS } from '../src/util/reconcile.js';

const base = { inWorkingSet: false as boolean };

describe('decidePull conflicts', () => {
  it('reports a conflict when both disk and cloud changed since the last sync', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
      }),
    ).toBe('conflict');
  });

  it('pulls when only the cloud changed', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-old',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
      }),
    ).toBe('pull');
  });

  it('skips when the cloud composite is unchanged', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-old',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
      }),
    ).toBe('skip');
  });

  it('pulls a missing file even with a recorded baseline', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: null,
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
      }),
    ).toBe('pull');
  });

  it('conflicts on working-set originals too', () => {
    expect(
      decidePull({
        inWorkingSet: true,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
      }),
    ).toBe('conflict');
  });

  it('pulls a dual edit after a newer explicit artboard Sync press', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
        previousReleasedAt: '2026-09-21T10:00:00Z',
        releasedAt: '2026-09-21T10:01:00Z',
      }),
    ).toBe('pull');
  });

  it('does not re-consume an old release marker', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
        previousReleasedAt: '2026-09-21T10:01:00Z',
        releasedAt: '2026-09-21T10:01:00Z',
      }),
    ).toBe('conflict');
  });

  it('uses the release version when two presses share a timestamp', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
        previousReleasedAt: '2026-09-21T10:01:00Z',
        releasedAt: '2026-09-21T10:01:00Z',
        previousReleasedVersion: 7,
        releasedVersion: 8,
      }),
    ).toBe('pull');
  });

  it('uses lastSync once when upgrading state without per-sprite release markers', () => {
    expect(
      decidePull({
        ...base,
        cloudSha256: 'cloud-new',
        localSha256: 'disk-edited',
        previousCloudSha256: 'cloud-old',
        lastPushedDiskSha256: 'disk-old',
        lastSync: '2026-09-21T10:00:00Z',
        releasedAt: '2026-09-21T10:01:00Z',
      }),
    ).toBe('pull');
  });
});

describe('shouldReconcile', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  it('reconciles when never run', () => {
    expect(shouldReconcile(undefined, now)).toBe(true);
  });
  it('waits inside the interval', () => {
    expect(shouldReconcile(new Date(now - 60_000).toISOString(), now)).toBe(false);
  });
  it('reconciles past the interval', () => {
    expect(shouldReconcile(new Date(now - RECONCILE_INTERVAL_MS - 1).toISOString(), now)).toBe(true);
  });
  it('reconciles on a future/garbage timestamp', () => {
    expect(shouldReconcile(new Date(now + 60_000).toISOString(), now)).toBe(true);
    expect(shouldReconcile('not-a-date', now)).toBe(true);
  });
});
