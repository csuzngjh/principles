/**
 * `pd_submit_pain` production assembly for all three PD hosts.
 *
 * OG-4 was authorized by the Owner on 2026-11-13; the scope was extended to
 * Codex / OpenClaw / WorkBuddy the same day (decision card r6). The gate
 * itself stays in `server.ts` (default `false`, no env var / feature flag can
 * turn it on); THIS module is the host wrapper that opts in correctly.
 *
 * `server.ts` refuses to register the write tool without an injected
 * capability bound to an EFFECTIVE `.pd/config.yaml`. Without
 * `effectiveConfig`, the Core capability would fall back to the deprecated
 * `.state/workflows.yaml` resolver (PRI-393 forbids that on production paths).
 * Config loading is therefore delegated to `@principles/host-runtime/pd-config`
 * — the same authority the CLI and hooks use — so no second config
 * implementation exists here. A malformed config degrades the host to
 * recall-only instead of writing through an unevaluated configuration.
 *
 * The business write still goes EXCLUSIVELY through the Gate 3 capability
 * public subpath, keeping the G4-2 architecture guard intact. `hostKind` is
 * observability-only in Core (never used for admission or mode), but it is
 * taken from the validated startup binding rather than hard-coded so each
 * host's records remain attributable.
 *
 * PRI-1274 (B1) — submission identity resolution, in priority order:
 *  1. TRUSTED `tools/call` `_meta` injected by the host that started this
 *     server against the startup workspace binding (never model parameters):
 *     pre-bound at the ORIGINAL Pain/Task write, with NO requirement that the
 *     target turn text has been collected. A model-supplied `hostSession`
 *     conflicting with the trusted context fails closed (unbound, conflict
 *     reason). Gated by the `host_identity_minimal_metadata` Workspace
 *     authorization (off → unbound `blocked_by_consent`).
 *  2. Metadata missing → the legal unbound save with an explicit reason
 *     (`codex_host_metadata_missing` on Codex — the receipt-fallback
 *     territory); non-Codex hosts keep the PRI-1260 legacy path (model claim
 *     verified against this workspace's own authorized trajectory).
 */
import * as path from 'node:path';
import { loadPdConfigForPlugin } from '@principles/host-runtime/pd-config';
import { listGovernanceConversationTextsForHostTurn, listGovernanceTurnTexts, readSourceMaterialAuthorization } from '@principles/host-runtime';
import {
  computeFeatureFlagsFromConfig,
  hostSessionClaimConflictsWithContext,
  isSentinelSessionId,
  resolveHostSubmissionContext,
  type TargetTurnEvidenceRead,
} from '@principles/core/runtime';
import { hostSessionVerificationToAssociation, submitPainCapability, type HostSessionClaim, type HostSessionVerification } from '@principles/core/runtime/pain-submit-capability';
import type { SubmitCapabilityCall } from './server.js';
import type { PdMcpHost } from './workspace.js';

export interface SubmitAssemblyResult {
  readonly ok: boolean;
  readonly call?: SubmitCapabilityCall;
  /**
   * Fixed, closed reason code — the ONLY failure detail safe to log. The
   * loader's raw `reason` strings can embed absolute config paths (fs errors)
   * or config fragments (YAML parser errors), and the MCP log contract
   * forbids both. Never log `errors[].reason` from here.
   */
  readonly reasonCode?: 'pd_config_invalid';
  /** How many config problems were found (a number leaks nothing). */
  readonly errorCount?: number;
}

function readHostId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= 200 && !isSentinelSessionId(id) ? id : undefined;
}

/**
 * PRI-1274 review round 2 (directive K1): the target-turn evidence read is
 * STRUCTURED, not a silent empty array. The classification rides the existing
 * evidence-availability vocabulary of the ingress contract (`available` /
 * `unavailable` with a reason code); causes:
 *   - available: turn rows with readable text were collected;
 *   - not_found: the store read succeeded but has no readable text for the
 *                requested (session, turn); this is an honest "not yet there";
 *   - blocked_by_consent: the latest source-material decision denies the read;
 *                preserve minimal identity, but block diagnosis;
 *   - read_failed: the store read itself failed (structured stderr note);
 *                submission remains legal; enrichment is optional.
 *
 * PRI-1273: the type moved to Core (`pain-target-evidence-reconcile.ts`) so
 * the submit-time enrichment and the worker reconcile's backfill share ONE
 * vocabulary — the entries shape both paths persist must never drift.
*/

