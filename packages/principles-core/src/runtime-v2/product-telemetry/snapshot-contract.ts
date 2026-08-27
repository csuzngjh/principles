/**
 * Product telemetry snapshot contract — Anonymous Product Telemetry v1
 * (PRI-598, SPEC §23-§34; review remediation: tri-state milestone facts).
 *
 * Pure contract: schema, strict validator, and snapshot builder. No I/O.
 * Durable-fact readers live in host-runtime (I/O boundary); this module only
 * validates and assembles what they provide.
 *
 * Privacy invariants enforced here:
 * - Exact-key strictness: unknown top-level or nested fields are validation
 *   errors (mirrored by the collector, which must reject them with 400).
 * - Only boolean-or-null milestones — no counts, no content, no paths.
 * - A privacy guard makes schema scope creep (fields whose names carry
 *   prohibited concepts) fail tests, not just review.
 *
 * Tri-state semantics (measurement honesty — "Unknown ≠ false"):
 * - `true`  = source evaluable AND evidence observed;
 * - `false` = source evaluable AND no evidence observed;
 * - `null`  = source not currently evaluable (missing/unreadable/degraded).
 * A null milestone is excluded from the dashboard denominator — it must
 * never be summed, counted as 0, or interpreted as "not observed".
 */

import { Type, type Static } from '@sinclair/typebox';
import { isValidBucketDate, isValidDailyTelemetryId } from './daily-identity.js';

export const PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION = '1';
export const PRODUCT_TELEMETRY_CONSENT_VERSION = '1';

/** Coarse host kind derived from the install manifest, not the triggering process. */
export const PRODUCT_TELEMETRY_HOST_KINDS = ['openclaw', 'codex', 'other'] as const;
export type ProductTelemetryHostKind = (typeof PRODUCT_TELEMETRY_HOST_KINDS)[number];

/** Bounded PD version (npm version string, e.g. "1.218.0"). */
export const PRODUCT_TELEMETRY_PD_VERSION_MAX_LENGTH = 32;

/** A milestone or reliability fact: observed true / evaluated false / unavailable null. */
export type TelemetryFact = boolean | null;

const TelemetryFactSchema = Type.Union([Type.Boolean(), Type.Null()]);

export const ProductTelemetrySnapshotV1Schema = Type.Object({
  schemaVersion: Type.Literal(PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION),
  dailyTelemetryId: Type.String(),
  bucketDate: Type.String(),
  pdVersion: Type.String({ maxLength: PRODUCT_TELEMETRY_PD_VERSION_MAX_LENGTH }),
  hostKind: Type.Union([Type.Literal('openclaw'), Type.Literal('codex'), Type.Literal('other')]),
  milestones: Type.Object({
    initialized: TelemetryFactSchema,
    painObserved: TelemetryFactSchema,
    principleObserved: TelemetryFactSchema,
    activationObserved: TelemetryFactSchema,
    presenceReceiptObserved: TelemetryFactSchema,
    effectReceiptObserved: TelemetryFactSchema,
  }),
  reliability: Type.Object({
    initializationFailed: TelemetryFactSchema,
  }),
  consentVersion: Type.String(),
});

export type ProductTelemetrySnapshotV1 = Static<typeof ProductTelemetrySnapshotV1Schema>;

/** The 8 top-level fields, in wire order. The collector allowlist must equal this set. */
export const PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'dailyTelemetryId',
  'bucketDate',
  'pdVersion',
  'hostKind',
  'milestones',
  'reliability',
  'consentVersion',
] as const satisfies readonly (keyof ProductTelemetrySnapshotV1)[];

/**
 * Field-name concepts that must never appear in the telemetry schema.
 * Guard (SPEC §64): makes privacy regression technically difficult — adding
 * a field whose name matches one of these tokens fails the privacy guard
 * test unless explicitly allowlisted here with a justification.
 */
export const PROHIBITED_TELEMETRY_FIELD_TOKENS = [
  'content',
  'prompt',
  'message',
  'path',
  'file',
  'repo',
  'email',
  'username',
  'hostname',
  'stack',
  'arguments',
  'payload',
  'toolinput',
  'tooloutput',
] as const;

/**
 * Collect all field names of the schema contract (recursively) and assert
 * none matches a prohibited token. Throws with the offending names.
 */
