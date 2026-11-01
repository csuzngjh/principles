/**
 * Pain Recall Capability Facade — SPEC-PD-AGENT-CAPABILITY-API-001 v0.5 §7/§8.
 *
 * The single OD-A projection authority: constructs the protocol-independent
 * `pd.capability.v1` envelope for `pd_recall_principle_pains` from the full
 * PainRecallResult produced by the read model. The envelope is built
 * field-by-field from the frozen od-a-v1 whitelist ("construction IS the
 * whitelist") — DENY fields (canonicalId, painId, evidenceRefs, pain text,
 * diagnoses.*, correctionEvidence.*, lineage hops, statusDetail-as-data, …)
 * are structurally absent, never constructed-then-stripped.
 *
 * Every call re-asserts the leaf-key path set of the produced envelope
 * (collectPaths, array indices normalized to `[]`); any non-whitelisted leaf
 * fails closed: the violating payload is withheld and an `unavailable`
 * envelope with a stable internal error code is returned instead. The
 * production self-check does NOT include the Gate 2 experimental sentinel
 * regex — sentinel scanning is a test technique (see the capability tests).
 *
 * Layer contract (v0.5 §7.1): this facade is protocol-independent. It does
 * NOT build MCP `content` blocks, does NOT set `isError`, and contains no
 * transport/execution-boundary logic — the 32 KiB response budget and the
 * 10 s call deadline are MCP Adapter (Gate 4) responsibilities and must not
 * be implemented here. Read-model execution errors (an unexpected throw)
 * propagate to the Adapter, which maps them per the Gate 4 contract; they
 * are deliberately NOT swallowed into this envelope (v0.5 §7.3).
 *
 * Zero file I/O: everything is an in-memory projection over the read model's
 * result, so this module is not registered in io-seam-registry.json (only
 * files that actually perform controlled I/O are registered).
 *
 * OD-A scope (Owner decision 2026-11-01, v0.5 §8.2): od-a-v1 governs MCP
 * Tool RESPONSE DISCLOSURE only. It is not a global agent data boundary and
 * does not prevent the existing CLI (Skill-guided) from returning the full
 * `pd.pain-recall.v1` output.
 */
import {
  recallPains,
  PAIN_RECALL_DEFAULT_LIMIT,
  PAIN_RECALL_MIN_LIMIT,
  PAIN_RECALL_MAX_LIMIT,
  type AssociationType,
  type ItemAvailability,
  type PainRecallResult,
  type PainRecallStatus,
  type SourceAvailability,
} from './pain-recall-read-model.js';

export const CAPABILITY_SCHEMA_VERSION = 'pd.capability.v1' as const;
export const OD_A_DISCLOSURE_PROFILE = 'od-a-v1' as const;
export const RECALL_PAIN_CAPABILITY_ID = 'pd_recall_principle_pains' as const;

/** Trusted-context input. `workspaceDir` is injected by the Adapter (launch
 * configuration); it must NEVER be a model-supplied tool parameter. */
export interface PainRecallCapabilityInput {
  readonly workspaceDir: string;
  readonly principleId: string;
  readonly limit?: number;
}

export type PainRecallCapabilityStatus =
  | 'ok'
  | 'no_matches'
  | 'partial'
  | 'not_found'
  | 'unavailable'
  | 'invalid_input';

export interface PainRecallCapabilityPrinciple {
  readonly requestedId: string;
  readonly identityStatus: 'resolved' | 'not_found' | 'ambiguous';
}

export interface PainRecallCapabilityQuery {
  readonly limit: number;
  readonly contextUsedForRanking: boolean;
  readonly truncated: boolean;
}

export interface PainRecallCapabilityResultEntry {
  readonly association: { readonly type: AssociationType; readonly confidence: 'explicit' | 'lineage_verified' };
  readonly availability: {
    readonly painEvent: 'available';
    readonly diagnoses: ItemAvailability;
    readonly correctionEvidence: ItemAvailability;
  };
}

export interface PainRecallCapabilityData {
  readonly principle: PainRecallCapabilityPrinciple;
  readonly query: PainRecallCapabilityQuery;
  readonly results: readonly PainRecallCapabilityResultEntry[];
  readonly summary: { readonly returned: number; readonly availableCandidates: number; readonly truncated: boolean };
  readonly sources: { readonly ledger: SourceAvailability; readonly trajectoryDb: SourceAvailability; readonly stateDb: SourceAvailability };
  readonly unresolvedAssociations: readonly { readonly reason: string }[];
}

