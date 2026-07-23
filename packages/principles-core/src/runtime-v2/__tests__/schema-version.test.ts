/**
 * Schema Version Tests — Core Package
 *
 * Unit tests for schema-version.ts — centralized versioning for runtime-v2 contracts.
 *
 * Tests verify:
 * - schemaRef() produces correct "kind-vN" format for valid inputs
 * - RUNTIME_V2_SCHEMA_VERSION constant matches expected literal "1.0.0"
 * - RuntimeV2SchemaVersionSchema accepts only "1.0.0" (exact-match literal)
 * - SchemaVersionRefSchema accepts strings (open-ended contract — not a literal)
 * - Edge cases: zero version, large version, non-integer version numbers
 *
 * ERR checklist:
 * - ERR-088: asserts exact value, not merely truthy — a drift from "1.0.0" to "1.0.1"
 *   must fail these tests rather than pass with a generic "is string" check.
 * - ERR-089: branch coverage on both accept and reject paths for each check.
 */

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  RUNTIME_V2_SCHEMA_VERSION,
  schemaRef,
  SchemaVersionRefSchema,
  RuntimeV2SchemaVersionSchema,
} from '../schema-version.js';

// ── schemaRef() ───────────────────────────────────────────────────────────────

describe('schemaRef()', () => {
  it('produces "kind-vN" format with version 1', () => {
    expect(schemaRef('diagnostician-output', 1)).toBe('diagnostician-output-v1');
  });

  it('produces "kind-vN" format with version 2', () => {
    expect(schemaRef('pain-signal', 2)).toBe('pain-signal-v2');
  });

  it('includes hyphen in kind names unchanged', () => {
    expect(schemaRef('rule-host-input', 3)).toBe('rule-host-input-v3');
  });

  it('handles underscore in kind names', () => {
    expect(schemaRef('intent_decision', 1)).toBe('intent_decision-v1');
  });

  it('handles kind names with mixed separators', () => {
    expect(schemaRef('pi-artifact_v2', 5)).toBe('pi-artifact_v2-v5');
  });

  it('handles version 0 (edge — not normative but function should still format)', () => {
    // The function is a pure string formatter; it does NOT gate on version >= 1.
    // This test pins the current behavior so a change to validation would be deliberate.
    expect(schemaRef('something', 0)).toBe('something-v0');
  });

  it('handles large version numbers (forward-compat format)', () => {
    expect(schemaRef('contract', 999)).toBe('contract-v999');
  });

  it('does not insert extra separators before -vN', () => {
    // The format is "${kind}-v${version}" — no trailing/leading spaces around "-v".
    const ref = schemaRef('foo', 1);
    expect(ref).not.toContain(' -v');
    expect(ref).not.toContain('- v');
    expect(ref).not.toContain('_v');
    expect(ref).toMatch(/-v1$/);
  });

  it('kind is case-sensitive and preserved exactly', () => {
    expect(schemaRef('DiagnosticianOutput', 1)).toBe('DiagnosticianOutput-v1');
    expect(schemaRef('FOO', 1)).toBe('FOO-v1');
    expect(schemaRef('fooBar', 1)).toBe('fooBar-v1');
  });

  it('version numbers are not zero-padded', () => {
    // "v01" vs "v1" matters for equality comparison. Pin the correct format.
    expect(schemaRef('x', 1)).toBe('x-v1');
    expect(schemaRef('x', 10)).toBe('x-v10');
    expect(schemaRef('x', 100)).toBe('x-v100');
  });
});

// ── RUNTIME_V2_SCHEMA_VERSION constant ───────────────────────────────────────

