import { describe, expect, it } from 'vitest';
import { canSkipWithoutHashing } from '../src/util/pullDecision.js';

const cloud = 'c'.repeat(64);
const other = 'd'.repeat(64);
const at = '2026-09-21T10:00:00.000Z';
const later = '2026-09-21T10:05:00.000Z';

// The expensive part of a sync is per-file work: hashing the PNG on disk and,
// for rows the manifest has no hash for, one conditional download per file just
// to be told "304 Not Modified". Both are skippable when the row demonstrably
// did not change.
describe('canSkipWithoutHashing', () => {
  it('skips when the manifest still reports the recorded cloud hash', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: true,
        cloudSha256: cloud,
        previousCloudSha256: cloud,
      }),
    ).toBe(true);
  });

  it('does not skip when the cloud hash moved', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: true,
        cloudSha256: other,
        previousCloudSha256: cloud,
      }),
    ).toBe(false);
  });

  it('skips a hash-less row whose updated_at has not moved', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: true,
        cloudSha256: null,
        cloudUpdatedAt: at,
        previousCloudUpdatedAt: at,
      }),
    ).toBe(true);
  });

  it('checks a hash-less row whose updated_at advanced', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: true,
        cloudSha256: null,
        cloudUpdatedAt: later,
        previousCloudUpdatedAt: at,
      }),
    ).toBe(false);
  });

  it('checks a hash-less row we have never synced', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: true,
        cloudSha256: null,
        cloudUpdatedAt: at,
      }),
    ).toBe(false);
  });

  it('never skips when the file is missing on disk', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: false,
        cloudSha256: cloud,
        previousCloudSha256: cloud,
      }),
    ).toBe(false);
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: false,
        cloudSha256: null,
        cloudUpdatedAt: at,
        previousCloudUpdatedAt: at,
      }),
    ).toBe(false);
  });

  it('never skips a fresh explicit Sync release', () => {
    expect(
      canSkipWithoutHashing({
        freshRelease: true,
        fileExists: true,
        cloudSha256: cloud,
        previousCloudSha256: cloud,
      }),
    ).toBe(false);
    expect(
      canSkipWithoutHashing({
        freshRelease: true,
        fileExists: true,
        cloudSha256: null,
        cloudUpdatedAt: at,
        previousCloudUpdatedAt: at,
      }),
    ).toBe(false);
  });

  it('ignores a stale timestamp match when the manifest does carry a hash', () => {
    // A hash mismatch always wins: the timestamp shortcut is only for rows the
    // server could not fingerprint.
    expect(
      canSkipWithoutHashing({
        freshRelease: false,
        fileExists: true,
        cloudSha256: other,
        previousCloudSha256: cloud,
        cloudUpdatedAt: at,
        previousCloudUpdatedAt: at,
      }),
    ).toBe(false);
  });
});
