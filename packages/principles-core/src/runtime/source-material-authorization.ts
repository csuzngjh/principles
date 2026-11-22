/**
 * Source-material authorization — PRI-1283 R2 shared gate (SPEC-PD-FEEDBACK
 * RESILIENCE-001 TECH §2.2).
 *
 * One authorization question, asked identically at every consumption entry
 * point: "may material sourced from host H's consent-gated conversation
 * ingestion still be read RIGHT NOW?"
 *
 * Authority model (P4 — one source of truth):
 *   - The DECISION authority is the conversation-ingestion consent ledger v3
 *     file (`<workspace>/.state/conversation-ingestion-consent.json`), owned
 *     by `@principles/host-runtime` `conversation-ingestion/consent.ts`.
 *   - This module defines the PORT (pure interface) plus the pure helpers that
 *     map `sourceRef` strings onto host kinds and filter evidence entries.
 *     Core read paths (context assembly, diagnosis runners, recall) consume
 *     the port; host-runtime supplies the ledger-backed implementation at the
 *     composition roots. Core never parses the ledger file itself.
 *
 * Fail-closed posture (R2, TECH §2.2.1):
 *   - A port is consulted PER CALL — never cached — so a revocation recorded
 *     between two reads takes effect on the next call ("缓存命中时撤回 → 不得
 *     返回旧缓存内容").
 *   - When NO port is wired, governance-sourced material is DENIED
 *     (`denyAllSourceMaterialAuthorization`): consuming consent-gated
 *     excerpts without an authorization check is exactly the R2 gap; the
 *     default must not silently re-open it. Non-governance refs
 *     (`owner_reported:`, `candidate://`, openclaw inline refs, …) are not
 *     governed by the conversation-ingestion consent ledger and remain
 *     usable.
 *
 * sourceRef → host mapping (Evidence Over Assumption — the two producers in
 * this repository are codex-adapter and workbuddy-adapter ingestion):
 *   - `governance_observation:codex|<rollout>|<turn>|<kind>` → 'codex'
 *   - `governance_observation:wb|<sessionIdentity>|<recordId>`   → 'workbuddy'
 *   - `governance_observation:<anything else>` → unknown host: DENIED (the ref
 *     CLAIMS governance origin; an unparseable origin cannot become a grant).
 *   - any other prefix → null (not consent-gated by this ledger).
 */

import { fingerprintStatement } from './store/candidate/admission-document.js';

/** Host kinds whose conversation ingestion is governed by the consent ledger. */
export type SourceMaterialHostKind = 'codex' | 'workbuddy' | 'openclaw';

/** Structured denial reason (stable IDs, rc-9). */
export type SourceMaterialDenialReason =
  | 'consent_revoked'
  | 'consent_not_granted'
  | 'consent_missing'
  | 'consent_unreadable'
  | 'authorization_unavailable';

export type SourceAuthorizationState =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: SourceMaterialDenialReason; readonly detail?: string };

/**
 * The R2 port. Implementations MUST read the latest consent state on every
 * call — a captured/cached decision re-serves a pre-revocation answer, which
 * is the exact bug class this gate exists to close.
 */
export interface SourceMaterialAuthorizationPort {
  isHostSourceMaterialAuthorized(hostKind: SourceMaterialHostKind): SourceAuthorizationState;
}

/** Fail-closed default used when no port is wired: every host is denied. */
export const denyAllSourceMaterialAuthorization: SourceMaterialAuthorizationPort = {
  isHostSourceMaterialAuthorized: (): SourceAuthorizationState => ({
    authorized: false,
    reason: 'authorization_unavailable',
    detail: 'no source-material authorization check wired; governance-sourced material is denied (PRI-1283 R2 fail-closed default)',
  }),
};

/** The one sourceRef prefix produced by consent-gated governance ingestion. */
export const GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX = 'governance_observation:';

// ── Owner-explicit provenance (PRI-1283 review round 2, directive B; ───────
//    round 3: owner_manual vs Agent-derived semantics) ──────────────────────
//
// Revocation of a host's conversation-ingestion consent governs material the
// system COLLECTED from that host's conversations. It does NOT govern material
// the Owner explicitly submitted (`PD记录痛苦：` prefix, `pd pain explicit`,
// WorkBuddy explicit intake, `--owner-statement`, manual OpenClaw pains) —
// those are Owner acts, not ingestion. Every purge/read gate below must
// classify provenance through these helpers so all consumption entry points
// (sweep / recall / context assembler / console / admission) share ONE
// judgment instead of five (directive B2).
//
// Owner ruling (final): a statement is `owner_manual` ONLY when
//   (a) the Owner submitted it directly — the channel itself is the credible
//       record (the host read the Owner's prompt, or the Owner typed it on a
//       manual entry), or
//   (b) an agent submitted it AND a trusted Owner confirmation record bound
//       to the exact persisted text exists (`ownerConfirmation` written by
//       the registration path after a verbatim turn-transcript match — a
//       field the submission API cannot self-declare).
// Everything else an agent produced — paraphrase, summary, inference, or a
// bare payload claim of Owner approval — is Agent-derived: it stays governed
// by the host's consent and is withheld/purged on revocation. A persisted
// `codex_explicit_agent` channel WITHOUT a bound confirmation is therefore
// never owner-exempt.

