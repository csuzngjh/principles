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
