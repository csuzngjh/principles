/**
 * Schema Version Tests — Core Package
 *
 * Unit tests for schema-version.ts — the PRI-1139 version-neutral contract
 * version token and its read-side union.
 *
 * The retired helpers (schemaRef()/RUNTIME_SCHEMA_VERSION='1.0.0' and their
 * schemas) had no production consumers; their replacement is one write token
 * ('current'), one named legacy token ('1') for dual-read acceptance, and one
 * TypeBox union that read paths validate against.
 *
 * Tests verify:
 * - RUNTIME_CONTRACT_SCHEMA_VERSION is exactly 'current' (write-side token)
 * - LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION is exactly '1' (pre-cutover token)
 * - RuntimeContractSchemaVersionSchema accepts exactly those two values
 * - isRuntimeContractSchemaVersion matches the schema verdict on both paths
 *
 * ERR checklist:
 * - ERR-088: asserts exact values, not merely truthy — drift from 'current'
 *   to any generational suffix must fail these tests.
 * - ERR-089: branch coverage on both accept and reject paths for each check.
 */

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION,
  RuntimeContractSchemaVersionSchema,
  isRuntimeContractSchemaVersion,
} from '../schema-version.js';

// ── Write-side token ───────────────────────────────────────────────────────

describe('RUNTIME_CONTRACT_SCHEMA_VERSION (write token)', () => {
  it('is exactly the string "current"', () => {
    // ERR-088: exact literal check. A drift to 'current-v2' or '2' must fail.
    expect(RUNTIME_CONTRACT_SCHEMA_VERSION).toBe('current');
  });

  it('carries no generational -vN suffix', () => {
    expect(RUNTIME_CONTRACT_SCHEMA_VERSION).not.toMatch(/-v\d+$/);
    expect(RUNTIME_CONTRACT_SCHEMA_VERSION).not.toMatch(/_v\d+$/);
  });
});

// ── Legacy read token ──────────────────────────────────────────────────────

describe('LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION (pre-cutover token)', () => {
  it('is exactly the string "1" — the value every pre-PRI-1139 writer stamped', () => {
    expect(LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION).toBe('1');
  });

  it('differs from the current token (dual-read needs two distinct values)', () => {
    expect(LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION).not.toBe(RUNTIME_CONTRACT_SCHEMA_VERSION);
  });
});

// ── Read-side union schema ─────────────────────────────────────────────────

describe('RuntimeContractSchemaVersionSchema (dual-read union)', () => {
  it('accepts the current write token', () => {
    expect(Value.Check(RuntimeContractSchemaVersionSchema, RUNTIME_CONTRACT_SCHEMA_VERSION)).toBe(true);
  });

  it('accepts the legacy pre-cutover token (backward read compatibility)', () => {
    expect(Value.Check(RuntimeContractSchemaVersionSchema, LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION)).toBe(true);
  });

  it('rejects the retired semver token "1.0.0"', () => {
    // The retired RUNTIME_SCHEMA_VERSION was never a schemaVersion field value;
    // accepting it here would silently widen the read contract.
    expect(Value.Check(RuntimeContractSchemaVersionSchema, '1.0.0')).toBe(false);
  });

  it('rejects generational suffix variants', () => {
    for (const v of ['current-v1', 'v1', 'v2', '2', 'v-current', 'CURRENT']) {
      expect(Value.Check(RuntimeContractSchemaVersionSchema, v), v).toBe(false);
    }
  });

  it('rejects whitespace and non-string inputs', () => {
    expect(Value.Check(RuntimeContractSchemaVersionSchema, ' current')).toBe(false);
    expect(Value.Check(RuntimeContractSchemaVersionSchema, 'current ')).toBe(false);
    expect(Value.Check(RuntimeContractSchemaVersionSchema, 1)).toBe(false);
    expect(Value.Check(RuntimeContractSchemaVersionSchema, null)).toBe(false);
    expect(Value.Check(RuntimeContractSchemaVersionSchema, undefined)).toBe(false);
    expect(Value.Check(RuntimeContractSchemaVersionSchema, ['current'])).toBe(false);
  });
});

// ── Runtime guard parity ───────────────────────────────────────────────────

describe('isRuntimeContractSchemaVersion (guard parity with the schema)', () => {
  it('accepts exactly what the schema accepts', () => {
    const candidates = ['current', '1', '1.0.0', 'v1', '2', '', 1, null, undefined];
    for (const v of candidates) {
      expect(isRuntimeContractSchemaVersion(v), String(v))
        .toBe(Value.Check(RuntimeContractSchemaVersionSchema, v));
    }
  });
});

// ── Retirement contract ────────────────────────────────────────────────────

describe('PRI-1139 retirement: versioned helpers are gone', () => {
  it('schema-version.ts no longer declares schemaRef/RUNTIME_SCHEMA_VERSION family', () => {
    // The module docstring intentionally NAMES the retired helpers (retirement
    // is part of the contract), so these assertions target export declarations,
    // not bare mentions.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'schema-version.ts'), 'utf-8');
    expect(src).not.toContain('export function schemaRef');
    expect(src).not.toContain('export const RUNTIME_SCHEMA_VERSION');
    expect(src).not.toContain('export const SchemaVersionRefSchema');
    expect(src).not.toContain('export const RuntimeSchemaVersionSchema');
  });

  it('the runtime barrel no longer exports the retired names', async () => {
    const barrel = await import('../index.js') as Record<string, unknown>;
    expect(Object.hasOwn(barrel, 'schemaRef')).toBe(false);
    expect(Object.hasOwn(barrel, 'RUNTIME_SCHEMA_VERSION')).toBe(false);
    expect(Object.hasOwn(barrel, 'SchemaVersionRefSchema')).toBe(false);
    expect(Object.hasOwn(barrel, 'RuntimeSchemaVersionSchema')).toBe(false);
    expect(Object.hasOwn(barrel, 'RUNTIME_CONTRACT_SCHEMA_VERSION')).toBe(true);
    expect(Object.hasOwn(barrel, 'LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION')).toBe(true);
  });
});