export interface PainRecallCapabilityProvenanceSource {
  readonly name: 'ledger' | 'trajectoryDb' | 'stateDb';
  readonly status: SourceAvailability;
}

export interface PainRecallCapabilityProvenance {
  readonly workspaceBinding: 'configured';
  readonly sources: readonly PainRecallCapabilityProvenanceSource[];
}

export interface PainRecallCapabilityWarning {
  readonly code: string;
  readonly message: string;
}

export interface PainRecallCapabilityError {
  readonly code: string;
  readonly message: string;
}

export interface PainRecallCapabilityNextAction {
  readonly code: string;
  readonly message: string;
}

/** The `pd.capability.v1` envelope (v0.5 §7.2). `data` is non-null for every
 * status except `unavailable` and `invalid_input`, where nothing may be
 * disclosed about the workspace. */
export interface PainRecallCapabilityResult {
  readonly schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  readonly capability: typeof RECALL_PAIN_CAPABILITY_ID;
  readonly disclosureProfile: typeof OD_A_DISCLOSURE_PROFILE;
  readonly status: PainRecallCapabilityStatus;
  readonly data: PainRecallCapabilityData | null;
  readonly provenance: PainRecallCapabilityProvenance;
  readonly warnings: readonly PainRecallCapabilityWarning[];
  readonly error: PainRecallCapabilityError | null;
  readonly nextAction: PainRecallCapabilityNextAction | null;
}

/**
 * Frozen od-a-v1 allowed leaf-key paths (array indices normalized to `[]`).
 * Copied field-by-field from the hash-anchored Gate 2 executable projection
 * (`project.mjs` ALLOWED_PATHS) plus the single v0.5 addition
 * `disclosureProfile`. NOT exported: the contract is pinned behaviorally by
 * the capability tests; widening requires a new profile version + Owner
 * decision (v0.5 §7.4). Do not rebuild this list from documentation.
 */
const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  'schemaVersion', 'capability', 'status', 'disclosureProfile',
  'data.principle.requestedId', 'data.principle.identityStatus',
  'data.query.limit', 'data.query.contextUsedForRanking', 'data.query.truncated',
  'data.results[].association.type', 'data.results[].association.confidence',
  'data.results[].availability.painEvent', 'data.results[].availability.diagnoses',
  'data.results[].availability.correctionEvidence',
  'data.summary.returned', 'data.summary.availableCandidates', 'data.summary.truncated',
  'data.sources.ledger', 'data.sources.trajectoryDb', 'data.sources.stateDb',
  'data.unresolvedAssociations[].reason',
  'provenance.workspaceBinding', 'provenance.sources[].name', 'provenance.sources[].status',
  'warnings[].code', 'warnings[].message',
  'error', 'error.code', 'error.message',
  'nextAction', 'nextAction.code', 'nextAction.message',
]);

/**
 * OUTER_STATUS — the single authority table (v0.5 §7.3). `ambiguous_principle`
 * is RESERVED: the read model never produces it today (identity resolves
 * exactly or reports not_found), and this facade must not fabricate the
 * capability; the mapping row exists so a future read-model change surfaces
 * as invalid_input instead of silently passing through. `denied` /
 * `unconfirmed` are NOT enabled in the first release (v0.5 §7.3).
 */
const OUTER_STATUS: Readonly<Record<PainRecallStatus, PainRecallCapabilityStatus>> = {
  ok: 'ok',
  no_matches: 'no_matches',
  partial: 'partial',
  principle_not_found: 'not_found',
  pain_not_found: 'not_found',
  source_missing: 'unavailable',
  source_unreadable: 'unavailable',
  ambiguous_principle: 'invalid_input', // reserved — not produced (v0.5 F8)
};

/** errorFor — status → stable error derivation (Gate 2 semantics, verbatim).
 * `statusDetail` participates ONLY here (pain_not_found code derivation);
 * it is never emitted as a data field (frozen per v0.5 §8.1 detail 1). */