/**
 * Correction-evidence channels where the channel ITSELF is the credible
 * Owner record — the text was read from the Owner's own input by the host
 * (prefix entries), typed by the Owner on a manual entry, or recorded as a
 * manual OpenClaw pain. `codex_explicit_agent` is deliberately absent: it is
 * model-transcribed text and requires a bound confirmation record instead
 * ({@link isOwnerManualCorrectionEvidence}).
 */
export const OWNER_EXPLICIT_CORRECTION_CHANNELS: readonly string[] = [
  'codex_explicit_prefix',
  'workbuddy_explicit_prefix',
  'cli_owner_statement',
  'openclaw_manual_pain',
];

/**
 * Does this correction-evidence channel mark an explicit Owner submission?
 * Unknown/non-string channels are NOT owner-explicit (fail toward the
 * consent-gated reading — directive B3: unattributable is never a grant).
 */
export function isOwnerExplicitCorrectionChannel(channel: unknown): boolean {
  return typeof channel === 'string' && OWNER_EXPLICIT_CORRECTION_CHANNELS.includes(channel);
}

/**
 * The `ownerConfirmation.kind` the registration path stamps on an
 * agent-assisted statement ONLY after verifying the submitted text appears
 * verbatim in the current turn's host transcript — the trusted Owner
 * interaction record. `statementFingerprint` is sha256 of the PERSISTED
 * (sanitized) text, binding the confirmation to the final submitted content:
 * a confirmation recorded for different text, or text altered afterwards,
 * never matches.
 */
export const OWNER_VERBATIM_CONFIRMATION_KIND = 'owner_verbatim_turn_match';

function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined;
}

/**
 * The ONE Owner-statement judgment (owner_manual vs Agent-derived): is this
 * persisted correction evidence credibly Owner-authored — an Owner act that
 * survives a consent revocation?
 *
 *   - a direct-Owner channel → yes (the channel is the credible record);
 *   - `codex_explicit_agent` → yes ONLY with `classification` 'owner_statement'
 *     AND an `ownerConfirmation` of kind {@link OWNER_VERBATIM_CONFIRMATION_KIND}
 *     whose `statementFingerprint` equals the fingerprint of the persisted
 *     text (the confirmation must bind to the final submitted content);
 *   - anything else — agent-reported, unattributable, self-declared — no.
 */
export function isOwnerManualCorrectionEvidence(evidence: unknown): boolean {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return false;
  const record = evidence as Record<string, unknown>;
  const text = ownField(record, 'text');
  if (typeof text !== 'string' || text.length === 0) return false;
  const channel = ownField(record, 'channel');
  if (isOwnerExplicitCorrectionChannel(channel)) return true;
  if (channel !== 'codex_explicit_agent') return false;
  if (ownField(record, 'classification') !== 'owner_statement') return false;
  const confirmation = ownField(record, 'ownerConfirmation');
  if (typeof confirmation !== 'object' || confirmation === null || Array.isArray(confirmation)) return false;
  const confirmationRecord = confirmation as Record<string, unknown>;
  return ownField(confirmationRecord, 'kind') === OWNER_VERBATIM_CONFIRMATION_KIND
    && ownField(confirmationRecord, 'statementFingerprint') === fingerprintStatement(text);
}

/**
 * The persisted `reason` marker produced by `correctionReason` for explicit
 * Owner statements (admission markers and pain_events rows carry it).
 */
export const OWNER_EXPLICIT_STATEMENT_REASON_MARKER = 'explicit owner statement';

/**
 * Reason qualifiers that DISQUALIFY the owner-explicit marker: the legacy
 * agent-assisted reason (`agent-assisted, no prefix`) and every reason that
 * discloses an unverified Owner confirmation — both describe agent-derived
 * text, never an Owner act.
 */
const AGENT_DERIVED_REASON_QUALIFIERS: readonly string[] = [
  'agent-assisted, no prefix',
  'unverified',
];

/**
 * Does this persisted pain/admission reason describe an explicit Owner
 * statement — an Owner act that survives revocation? A reason carrying the
 * marker but also an agent-derived qualifier (legacy agent-assisted rows, or
 * a disclosure of unverified confirmation) is Agent-derived, not owner_manual.
 */
export function isOwnerExplicitStatementReason(reason: unknown): boolean {
  return typeof reason === 'string'
    && reason.includes(OWNER_EXPLICIT_STATEMENT_REASON_MARKER)
    && !AGENT_DERIVED_REASON_QUALIFIERS.some((qualifier) => reason.includes(qualifier));
}

