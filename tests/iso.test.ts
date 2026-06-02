import { describe, expect, it } from 'vitest';
import { isStrictIso8601, maxIsoTimestamp, STRICT_ISO_8601_RE } from '../src/util/iso.js';

describe('STRICT_ISO_8601_RE', () => {
  it('accepts canonical Z timestamps', () => {
    expect(STRICT_ISO_8601_RE.test('2026-06-02T14:35:00Z')).toBe(true);
    expect(STRICT_ISO_8601_RE.test('2026-06-02T14:35:00.123Z')).toBe(true);
  });
  it('accepts offset timestamps', () => {
    expect(STRICT_ISO_8601_RE.test('2026-06-02T14:35:00+02:00')).toBe(true);
    expect(STRICT_ISO_8601_RE.test('2026-06-02T14:35:00.5-08:00')).toBe(true);
  });
  it('rejects loose Date.parse-compatible inputs that would corrupt cursor sorting', () => {
    // The whole point of the strict regex: these used to "work" via Date.parse
    // and would lex-sort BEFORE any real ISO string, silently rewinding lastSync.
    expect(STRICT_ISO_8601_RE.test('2024/06/01')).toBe(false);
    expect(STRICT_ISO_8601_RE.test('Sat, 02 Jun 2026 14:35:00 GMT')).toBe(false);
    expect(STRICT_ISO_8601_RE.test('2026-06-02 14:35:00')).toBe(false);
    expect(STRICT_ISO_8601_RE.test('2026-06-02T14:35:00')).toBe(false); // missing tz
    expect(STRICT_ISO_8601_RE.test('not-a-date')).toBe(false);
    expect(STRICT_ISO_8601_RE.test('')).toBe(false);
  });
});

describe('isStrictIso8601', () => {
  it('narrows non-string inputs to false', () => {
    expect(isStrictIso8601(null)).toBe(false);
    expect(isStrictIso8601(undefined)).toBe(false);
    expect(isStrictIso8601(123 as unknown)).toBe(false);
  });
});

describe('maxIsoTimestamp', () => {
  it('returns the lex-greatest valid entry', () => {
    expect(
      maxIsoTimestamp(['2026-01-01T00:00:00Z', '2026-06-02T14:35:00Z', '2026-03-15T12:00:00Z']),
    ).toBe('2026-06-02T14:35:00Z');
  });
  it('silently drops invalid entries (does not let them rewind the cursor)', () => {
    expect(
      maxIsoTimestamp(['2026-01-01T00:00:00Z', '2024/06/01', null, undefined, '', 'oops']),
    ).toBe('2026-01-01T00:00:00Z');
  });
  it('returns null when no entries are valid', () => {
    expect(maxIsoTimestamp(['oops', '2024/06/01', null])).toBeNull();
    expect(maxIsoTimestamp([])).toBeNull();
  });
});
