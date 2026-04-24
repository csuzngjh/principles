/**
 * Schema versioning mechanism for PD Runtime v2 contracts.
 *
 * Each versioned contract carries a `schemaVersion` field so that
 * evolution is explicit and detectable at runtime.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 11.3
 */
import { type Static } from '@sinclair/typebox';
/** Current schema version for all runtime-v2 contracts. */
export declare const RUNTIME_V2_SCHEMA_VERSION = "1.0.0";
/** Version prefix used in schema refs (e.g., "diagnostician-output-v1"). */
export declare function schemaRef(kind: string, version: number): string;
/** TypeBox schema for versioned schema references (format: "kind-vN"). */
export declare const SchemaVersionRefSchema: import("@sinclair/typebox").TString;
export type SchemaVersionRef = Static<typeof SchemaVersionRefSchema>;
/** TypeBox literal schema for the current runtime-v2 schema version. */
export declare const RuntimeV2SchemaVersionSchema: import("@sinclair/typebox").TLiteral<"1.0.0">;
export type RuntimeV2SchemaVersion = Static<typeof RuntimeV2SchemaVersionSchema>;
//# sourceMappingURL=schema-version.d.ts.map