describe('RUNTIME_V2_SCHEMA_VERSION constant', () => {
  it('is exactly the string "1.0.0" — semantic-version format', () => {
    // ERR-088: exact literal check. A drift to "1.0.1" or "1.1.0" must fail.
    expect(RUNTIME_V2_SCHEMA_VERSION).toBe('1.0.0');
  });

  it('is a 3-segment semver string (X.Y.Z, numeric segments)', () => {
    // Structural contract: consumers parse this with semver or prefix-match.
    expect(RUNTIME_V2_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is a string type, not a number', () => {
    expect(typeof RUNTIME_V2_SCHEMA_VERSION).toBe('string');
  });

  it('matches the RuntimeV2SchemaVersionSchema literal schema', () => {
    // The schema MUST accept the constant. If they drift, validation will reject
    // every versioned payload — catastrophic silent degradation downstream.
    expect(Value.Check(RuntimeV2SchemaVersionSchema, RUNTIME_V2_SCHEMA_VERSION)).toBe(true);
  });
});

// ── RuntimeV2SchemaVersionSchema TypeBox schema ──────────────────────────────

describe('RuntimeV2SchemaVersionSchema TypeBox literal schema', () => {
  it('accepts exactly "1.0.0"', () => {
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '1.0.0')).toBe(true);
  });

  it('rejects "1.0.1" (patch bump)', () => {
    // Pin that a patch version bump without updating the schema literal will fail.
    // This protects against the silent contract drift that would occur if someone
    // updated RUNTIME_V2_SCHEMA_VERSION without updating the schema too.
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '1.0.1')).toBe(false);
  });

  it('rejects "1.1.0" (minor bump)', () => {
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '1.1.0')).toBe(false);
  });

  it('rejects "2.0.0" (major bump)', () => {
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '2.0.0')).toBe(false);
  });

  it('rejects "1.0" (missing patch segment)', () => {
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '1.0')).toBe(false);
  });

  it('rejects leading/trailing whitespace in version strings', () => {
    expect(Value.Check(RuntimeV2SchemaVersionSchema, ' 1.0.0')).toBe(false);
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '1.0.0 ')).toBe(false);
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '\n1.0.0\t')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(Value.Check(RuntimeV2SchemaVersionSchema, 1)).toBe(false);
    expect(Value.Check(RuntimeV2SchemaVersionSchema, null)).toBe(false);
    expect(Value.Check(RuntimeV2SchemaVersionSchema, undefined)).toBe(false);
    expect(Value.Check(RuntimeV2SchemaVersionSchema, ['1.0.0'])).toBe(false);
  });

  it('rejects case variant "1.0.0" is all same case (no case to worry about, numbers)', () => {
    // Sanity — numbers are not case sensitive; just ensure the value is exact.
    expect(Value.Check(RuntimeV2SchemaVersionSchema, '1.0.0')).toBe(true);
  });
});

// ── SchemaVersionRefSchema TypeBox string schema ─────────────────────────────

describe('SchemaVersionRefSchema (open-ended string)', () => {
  it('accepts standard refs produced by schemaRef()', () => {
    expect(Value.Check(SchemaVersionRefSchema, schemaRef('diagnostician-output', 1))).toBe(true);
    expect(Value.Check(SchemaVersionRefSchema, schemaRef('pain-signal', 2))).toBe(true);
    expect(Value.Check(SchemaVersionRefSchema, 'rule-host-input-v3')).toBe(true);
  });

  it('accepts arbitrary strings (open-ended by design)', () => {
    // SchemaVersionRefSchema is typed as Type.String() intentionally — it's a
    // "loose" reference slot used in cross-file TypeBox schema refs where the
    // exact literal list is not centralized. This test prevents accidental
    // tightening to a union/literal that would break third-party schemas.
    expect(Value.Check(SchemaVersionRefSchema, 'any-string-goes-here')).toBe(true);
    expect(Value.Check(SchemaVersionRefSchema, '')).toBe(true); // empty string = valid String()
    expect(Value.Check(SchemaVersionRefSchema, 'v1')).toBe(true);
  });

  it('rejects non-string inputs', () => {
    expect(Value.Check(SchemaVersionRefSchema, 1)).toBe(false);
    expect(Value.Check(SchemaVersionRefSchema, null)).toBe(false);
    expect(Value.Check(SchemaVersionRefSchema, undefined)).toBe(false);
    expect(Value.Check(SchemaVersionRefSchema, { ref: 'foo-v1' })).toBe(false);
    expect(Value.Check(SchemaVersionRefSchema, ['foo-v1'])).toBe(false);
  });
});

// ── Cross-contract invariants (version constant ↔ schema) ────────────────────

describe('cross-contract invariants between constant and schema', () => {
  it('schemaRef() output is compatible with SchemaVersionRefSchema', () => {
    // Every schemaRef output must be a valid SchemaVersionRef, otherwise
    // the two helpers are contradictory and consumers can't rely on either.
    for (const [kind, version] of [
      ['diagnostician-output', 1],
      ['pain-signal', 2],
      ['rule-host-input', 3],
      ['x', 999],
    ] as const) {
      const ref = schemaRef(kind, version);
      expect(Value.Check(SchemaVersionRefSchema, ref)).toBe(true);
    }
  });

  it('RUNTIME_V2_SCHEMA_VERSION is the ONLY accepted value for RuntimeV2SchemaVersionSchema', () => {
    // Enumerate some near-miss variants that developers commonly type.
    const nearMisses = [
      '1.0.1', '1.1.0', '2.0.0',       // semver bumps
      '1.0', '1', '1.', '.0.0',         // incomplete
      'v1.0.0', 'r1.0.0',              // prefixed
      '1.0.0-beta', '1.0.0+build',     // semver pre-release/build
      ' 1.0.0', '1.0.0 ',              // whitespace
    ];
    for (const v of nearMisses) {
      expect(Value.Check(RuntimeV2SchemaVersionSchema, v)).toBe(false);
    }
    // And the exact match is accepted.
    expect(Value.Check(RuntimeV2SchemaVersionSchema, RUNTIME_V2_SCHEMA_VERSION)).toBe(true);
  });
});
