/**
 * Anonymous Product Telemetry v1 — daily identity + snapshot contract tests
 * (PRI-598).
 *
 * Locks the privacy invariants:
 * - same secret + same UTC date → identical ID (same-day dedup correctness);
 * - same secret + different dates → different, unlinkable IDs;
 * - strict schema validation rejects unknown fields, wrong types, bad dates;
 * - privacy guard rejects content-bearing field names;
 * - the built snapshot never contains the secret.
 */

import { describe, expect, it } from 'vitest';
import {
  bucketDateFromTime,
  deriveDailyTelemetryId,
  generateTelemetrySecretHex,
  isValidBucketDate,
  isValidDailyTelemetryId,
  isValidTelemetrySecretHex,
} from '../product-telemetry/daily-identity.js';
import {
  assertTelemetrySchemaPrivacy,
  buildProductTelemetrySnapshot,
  PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS,
  PROHIBITED_TELEMETRY_FIELD_TOKENS,
  validateProductTelemetrySnapshot,
} from '../product-telemetry/snapshot-contract.js';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

describe('daily telemetry identity', () => {
  it('is deterministic for the same secret and date', () => {
    expect(deriveDailyTelemetryId(SECRET, '2026-08-26')).toBe(deriveDailyTelemetryId(SECRET, '2026-08-26'));
  });

  it('derives different IDs for different dates under the same secret (cross-day unlinkability)', () => {
    const day1 = deriveDailyTelemetryId(SECRET, '2026-08-26');
    const day2 = deriveDailyTelemetryId(SECRET, '2026-08-27');
    const day3 = deriveDailyTelemetryId(SECRET, '2026-08-28');
    expect(new Set([day1, day2, day3]).size).toBe(3);
    // No structural cross-day correlation is exposed: fixed-length hex only.
    expect(day1).toMatch(/^[0-9a-f]{32}$/);
    expect(day2).toMatch(/^[0-9a-f]{32}$/);
  });

  it('derives different IDs for different secrets on the same date', () => {
    expect(deriveDailyTelemetryId(SECRET, '2026-08-26')).not.toBe(deriveDailyTelemetryId(OTHER_SECRET, '2026-08-26'));
  });

  it('generates cryptographically random, structurally valid secrets', () => {
    const a = generateTelemetrySecretHex();
    const b = generateTelemetrySecretHex();
    expect(isValidTelemetrySecretHex(a)).toBe(true);
    expect(isValidTelemetrySecretHex(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(isValidTelemetrySecretHex('short')).toBe(false);
    expect(isValidTelemetrySecretHex('X'.repeat(64))).toBe(false);
  });

  it('buckets by UTC date regardless of local timezone', () => {
    // 2026-08-26T23:30Z is already 2026-08-27 in UTC+1 — bucket must stay UTC.
    expect(bucketDateFromTime(Date.parse('2026-08-26T23:30:00.000Z'))).toBe('2026-08-26');
    expect(bucketDateFromTime(Date.parse('2026-08-27T00:30:00.000Z'))).toBe('2026-08-27');
  });

  it('validates bucket dates and daily IDs strictly', () => {
    expect(isValidBucketDate('2026-08-26')).toBe(true);
    expect(isValidBucketDate('2026-8-6')).toBe(false);
    expect(isValidBucketDate('2026-13-01')).toBe(false);
    expect(isValidBucketDate('2026-02-30')).toBe(false); // rejected via round-trip
    expect(isValidBucketDate(20260826)).toBe(false);
    expect(isValidDailyTelemetryId(deriveDailyTelemetryId(SECRET, '2026-08-26'))).toBe(true);
    expect(isValidDailyTelemetryId('ABC')).toBe(false);
    expect(isValidDailyTelemetryId('Z'.repeat(32))).toBe(false);
  });
});

/**
 * Build a valid snapshot, then shallow-apply (possibly invalid) overrides.
 * The result is passed to validateProductTelemetrySnapshot(raw: unknown) —
 * intentionally invalid fixtures stay unknown-typed, no casts needed.
 */
function snapshotWith(overrides: Record<string, unknown> = {}): unknown {
  const base: Record<string, unknown> = {
    schemaVersion: '1',
    dailyTelemetryId: deriveDailyTelemetryId(SECRET, '2026-08-26'),
    bucketDate: '2026-08-26',
    pdVersion: '1.218.0',
    hostKind: 'openclaw',
    milestones: {
      initialized: true,
      painObserved: true,
      principleObserved: true,
      activationObserved: false,
      presenceReceiptObserved: true,
      effectReceiptObserved: false,
    },
    reliability: { initializationFailed: false },
    consentVersion: '1',
  };
  return { ...base, ...overrides };
}

describe('snapshot contract validation', () => {
  it('accepts a valid snapshot', () => {
    const result = validateProductTelemetrySnapshot(snapshotWith());
    expect(result.ok).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    const result = validateProductTelemetrySnapshot(snapshotWith({ extra: 'x' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('unknown top-level field');
  });

  it('rejects unknown nested milestone fields', () => {
    const result = validateProductTelemetrySnapshot(
      snapshotWith({
        milestones: {
          initialized: true,
          painObserved: true,
          principleObserved: true,
          activationObserved: false,
          presenceReceiptObserved: true,
          effectReceiptObserved: false,
          painText: 'secret pain',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("unknown milestones field 'painText'");
  });

  it('rejects unsupported schema versions', () => {
    const result = validateProductTelemetrySnapshot(snapshotWith({ schemaVersion: '2' }));
    expect(result.ok).toBe(false);
  });

  it('rejects wrong-typed and malformed fields', () => {
    expect(validateProductTelemetrySnapshot(snapshotWith({ dailyTelemetryId: 'nope' })).ok).toBe(false);
    expect(validateProductTelemetrySnapshot(snapshotWith({ bucketDate: '2026/08/26' })).ok).toBe(false);
    expect(validateProductTelemetrySnapshot(snapshotWith({ hostKind: 'windows' })).ok).toBe(false);
    expect(validateProductTelemetrySnapshot(snapshotWith({ pdVersion: 'x'.repeat(64) })).ok).toBe(false);
    expect(
      validateProductTelemetrySnapshot(
        snapshotWith({
          milestones: {
            initialized: 'yes',
            painObserved: true,
            principleObserved: true,
            activationObserved: false,
            presenceReceiptObserved: true,
            effectReceiptObserved: false,
          },
        }),
      ).ok,
    ).toBe(false);
    expect(validateProductTelemetrySnapshot(null).ok).toBe(false);
    expect(validateProductTelemetrySnapshot('snapshot').ok).toBe(false);
    expect(validateProductTelemetrySnapshot([snapshotWith()]).ok).toBe(false);
  });

  it('builds a valid snapshot from milestone inputs and fails loud on invalid input', () => {
    const snapshot = buildProductTelemetrySnapshot({
      dailyTelemetryId: deriveDailyTelemetryId(SECRET, '2026-08-26'),
      bucketDate: '2026-08-26',
      pdVersion: '1.218.0',
      hostKind: 'codex',
      milestones: {
        initialized: true,
        painObserved: false,
        principleObserved: false,
        activationObserved: false,
        presenceReceiptObserved: false,
        effectReceiptObserved: false,
      },
      reliability: { initializationFailed: false },
    });
    expect(validateProductTelemetrySnapshot(snapshot).ok).toBe(true);
    expect(() =>
      buildProductTelemetrySnapshot({
        dailyTelemetryId: 'bad',
        bucketDate: '2026-08-26',
        pdVersion: '1.0.0',
        hostKind: 'openclaw',
        milestones: {
          initialized: true,
          painObserved: false,
          principleObserved: false,
          activationObserved: false,
          presenceReceiptObserved: false,
          effectReceiptObserved: false,
        },
        reliability: { initializationFailed: false },
      }),
    ).toThrow(/Invalid product telemetry snapshot/);
  });
});

describe('telemetry privacy guard', () => {
  it('passes the real schema field names (all levels)', () => {
    const allFields = [
      ...PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS,
      'initialized',
      'painObserved',
      'principleObserved',
      'activationObserved',
      'presenceReceiptObserved',
      'effectReceiptObserved',
      'initializationFailed',
    ];
    expect(() => assertTelemetrySchemaPrivacy(allFields)).not.toThrow();
  });

  it('rejects field names carrying prohibited concepts', () => {
    for (const token of ['repoName', 'filePath', 'errorMessage', 'toolOutput', 'userEmail']) {
      expect(() => assertTelemetrySchemaPrivacy([token])).toThrow(/privacy guard violated/);
    }
    // Every guard token must actually bite on a matching field name.
    for (const token of PROHIBITED_TELEMETRY_FIELD_TOKENS) {
      expect(() => assertTelemetrySchemaPrivacy([`example${token.charAt(0).toUpperCase()}${token.slice(1)}`])).toThrow();
    }
  });

  it('never includes the telemetry secret in the serialized snapshot', () => {
    const snapshot = buildProductTelemetrySnapshot({
      dailyTelemetryId: deriveDailyTelemetryId(SECRET, '2026-08-26'),
      bucketDate: '2026-08-26',
      pdVersion: '1.218.0',
      hostKind: 'other',
      milestones: {
        initialized: true,
        painObserved: true,
        principleObserved: true,
        activationObserved: true,
        presenceReceiptObserved: true,
        effectReceiptObserved: true,
      },
      reliability: { initializationFailed: false },
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });
});