/**
 * PRI-1274: opportunistic target-turn evidence. Bounded read of this
 * workspace's authorized governance observations for the target turn, used
 * only as enrichment when the turn text already exists. Its absence never
 * blocks session binding; target-evidence completion is independent.
 *
 * PRI-1283 R2: check the current consent-ledger decision immediately before
 * the read. Missing, pending, failed, revoked or unreadable consent produces
 * no query and no transcript text; the original submission remains legal
 * with empty enrichment evidence.
 */
function readTargetTurnEvidence(input: {
  readonly workspaceDir: string;
  readonly host: PdMcpHost;
  readonly sessionId: string;
  readonly targetTurnId: string;
}): TargetTurnEvidenceRead {
  const authorization = readSourceMaterialAuthorization({
    workspaceDir: input.workspaceDir,
    hostKind: input.host,
  });
  if (authorization.status === 'blocked') {
    console.error('[pd-submit] target-turn evidence read blocked: ' + authorization.reason + '; submission continues without turn evidence');
    return { status: 'blocked_by_consent', reason: authorization.reason };
  }
  try {
    // PRI-1273 (devin BUG_0002): the shared exact-turn selection rule — the
    // turn's LAST readable conversational rows, not a generic early window.
    const result = listGovernanceConversationTextsForHostTurn({
      workspaceDir: input.workspaceDir,
      hostKind: input.host,
      rolloutIdentity: input.sessionId,
      hostTurnId: input.targetTurnId,
      limit: 12,
    });
    if (!result.ok) {
      console.error('[pd-submit] target-turn evidence read degraded: read_failed (' + result.reason + '); submission continues without turn evidence');
      return { status: 'read_failed', reason: result.reason };
    }
    const entries = result.rows.map((row) => ({
      sourceRef: 'governance_observation:' + row.logicalKey,
      note: row.visibleText.slice(0, 2000),
    }));
    return entries.length > 0
      ? { status: 'available', entries }
      : { status: 'not_found' };
  } catch (error) {
    console.error('[pd-submit] target-turn evidence read degraded: read_failed (store exception); submission continues without turn evidence');
    return { status: 'read_failed', reason: error instanceof Error ? error.message.slice(0, 120) : 'store_exception' };
  }
}

/**
 * Bind the Core submit capability to the workspace-effective PD config.
 * Called once at MCP startup; the returned function is what the tool handler
 * invokes per request.
 *
 * `env` is the same env `main()` resolved the binding from — never
 * `process.env` directly — so a test-injected env stays authoritative.
 */
