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
import { listGovernanceObservations, listGovernanceTurnTexts } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig, isSentinelSessionId } from '@principles/core/runtime';
import {
  hostSessionClaimConflictsWithContext,
  resolveHostSubmissionContext,
} from '@principles/core/runtime';
import type { PainEvidenceEntry } from '@principles/core/runtime';
import { submitPainCapability, type HostSessionClaim, type HostSessionVerification } from '@principles/core/runtime/pain-submit-capability';
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
 * PRI-1274: opportunistic target-turn evidence. BOUNDED read of this
 * workspace's authorized governance observations for the target turn — used
 * ONLY as an enrichment when the turn text happens to already exist. Its
 * absence never blocks session binding (the B1 decoupling); target-evidence
 * completion is the diagnosis pipeline's independent concern (PRI-1273).
 */
function readTargetTurnEvidence(workspaceDir: string, sessionId: string, targetTurnId: string): PainEvidenceEntry[] {
  const result = listGovernanceObservations({
    workspaceDir, hostKind: 'codex', rolloutIdentity: sessionId, hostTurnId: targetTurnId, limit: 64,
  });
  if (!result.ok) return [];
  return result.observations.flatMap((row) =>
    (row.kind === 'user_turn' || row.kind === 'assistant_turn')
      && (row.retentionClass === 'operational' || row.retentionClass === 'promoted')
      && typeof row.visibleText === 'string' && row.visibleText.trim() !== ''
      ? [{ sourceRef: `governance_observation:${row.logicalKey}`, note: row.visibleText.slice(0, 2000) }]
      : [],
    // Rows come back in id (capture) order: slice(0, 12) keeps the EARLIEST
    // texts and drops the turn's final answer on long turns — keep the last.
  ).slice(-12);
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
  // PRI-1274: the Workspace-level minimal identity-metadata authorization,
  // resolved ONCE at startup from the same effective config every consumer
  // reads. Off (the default) keeps every submission legally unbound with
  // `blocked_by_consent` — identity metadata is never persisted from the
  // trusted `_meta` path while the disclosure authorization is absent.
  const { flags } = computeFeatureFlagsFromConfig(effectiveConfig);
  const minimalMetadataGranted = flags.host_identity_minimal_metadata?.enabled === true;

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
      return { status: 'unverified', detail: 'host_session_claim_empty' };
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
    const inputEvidence = targetTurnId === undefined
      ? []
      : readTargetTurnEvidence(workspaceDir, context.sessionId, targetTurnId);

    return {
      status: 'verified',
      sessionId: context.sessionId,
      ...(context.submissionTurnId === undefined ? {} : { submissionTurnId: context.submissionTurnId }),
      ...(targetTurnId === undefined ? {} : { targetTurnId }),
      ...(inputEvidence.length > 0 ? { inputEvidence } : {}),
    };
  };

  return {
    ok: true,
    call: ({ workspaceDir: boundWorkspaceDir, painId, taskId, submission, requestMeta }) => {
      // One resolution seam for every host: the trusted `_meta` context when
      // present, the legal unbound reason when not. Codex never consults
      // model-supplied claims (its identity is host meta or unbound).
      const verification = resolveSessionVerification(requestMeta, submission);
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
