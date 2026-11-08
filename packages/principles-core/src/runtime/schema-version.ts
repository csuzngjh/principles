/**
 * Schema versioning mechanism for PD runtime contracts.
 *
 * Each versioned contract carries a `schemaVersion` field so that evolution
 * is explicit and detectable at runtime.
 *
 * PRI-1139 (PR-6 write-side cutover): the versioned helpers that used to
 * live here — the `schemaRef(kind, version)` formatter, the '1.0.0' runtime
 * schema-version constant (either spelling of its generational name), and
 * their TypeBox schemas — are retired. They had no production consumers at
 * retirement. The field NAME `schemaVersion` is unchanged; its written VALUE
 * is the version-neutral token below, and historical `'1'` payloads remain
 * valid reads for as long as backward read compatibility is required.
 */
import { Type, type Static } from '@sinclair/typebox';

/**
 * The `schemaVersion` value every current writer stamps. Version-neutral by
 * design: a bare `-vN` suffix would recreate the generational naming PRI-1104
 * removed, while a semver string would imply independent per-contract
 * versioning that does not exist.
 */
export const RUNTIME_CONTRACT_SCHEMA_VERSION = 'current';

/**
 * The value written before the PRI-1139 cutover. Kept as a named constant so
 * read-side dual acceptance is a one-line membership check, not a bare string.
 */
export const LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION = '1';

/**
 * Read-side contract: accepts the current token and the legacy pre-cutover
 * value. Anything else fails validation (fail loud, no silent fallback).
 */
export const RuntimeContractSchemaVersionSchema = Type.Union([
  Type.Literal(RUNTIME_CONTRACT_SCHEMA_VERSION),
  Type.Literal(LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION),
]);
export type RuntimeContractSchemaVersion = Static<typeof RuntimeContractSchemaVersionSchema>;

/** Runtime guard for {@link RuntimeContractSchemaVersionSchema}. */
export function isRuntimeContractSchemaVersion(value: unknown): value is RuntimeContractSchemaVersion {
  return value === RUNTIME_CONTRACT_SCHEMA_VERSION || value === LEGACY_RUNTIME_CONTRACT_SCHEMA_VERSION;
}
