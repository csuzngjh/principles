import { Type } from '@sinclair/typebox';

/**
 * UTC timestamp schema shared by the governance contracts (PRI-798).
 *
 * Deliberately pattern-based instead of a FormatRegistry custom format: the
 * registry is process-global state scoped to a single @sinclair/typebox copy,
 * and the installed runtime layout can load these contracts and their
 * Value.Check call sites under different copies — a registered format is then
 * invisible to the checking instance and every validation fails (in the field
 * this 500'd 100% of governance projections). A pattern lives inside the
 * schema itself and survives any instance split.
 *
 * Shape-level only: field ranges are enforced, but calendar-rollover values
 * (e.g. 02-30) pass. Producers gate timestamps semantically before persisting;
 * this schema is the last-line contract guard, not the semantic authority.
 */
export const ISO_8601_UTC_SHAPE_PATTERN =
  '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{3})?Z$';

export const GovernanceTimestampSchema = Type.String({ pattern: ISO_8601_UTC_SHAPE_PATTERN });