function errorFor(result: PainRecallResult): PainRecallCapabilityError | null {
  const s = result.status;
  if (s === 'ok' || s === 'no_matches' || s === 'partial') return null;
  if (s === 'principle_not_found') {
    return { code: 'principle_not_found', message: 'The requested principle id does not resolve to a canonical ledger principle.' };
  }
  if (s === 'pain_not_found') {
    return {
      code: result.statusDetail ?? 'pain_not_found',
      message: 'The requested pain is not within this principle\'s verified associations.',
    };
  }
  if (s === 'source_missing') {
    return { code: 'source_missing', message: 'A required data source is missing; the query cannot be answered.' };
  }
  if (s === 'source_unreadable') {
    return { code: 'source_unreadable', message: 'A required data source is unreadable; the query cannot be answered.' };
  }
  // Reserved row (ambiguous_principle → invalid_input): a stable refusal
  // without fabricating capability the read model never claimed.
  return { code: 'invalid_input', message: 'The request violates the tool input contract.' };
}

/** OD-A projection of a full PainRecallResult into the envelope. Construction
 * IS the whitelist: every field below is an ALLOWED_PATHS leaf; nothing else
 * from `result` is reachable. (Gate 2 projectEnvelope + disclosureProfile +
 * the v0.5 §7.2 data-null rule: an `unavailable` outcome discloses no data.) */
function projectEnvelope(result: PainRecallResult): PainRecallCapabilityResult {
  const status = OUTER_STATUS[result.status] ?? 'unavailable';
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capability: RECALL_PAIN_CAPABILITY_ID,
    disclosureProfile: OD_A_DISCLOSURE_PROFILE,
    status,
    data: status === 'unavailable' ? null : {
      principle: {
        requestedId: result.principle.requestedId,
        identityStatus: result.principle.identityStatus,
      },
      query: {
        limit: result.query.limit,
        contextUsedForRanking: result.query.contextUsedForRanking,
        truncated: result.query.truncated,
      },
      results: result.results.map((e) => ({
        association: { type: e.association.type, confidence: e.association.confidence },
        availability: {
          painEvent: e.availability.painEvent,
          diagnoses: e.availability.diagnoses,
          correctionEvidence: e.availability.correctionEvidence,
        },
      })),
      summary: {
        returned: result.summary.returned,
        availableCandidates: result.summary.availableCandidates,
        truncated: result.summary.truncated,
      },
      sources: {
        ledger: result.sources.ledger,
        trajectoryDb: result.sources.trajectoryDb,
        stateDb: result.sources.stateDb,
      },
      unresolvedAssociations: result.unresolvedAssociations.map((u) => ({ reason: u.reason })),
    },
    provenance: {
      workspaceBinding: 'configured',
      sources: [
        { name: 'ledger', status: result.sources.ledger },
        { name: 'trajectoryDb', status: result.sources.trajectoryDb },
        { name: 'stateDb', status: result.sources.stateDb },
      ],
    },
    warnings: [],
    error: errorFor(result),
    nextAction: null,
  };
}

/** Deep key-path walk (arrays normalized to `[]`) for whitelist assertions.
 * An empty array exposes no leaf data — no bare path is emitted. Gate 2
 * collectPaths, verbatim. */
function collectPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, prefix + '[]', out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectPaths(v, prefix ? prefix + '.' + k : k, out);
    return;
  }
  out.add(prefix);
}

/** Production self-check: leaf paths of the envelope that are not in the
 * frozen whitelist. Violations are reported to the caller (the facade), which
 * withholds the payload — the violating paths/values never leave this module.
 *
 * §7.2 null form: `data: null` is the envelope's explicit empty marker for
 * the `unavailable` / `invalid_input` statuses. It surfaces as a bare `data`
 * leaf, which the frozen od-a-v1 path set does not list (the Gate 2
 * prototype never projected a null data) — the whitelist governs the
 * POPULATED shape of `data.*`, so the null marker is removed before the
 * diff, not tolerated anywhere else. */
function collectPathViolations(envelope: PainRecallCapabilityResult): string[] {
  const paths = new Set<string>();
  collectPaths(envelope, '', paths);
  if (envelope.data === null) paths.delete('data');
  return [...paths].filter((p) => !ALLOWED_PATHS.has(p));
}

// ── Input validation (rc-1/rc-2: unknown in, field-by-field guards) ─────────