export function assembleSubmitCapability(
  workspaceDir: string,
  host: PdMcpHost,
  env: Record<string, unknown> = process.env,
): SubmitAssemblyResult {
  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    return {
      ok: false,
      reasonCode: 'pd_config_invalid',
      errorCount: config.errors.length,
    };
  }

  const stateDir = path.join(workspaceDir, '.state');
  const effectiveConfig = config.effective;
  // PRI-1274: the Workspace-level minimal identity-metadata authorization
  // gates identity persistence off the trusted `_meta` path; PRI-1275 review
  // round (Devin) moved the EFFECTIVE verdict to a PER-REQUEST re-read (see
  // the call closure) so a revocation stops binding without a server
  // restart. The startup read stays as the config health gate only.

  /**
   * PRI-1260 legacy path (non-Codex hosts without `_meta` producers yet —
   * PRI-1275/1276 wire those): verify a host-provided session claim against
   * THIS workspace's own authorized trajectory store (the same consent-tiered
   * store ingestion writes). A claimed session that exists there — with
   * retained turns — is the strongest association PD can verify on its own
   * authority; a session that does not is a claim we do not bind (the
   * submission stays legal and unbound, with the specific cause surfaced on
   * the receipt).
   */
  const verifyHostSessionClaim = (claim: HostSessionClaim): HostSessionVerification => {
    // Review fix (2026-11-18): sentinel spellings (`cli` / `unknown`) are
    // rejected by the read-back ingress parser (`ingress_verified_session_invalid`)
    // — a claim that only carries a sentinel must stay UNBOUND here, or the
    // submitted task would fail its own read-back validation. HostKind keeps
    // the lookup per-host: session ids are unique per `(host_kind,
    // rollout_identity)`, so another host's trajectory must never verify this
    // host's claim (the same cross-host class PRI-1247 closes).
    const candidates = [claim.threadId, claim.sessionId].filter((value): value is string =>
      typeof value === 'string' && value.trim().length > 0 && !isSentinelSessionId(value.trim()));
    if (candidates.length === 0) {
      // A claim carrying ONLY empty/sentinel spellings is a claim the model
      // DID make and this gate REJECTS — NOT the "no metadata at all" state.
      // The distinct cause keeps it outside the P1-2 recoverable whitelist:
      // a specific (untrusted) claim existed and was refused, so the
      // PostToolUse receipt fallback must never overturn that refusal
      // (PRI-1275 review round; `host_session_claim_empty` is reserved for
      // the caller supplying NO claim).
      return { status: 'unverified', detail: 'host_session_claim_unusable' };
    }
    // PRI-1283 R2: the probe READS retained conversation text — the latest
    // consent must be granted. Blocked consent leaves the submission legal
    // but unbound (no conversation read happens at all).
    const hostAuthorization = readSourceMaterialAuthorization({ workspaceDir, hostKind: host });
    if (hostAuthorization.status === 'blocked') {
      return { status: 'unverified', detail: `host_consent_${hostAuthorization.reason}` };
    }
    for (const candidate of candidates) {
      const userTurns = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: candidate, hostKind: host, limit: 1 });
      if (userTurns.ok && userTurns.turns.length > 0) {
        return { status: 'verified', sessionId: candidate };
      }
    }
    return { status: 'unverified', detail: 'host_session_not_in_workspace_trajectory' };
  };

  /**
   * PRI-1274 (B1): per-request submission-identity resolution. The trusted
   * `_meta` context (host-injected on the `tools/call` request this server
   * serves over its startup binding) pre-binds the session BEFORE the write;
   * target-turn text availability is NOT a precondition (the decoupling this
   * ticket exists for). Every negative outcome keeps the submission legal
   * and unbound with a specific cause on the receipt (rc-9).
   */
  const resolveSessionVerification = (
    requestMeta: Readonly<Record<string, unknown>> | undefined,
    submission: { readonly targetTurnId?: string; readonly hostSession?: HostSessionClaim },
    /** PRI-1275 review round: resolved PER REQUEST by the caller (see the
     * call closure) so a Workspace-side revocation stops binding on the next
     * submission without an MCP server restart (Stage 3 acceptance). */
    minimalMetadataGranted: boolean,
  ): HostSessionVerification => {
    const metaResolution = resolveHostSubmissionContext(host, requestMeta);

    if (metaResolution.status === 'invalid') {
      // Malformed host metadata never silently degrades into a trusted
      // identity and never falls back to model parameters (fail closed).
      return { status: 'unverified', detail: `host_context_invalid:${metaResolution.reasonCode}` };
    }

    if (metaResolution.status === 'missing') {
      if (host === 'codex') {
        // Codex identity comes from host meta only — a model-supplied claim
        // never stands in. Unbound with the explicit cause; the PostToolUse
        // structured receipt (codex-adapter) is the designated fallback.
        return { status: 'unverified', detail: 'codex_host_metadata_missing' };
      }
      const claim = submission.hostSession;
      if (claim === undefined) return { status: 'unverified', detail: 'host_session_claim_empty' };
      return verifyHostSessionClaim(claim);
    }

    const { context } = metaResolution;
    // Model-visible parameters conflicting with the trusted context fail
    // closed: never bind from either side of a disagreement.
    if (hostSessionClaimConflictsWithContext(submission.hostSession, context)) {
      return { status: 'unverified', detail: 'host_context_conflict' };
    }
    if (!minimalMetadataGranted) {
      return { status: 'unverified', detail: 'blocked_by_consent' };
    }

    // Explicit target-turn request (validated shape; an invalid explicit
    // target stays unverified — the caller named something unusable).
    const requestedTurnId = submission.targetTurnId === undefined
      ? undefined
      : readHostId(submission.targetTurnId);
    if (submission.targetTurnId !== undefined && requestedTurnId === undefined) {
      return { status: 'unverified', detail: 'codex_target_turn_invalid' };
    }
    // Existing current-turn semantics (tool description: "省略时以提交轮为
    // 目标"): when the host supplied a submission turn and the caller named
    // no explicit target, the submission turn IS the target. Without a
    // submission turn and without an explicit target the target stays
    // unknown — the session binding survives (SPEC §G2).
    const targetTurnId = requestedTurnId ?? context.submissionTurnId;
    // Directive K2: only available carries entries. not_found keeps the
    // exact-target wait semantics; blocked_by_consent preserves the separately
    // authorized identity but marks the task blocked (not waiting); read_failed
    // remains an observable enrichment failure, distinct from both outcomes.
    const evidenceRead = targetTurnId === undefined
      ? undefined
      : readTargetTurnEvidence({ workspaceDir, host, sessionId: context.sessionId, targetTurnId });
    const inputEvidence = evidenceRead !== undefined && evidenceRead.status === 'available'
      ? evidenceRead.entries
      : [];
    const targetEvidenceBlockedReason = evidenceRead?.status === 'blocked_by_consent'
      ? evidenceRead.reason
      : undefined;

    return {
      status: 'verified',
      sessionId: context.sessionId,
      ...(context.submissionTurnId === undefined ? {} : { submissionTurnId: context.submissionTurnId }),
      ...(targetTurnId === undefined ? {} : { targetTurnId }),
      ...(inputEvidence.length > 0 ? { inputEvidence } : {}),
      ...(targetEvidenceBlockedReason === undefined ? {} : { targetEvidenceBlockedReason }),
    };
  };

  return {
    ok: true,
    call: ({ workspaceDir: boundWorkspaceDir, painId, taskId, submission, requestMeta, observeSessionAssociation }) => {
      // PRI-1275 review round (Devin): the minimal identity authorization is
      // resolved PER REQUEST from the CURRENT workspace config — a Workspace
      // admin revoking `host_identity_minimal_metadata` stops binding on the
      // next submission without waiting for an MCP server restart (Stage 3:
      // "最小授权撤回…时拒绝身份写入"). A config re-read failure fails closed
      // for the identity path (rc-9 note) while the submission itself stays
      // legal.
      let minimalMetadataGranted = false;
      const liveConfig = loadPdConfigForPlugin(boundWorkspaceDir);
      if (liveConfig.ok) {
        minimalMetadataGranted =
          computeFeatureFlagsFromConfig(liveConfig.effective).flags.host_identity_minimal_metadata?.enabled === true;
      } else {
        console.error('[pd-submit] identity authorization re-read failed: pd_config_invalid; identity binding fails closed for this request');
      }
      // One resolution seam for every host: the trusted `_meta` context when
      // present, the legal unbound reason when not. Codex never consults
      // model-supplied claims (its identity is host meta or unbound).
      const verification = resolveSessionVerification(requestMeta, submission, minimalMetadataGranted);
      // The deadline wrapper observes the verdict resolved for THIS request.
      // If the write outlives the MCP deadline, the timeout receipt can carry
      // the same association cause instead of losing the security boundary.
      observeSessionAssociation?.(hostSessionVerificationToAssociation(verification));
      return submitPainCapability(
        {
          workspaceDir: boundWorkspaceDir,
          stateDir,
          painId,
          taskId,
          hostKind: host,
          effectiveConfig,
          getEnvVar: (name: string) => {
            const value = env[name];
            return typeof value === 'string' ? value : undefined;
          },
          verifyHostSession: () => verification,
        },
        submission,
      );
    },
  };
}
