import { describe, expect, it } from 'vitest';
import { decidePull, type PullDecisionInput } from '../src/util/pullDecision.js';

const shouldPullEntry = (o: PullDecisionInput) => decidePull(o) === 'pull';

const cloud = 'c'.repeat(64);
const original = 'o'.repeat(64);
const edited = 'e'.repeat(64);

describe('shouldPullEntry', () => {
  it('skips when disk already matches the cloud composite', () => {
    expect(
      shouldPullEntry({ cloudSha256: cloud, localSha256: cloud, inWorkingSet: false }),
    ).toBe(false);
  });

  it('does not overwrite a connected original just because ingest re-encoded it', () => {
    expect(
      shouldPullEntry({
        cloudSha256: cloud,
        localSha256: original,
        previousCloudSha256: cloud,
        inWorkingSet: true,
      }),
    ).toBe(false);
  });

  it('pulls a connected sprite when MagicPixel changed the composite', () => {
    expect(
      shouldPullEntry({
        cloudSha256: edited,
        localSha256: original,
        previousCloudSha256: cloud,
        inWorkingSet: true,
      }),
    ).toBe(true);
  });

  it('pulls a connected sprite after an editor save clears the cached hash', () => {
    expect(
      shouldPullEntry({
        cloudSha256: null,
        localSha256: original,
        previousCloudSha256: cloud,
        inWorkingSet: true,
      }),
    ).toBe(true);
  });

  it('does not overwrite a connected original we have never pulled', () => {
    expect(
      shouldPullEntry({
        cloudSha256: cloud,
        localSha256: original,
        inWorkingSet: true,
      }),
    ).toBe(false);
  });

  it('keeps local MagicPixel-only edits when the cloud composite is unchanged', () => {
    expect(
      shouldPullEntry({
        cloudSha256: cloud,
        localSha256: original,
        previousCloudSha256: cloud,
        inWorkingSet: false,
      }),
    ).toBe(false);
  });

  it('still pulls MagicPixel-only art when the hash differs', () => {
    expect(
      shouldPullEntry({
        cloudSha256: edited,
        localSha256: cloud,
        previousCloudSha256: cloud,
        inWorkingSet: false,
      }),
    ).toBe(true);
  });

  it('restores a file that disappeared from disk even when the cloud hash is unchanged', () => {
    expect(
      shouldPullEntry({
        cloudSha256: cloud,
        localSha256: null,
        previousCloudSha256: cloud,
        inWorkingSet: true,
      }),
    ).toBe(true);
  });
});