const PRINCIPLE_ID_MAX_LENGTH = 200;
const INPUT_KEYS: ReadonlySet<string> = new Set(['workspaceDir', 'principleId', 'limit']);

function truncateForMessage(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function invalid(reason: string):
  { ok: false; error: PainRecallCapabilityError } {
  return { ok: false, error: { code: 'invalid_input', message: `The request violates the tool input contract: ${reason}` } };
}

/**
 * Validate the capability input field by field, rejecting every undeclared
 * property. Fail-closed: any violation prevents the read model from being
 * called at all. Messages name the field and the rule — never the value
 * (bounded output, rc-8; the input is untrusted model output in the Gate 4
 * deployment).
 */
function validateCapabilityInput(input: unknown):
  { ok: true; value: Required<Pick<PainRecallCapabilityInput, 'workspaceDir' | 'principleId'>> & { limit: number } }
  | { ok: false; error: PainRecallCapabilityError } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('the input must be an object');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!INPUT_KEYS.has(key)) {
      return invalid(`unknown property "${truncateForMessage(key)}" is not allowed`);
    }
  }
  const { workspaceDir, principleId, limit } = record;
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
    return invalid('workspaceDir must be a non-empty string (injected trusted context)');
  }
  if (typeof principleId !== 'string' || principleId.length === 0 || principleId.length > PRINCIPLE_ID_MAX_LENGTH) {
    return invalid(`principleId must be a string of 1..${PRINCIPLE_ID_MAX_LENGTH} characters`);
  }
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < PAIN_RECALL_MIN_LIMIT || limit > PAIN_RECALL_MAX_LIMIT) {
      return invalid(`limit must be an integer between ${PAIN_RECALL_MIN_LIMIT} and ${PAIN_RECALL_MAX_LIMIT}`);
    }
  }
  return { ok: true, value: { workspaceDir, principleId, limit: limit ?? PAIN_RECALL_DEFAULT_LIMIT } };
}

// ── Fail-closed envelopes ────────────────────────────────────────────────────

function envelopeShell(status: PainRecallCapabilityStatus, error: PainRecallCapabilityError | null): PainRecallCapabilityResult {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capability: RECALL_PAIN_CAPABILITY_ID,
    disclosureProfile: OD_A_DISCLOSURE_PROFILE,
    status,
    data: null,
    provenance: { workspaceBinding: 'configured', sources: [] },
    warnings: [],
    error,
    nextAction: null,
  };
}

// ── Capability entry point ───────────────────────────────────────────────────

/**
 * Recall a principle's verifiably-associated historical pains through the
 * od-a-v1 disclosure profile.
 *
 * Duty sequence (v0.5 §7.1): validate input (fail-closed `invalid_input`,
 * the read model is never called on bad input) → `recallPains` on the trusted
 * workspace → OD-A projection (construction IS the whitelist) → leaf-path
 * self-check (violation ⇒ withhold the payload, return `unavailable`) →
 * return.
 *
 * Resource constraint owned here (v0.5 §7.5.2, the only Core-layer limit):
 * `limit ∈ [1, 10]`, default `PAIN_RECALL_DEFAULT_LIMIT` (3); the returned
 * entry count is bounded by the read model's existing truncation semantics
 * (≤ limit ≤ 10). The 32 KiB response budget and the 10 s deadline are NOT
 * implemented here — they are Gate 4 MCP Adapter responsibilities.
 */
export async function recallPrinciplePainsCapability(
  input: PainRecallCapabilityInput,
): Promise<PainRecallCapabilityResult> {
  const validated = validateCapabilityInput(input);
  if (!validated.ok) {
    return envelopeShell('invalid_input', validated.error);
  }
  const raw = await recallPains(validated.value.workspaceDir, {
    requestedPrincipleId: validated.value.principleId,
    limit: validated.value.limit,
  });
  const envelope = projectEnvelope(raw);
  if (collectPathViolations(envelope).length > 0) {
    // Disclosure assertion failed: the payload is withheld (never returned),
    // and the message stays generic so a violating field cannot leak through
    // the failure channel either (values AND key paths stay internal).
    return envelopeShell('unavailable', {
      code: 'disclosure_assertion_failed',
      message: 'Internal disclosure assertion failed; the response was withheld.',
    });
  }
  return envelope;
}