/** logicalKey host prefixes, as produced by the codex/workbuddy adapters. */
const GOVERNANCE_LOGICAL_KEY_HOST_PREFIXES: ReadonlyMap<string, SourceMaterialHostKind> = new Map([
  ['codex|', 'codex'],
  ['wb|', 'workbuddy'],
]);

export function isGovernanceSourceRef(sourceRef: string): boolean {
  return sourceRef.startsWith(GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX);
}

/**
 * Map a sourceRef onto the host kind whose consent governs it.
 * `null` = not governed by the conversation-ingestion consent ledger
 * (owner-reported / candidate / openclaw inline references).
 * `'unknown'`-shape (parse failure on a governance ref) is expressed by the
 * caller denying via {@link governanceSourceRefHostState} instead.
 */
export function hostKindFromGovernanceSourceRef(sourceRef: string): SourceMaterialHostKind | null {
  if (!isGovernanceSourceRef(sourceRef)) return null;
  const logicalKey = sourceRef.slice(GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX.length);
  for (const [prefix, hostKind] of GOVERNANCE_LOGICAL_KEY_HOST_PREFIXES) {
    if (logicalKey.startsWith(prefix)) return hostKind;
  }
  return null;
}

/**
 * Authorization decision for ONE evidence sourceRef:
 *   - `not_governed`      → the ref is outside the consent ledger's scope;
 *   - `{ state }`         → the governing host's live authorization state.
 */
export type SourceRefAuthorization =
  | { readonly governed: false }
  | { readonly governed: true; readonly hostKind: SourceMaterialHostKind | null; readonly state: SourceAuthorizationState };

export function authorizeSourceRef(sourceRef: string, port: SourceMaterialAuthorizationPort): SourceRefAuthorization {
  const hostKind = hostKindFromGovernanceSourceRef(sourceRef);
  if (!isGovernanceSourceRef(sourceRef)) return { governed: false };
  if (hostKind === null) {
    // A ref that claims governance origin but cannot be attributed to a host
    // fails closed — an unattributable origin is never a grant (rc-2 posture).
    return {
      governed: true,
      hostKind: null,
      state: { authorized: false, reason: 'authorization_unavailable', detail: `unattributable governance sourceRef host: ${sourceRef.slice(0, 80)}` },
    };
  }
  return { governed: true, hostKind, state: port.isHostSourceMaterialAuthorized(hostKind) };
}

/** Minimal structural shape shared by every persisted evidence entry. */
export interface EvidenceEntryLike {
  readonly sourceRef: string;
  readonly note: string;
}

export interface EvidenceAuthorizationFilterResult<E extends EvidenceEntryLike> {
  /** Entries whose sources remain authorized (or were never governed). */
  readonly kept: readonly E[];
  /** Entries removed because their governing host's consent is not granted. */
  readonly removed: readonly E[];
  /** Distinct denial reasons encountered (for structured notes/telemetry). */
  readonly denialReasons: readonly SourceMaterialDenialReason[];
}

/**
 * Pure evidence filter — the one judgment every consumer reuses. Never throws
 * on malformed entries: a non-string/empty sourceRef is not a governance ref,
 * so the entry is treated as not governed (persisted shapes are untrusted,
 * rc-1/rc-2 — the schema boundary still validates on write).
 */
export function filterEvidenceByAuthorization<E extends EvidenceEntryLike>(
  entries: readonly E[],
  port: SourceMaterialAuthorizationPort,
): EvidenceAuthorizationFilterResult<E> {
  const kept: E[] = [];
  const removed: E[] = [];
  const denialReasons = new Set<SourceMaterialDenialReason>();
  for (const entry of entries) {
    const sourceRef = typeof entry?.sourceRef === 'string' ? entry.sourceRef : '';
    const decision = authorizeSourceRef(sourceRef, port);
    if (!decision.governed || decision.state.authorized) {
      kept.push(entry);
    } else {
      removed.push(entry);
      denialReasons.add(decision.state.reason);
    }
  }
  return { kept, removed, denialReasons: [...denialReasons] };
}

/**
 * Model-boundary assertion (TECH §2.2 ruling 5): does this list of sourceRefs
 * still contain governed-but-unauthorized material? Used for the LAST check
 * between assembly and the model call — a hit means the run must be blocked,
 * not filtered (the payload was already assembled; silently re-filtering here
 * would hide the race instead of honoring the revocation).
 */
export function findUnauthorizedSourceRef(sourceRefs: readonly string[], port: SourceMaterialAuthorizationPort): {
  sourceRef: string;
  reason: SourceMaterialDenialReason;
  hostKind: SourceMaterialHostKind | null;
} | null {
  for (const sourceRef of sourceRefs) {
    if (typeof sourceRef !== 'string') continue;
    const decision = authorizeSourceRef(sourceRef, port);
    if (decision.governed && !decision.state.authorized) {
      return { sourceRef, reason: decision.state.reason, hostKind: decision.hostKind };
    }
  }
  return null;
}