export function assertTelemetrySchemaPrivacy(fieldNames: readonly string[]): void {
  const offenders = fieldNames.filter((name) => {
    const lower = name.toLowerCase();
    return (PROHIBITED_TELEMETRY_FIELD_TOKENS as readonly string[]).some((token) => lower.includes(token));
  });
  if (offenders.length > 0) {
    throw new Error(
      `Telemetry schema privacy guard violated: fields ${offenders.join(', ')} match prohibited concepts. ` +
        'Every exported field must be content-free; extend the schema only with an explicit privacy review.',
    );
  }
}

export interface SnapshotValidationOk {
  ok: true;
  value: ProductTelemetrySnapshotV1;
}

export interface SnapshotValidationErr {
  ok: false;
  errors: string[];
}

export type SnapshotValidationResult = SnapshotValidationOk | SnapshotValidationErr;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` / `false` / `null` (null = source unavailable — never "observed false"). */
function isTelemetryFact(value: unknown): value is TelemetryFact {
  return value === null || typeof value === 'boolean';
}

/**
 * Strict validation of an untrusted parsed snapshot (EP-01: unknown until
 * proven). Rejects unknown keys at both levels, wrong types, malformed
 * dates/IDs, overlong versions, and non-allowlisted host kinds.
 */
export function validateProductTelemetrySnapshot(raw: unknown): SnapshotValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['snapshot must be a JSON object'] };
  }

  for (const key of Object.keys(raw)) {
    if (!(PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      errors.push(`unknown top-level field '${key}'`);
    }
  }
  if (errors.length > 0) {
    // Unknown-field rejections are final; do not interpret anything else.
    return { ok: false, errors };
  }

  if (!Object.hasOwn(raw, 'schemaVersion') || raw.schemaVersion !== PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION}'`);
  }
  if (!Object.hasOwn(raw, 'consentVersion') || typeof raw.consentVersion !== 'string' || raw.consentVersion.length === 0 || raw.consentVersion.length > 8) {
    errors.push('consentVersion must be a short non-empty string');
  }
  if (!isValidDailyTelemetryId(raw.dailyTelemetryId)) {
    errors.push('dailyTelemetryId must be 32 lowercase hex chars');
  }
  if (!isValidBucketDate(raw.bucketDate)) {
    errors.push('bucketDate must be a valid YYYY-MM-DD UTC date');
  }
  if (typeof raw.pdVersion !== 'string' || raw.pdVersion.length === 0 || raw.pdVersion.length > PRODUCT_TELEMETRY_PD_VERSION_MAX_LENGTH) {
    errors.push(`pdVersion must be a non-empty string of at most ${PRODUCT_TELEMETRY_PD_VERSION_MAX_LENGTH} chars`);
  }
  if (!(PRODUCT_TELEMETRY_HOST_KINDS as readonly string[]).includes(raw.hostKind as ProductTelemetryHostKind)) {
    errors.push(`hostKind must be one of: ${PRODUCT_TELEMETRY_HOST_KINDS.join(', ')}`);
  }

  const MILESTONE_KEYS = [
    'initialized',
    'painObserved',
    'principleObserved',
    'activationObserved',
    'presenceReceiptObserved',
    'effectReceiptObserved',
  ] as const;
  const {milestones} = raw;
  if (!isPlainObject(milestones)) {
    errors.push('milestones must be an object');
  } else {
    for (const key of Object.keys(milestones)) {
      if (!(MILESTONE_KEYS as readonly string[]).includes(key)) {
        errors.push(`unknown milestones field '${key}'`);
      }
    }
    for (const key of MILESTONE_KEYS) {
      if (!Object.hasOwn(milestones, key) || !isTelemetryFact(milestones[key])) {
        errors.push(`milestones.${key} must be a boolean or null`);
      }
    }
  }

  const {reliability} = raw;
  if (!isPlainObject(reliability)) {
    errors.push('reliability must be an object');
  } else {
    for (const key of Object.keys(reliability)) {
      if (key !== 'initializationFailed') {
        errors.push(`unknown reliability field '${key}'`);
      }
    }
    if (!Object.hasOwn(reliability, 'initializationFailed') || !isTelemetryFact(reliability.initializationFailed)) {
      errors.push('reliability.initializationFailed must be a boolean or null');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Post-validation reconstruction from guard-narrowed fields — no `as` on
  // the untrusted object (rc-2). Every ternary's dead branch is unreachable
  // after the checks above; they exist only for type-safe construction.
  const hostKind = PRODUCT_TELEMETRY_HOST_KINDS.find((kind) => kind === raw.hostKind);
  const milestonesInput = isPlainObject(raw.milestones) ? raw.milestones : undefined;
  const reliabilityInput = isPlainObject(raw.reliability) ? raw.reliability : undefined;
  if (hostKind === undefined || milestonesInput === undefined || reliabilityInput === undefined) {
    return { ok: false, errors: ['schema fields failed post-validation narrowing'] };
  }
  // Guard-narrowed copy that PRESERVES null facts (an `=== true` collapse here
  // would silently turn "unavailable" into "observed false").
  const fact = (value: unknown): TelemetryFact => (value === null ? null : value === true);
  return {
    ok: true,
    value: {
      schemaVersion: PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION,
      dailyTelemetryId: typeof raw.dailyTelemetryId === 'string' ? raw.dailyTelemetryId : '',
      bucketDate: typeof raw.bucketDate === 'string' ? raw.bucketDate : '',
      pdVersion: typeof raw.pdVersion === 'string' ? raw.pdVersion : '',
      hostKind,
      milestones: {
        initialized: fact(milestonesInput.initialized),
        painObserved: fact(milestonesInput.painObserved),
        principleObserved: fact(milestonesInput.principleObserved),
        activationObserved: fact(milestonesInput.activationObserved),
        presenceReceiptObserved: fact(milestonesInput.presenceReceiptObserved),
        effectReceiptObserved: fact(milestonesInput.effectReceiptObserved),
      },
      reliability: {
        initializationFailed: fact(reliabilityInput.initializationFailed),
      },
      consentVersion: typeof raw.consentVersion === 'string' ? raw.consentVersion : '',
    },
  };
}

/** Milestone facts derived by the host-runtime reader from durable sources. */
export interface ProductTelemetryMilestoneInput {
  initialized: TelemetryFact;
  painObserved: TelemetryFact;
  principleObserved: TelemetryFact;
  activationObserved: TelemetryFact;
  presenceReceiptObserved: TelemetryFact;
  effectReceiptObserved: TelemetryFact;
}

/** Reliability facts (coarse; no messages, no stacks, no enums). */
export interface ProductTelemetryReliabilityInput {
  initializationFailed: TelemetryFact;
}

export interface BuildSnapshotInput {
  dailyTelemetryId: string;
  bucketDate: string;
  pdVersion: string;
  hostKind: ProductTelemetryHostKind;
  milestones: ProductTelemetryMilestoneInput;
  reliability: ProductTelemetryReliabilityInput;
}

/**
 * Assemble and validate one daily snapshot. Inputs are validated with the
 * same strict validator the collector applies, so a snapshot that leaves
 * this function is wire-valid by construction (fail loud on programmer
 * error rather than letting an invalid payload reach the network).
 */
export function buildProductTelemetrySnapshot(input: BuildSnapshotInput): ProductTelemetrySnapshotV1 {
  const candidate: ProductTelemetrySnapshotV1 = {
    schemaVersion: PRODUCT_TELEMETRY_SNAPSHOT_SCHEMA_VERSION,
    dailyTelemetryId: input.dailyTelemetryId,
    bucketDate: input.bucketDate,
    pdVersion: input.pdVersion,
    hostKind: input.hostKind,
    milestones: {
      initialized: input.milestones.initialized,
      painObserved: input.milestones.painObserved,
      principleObserved: input.milestones.principleObserved,
      activationObserved: input.milestones.activationObserved,
      presenceReceiptObserved: input.milestones.presenceReceiptObserved,
      effectReceiptObserved: input.milestones.effectReceiptObserved,
    },
    reliability: {
      initializationFailed: input.reliability.initializationFailed,
    },
    consentVersion: PRODUCT_TELEMETRY_CONSENT_VERSION,
  };
  const validated = validateProductTelemetrySnapshot(candidate);
  if (!validated.ok) {
    throw new Error(`Invalid product telemetry snapshot (programmer error): ${validated.errors.join('; ')}`);
  }
  return validated.value;
}
