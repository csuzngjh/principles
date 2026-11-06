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
 * Every call re-asserts BOTH the leaf-key path set AND the structural
 * container paths of the produced envelope (array indices normalized to
 * `[]`); any non-whitelisted leaf — or any container that is not a proper
 * ancestor of a whitelisted leaf (this catches a forbidden key hiding in an
 * EMPTY array or object, which a leaf-only walk cannot see) — fails closed:
 * the violating payload is withheld and an `unavailable` envelope with a
 * stable internal error code is returned instead. The production self-check
 * does NOT include the Gate 2 experimental sentinel regex — sentinel
 * scanning is a test technique (see the capability tests).
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

const CANDIDATE_LINEAGE_REASONS: ReadonlySet<string> = new Set([
  'candidate_query_failed',
  'candidate_not_found',
  'pain_unresolvable_from_candidate',
  'pain_event_only_in_state_db',
]);

/** Warning text is built ONLY from trusted read-model facts (fixed literals,
 * no ids, no workspace content). A recall that leaves associations unresolved
 * must never look like a clean success: the model needs to know WHY it is
 * empty and that the ledger field name is legacy. */
function warningsFor(result: PainRecallResult): PainRecallCapabilityWarning[] {
  const warnings: PainRecallCapabilityWarning[] = [];
  const reasons = new Set(result.unresolvedAssociations.map((u) => u.reason));
  const hasCandidateLineage =
    result.results.some((e) => e.association.type === 'derived_from' || e.association.type === 'multiple_paths') ||
    [...reasons].some((r) => CANDIDATE_LINEAGE_REASONS.has(r));
  if (result.unresolvedAssociations.length > 0 && hasCandidateLineage) {
    warnings.push({
      code: 'derived_from_candidate_ids',
      message:
        'The ledger field derivedFromPainIds stores candidate IDs under a legacy pain-oriented name; this recall reverse-resolved them via candidate -> task -> pain. At least one association could not complete that chain.',
    });
  }
  if (reasons.has('pain_event_only_in_state_db')) {
    warnings.push({
      code: 'pain_event_only_in_state_db',
      message:
        'A verified association has no trajectory.db pain_events row because the pain was registered without a bound host session (CLI bridge). Its text remains in the workspace state database.',
    });
  }
  if (result.unresolvedAssociations.length > 0 && warnings.length === 0) {
    warnings.push({
      code: 'unresolved_associations',
      message: 'Some ledger associations could not be verified against persisted pain events; see unresolvedAssociations.reason.',
    });
  }
  return warnings;
}

/** An empty-looking recall must still carry an actionable next step whenever
 * something failed to resolve (v0.5 §7.6). Never null in that case. */
function nextActionFor(result: PainRecallResult): PainRecallCapabilityNextAction | null {
  if (result.unresolvedAssociations.length === 0) return null;
  if (result.unresolvedAssociations.some((u) => u.reason === 'pain_event_only_in_state_db')) {
    return {
      code: 'inspect_state_db_pain_diagnosis',
      message:
        'Run `pd trace` in this workspace to inspect the diagnosis task of the verified association, or re-record the pain with a bound --session so it is projected into trajectory.db.',
    };
  }
  return {
    code: 'inspect_unresolved_associations',
    message:
      'Run `pd trace` in this workspace to inspect the candidate -> diagnosis -> pain chain for the unresolved association.',
  };
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
    // §7.2: data is null for BOTH unavailable and invalid_input (the
    // reserved ambiguous→invalid_input row included — review round 2,
    // P2-3). Every other status carries the projected data object.
    data: status === 'unavailable' || status === 'invalid_input' ? null : {
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
    warnings: warningsFor(result),
    error: errorFor(result),
    nextAction: nextActionFor(result),
  };
}

/** Deep key-path walk over the envelope for whitelist assertions. Leaves
 * (primitives/null) contribute their exact path; every container additionally
 * contributes a STRUCTURAL path — objects at `prefix`, arrays at
 * `prefix + '[]'` — so a forbidden key cannot hide behind an EMPTY array or
 * empty object (a leaf-only walk would see nothing at all; review round 2,
 * P1-2). Gate 2's leaf-only collectPaths semantics remain for the leaf set. */
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

/** All structural container paths of the envelope: objects at their key path,
 * arrays at their `[]`-normalized key path. Empty containers contribute ONLY
 * a structural path — exactly the case a leaf-only walk cannot see. */
function collectStructuralPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    if (prefix !== '') out.add(prefix + '[]');
    for (const v of value) collectStructuralPaths(v, prefix + '[]', out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (prefix !== '') out.add(prefix);
    for (const [k, v] of Object.entries(value)) collectStructuralPaths(v, prefix ? prefix + '.' + k : k, out);
    return;
  }
}

const ALLOWED_PATH_LIST: readonly string[] = [...ALLOWED_PATHS];

/** A structural container path is legal only when it is a proper ancestor of
 * at least one whitelisted leaf path: objects must be followed by a whitelisted
 * `structural.` descendant, arrays by a whitelisted `structural[]…` one. A
 * whitelisted LEAF path made a container (e.g. someone turns `status` into an
 * object) has no such descendant and fails here. */
function isAllowedStructuralPath(structural: string, isArray: boolean): boolean {
  const marker = isArray ? `${structural}[]` : `${structural}.`;
  return ALLOWED_PATH_LIST.some((p) => p.startsWith(marker));
}

/** Production self-check: BOTH leaf paths and structural container paths of
 * the envelope, against the frozen whitelist. Violations are returned to the
 * facade, which withholds the whole payload — the violating paths/values
 * never leave this module.
 *
 * §7.2 null form: `data: null` is the envelope's explicit empty marker for
 * the `unavailable` / `invalid_input` statuses. It surfaces as a bare `data`
 * leaf, which the frozen od-a-v1 path set does not list (the Gate 2
 * prototype never projected a null data) — the whitelist governs the
 * POPULATED shape of `data.*`, so the null marker is exempted here and
 * nowhere else. */
function collectDisclosureViolations(envelope: PainRecallCapabilityResult): string[] {
  const leafPaths = new Set<string>();
  collectPaths(envelope, '', leafPaths);
  if (envelope.data === null) leafPaths.delete('data');
  const violations = [...leafPaths].filter((p) => !ALLOWED_PATHS.has(p));

  const structuralPaths = new Set<string>();
  collectStructuralPaths(envelope, '', structuralPaths);
  for (const p of structuralPaths) {
    const isArray = p.endsWith('[]');
    const base = isArray ? p.slice(0, -2) : p;
    if (!isAllowedStructuralPath(base, isArray)) violations.push(p);
  }
  return violations;
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
 * workspace → OD-A projection (construction IS the whitelist) → leaf AND
 * structural key-path self-check (violation ⇒ withhold the payload, return
 * `unavailable`) → return.
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
  if (collectDisclosureViolations(envelope).length > 0) {
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
