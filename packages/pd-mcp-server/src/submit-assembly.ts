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
 */
import * as path from 'node:path';
import { loadPdConfigForPlugin } from '@principles/host-runtime/pd-config';
import { listGovernanceObservations, listGovernanceTurnTexts, readSourceMaterialAuthorization } from '@principles/host-runtime';
import { isSentinelSessionId } from '@principles/core/runtime';
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

function verifyCodexTarget(
  workspaceDir: string,
  meta: Readonly<Record<string, unknown>> | undefined,
  requestedTurnId: string | undefined,
): HostSessionVerification {
  // These fields travel alongside tools/call arguments in the Codex stdio
  // request. Model-supplied hostSession cannot stand in for them.
  const sessionId = readHostId(meta?.threadId) ?? readHostId(meta?.sessionId);
  const turnMeta = meta?.['x-codex-turn-metadata'];
  const parsedTurnMeta = turnMeta as { turn_id?: unknown } | null | undefined;
  const submissionTurnId = readHostId(
    typeof parsedTurnMeta === 'object' && parsedTurnMeta !== null && Object.hasOwn(parsedTurnMeta, 'turn_id')
      ? parsedTurnMeta.turn_id
      : undefined,
  );
  if (sessionId === undefined || submissionTurnId === undefined) {
    return { status: 'unverified', detail: 'codex_host_metadata_missing' };
  }
  const targetTurnId = requestedTurnId === undefined ? submissionTurnId : readHostId(requestedTurnId);
  if (targetTurnId === undefined) return { status: 'unverified', detail: 'codex_target_turn_invalid' };

  // PRI-1283 R2: target-turn evidence is codex conversation material —
  // check the LATEST consent BEFORE reading it. Revoked/not-granted consent
  // means no evidence read (fail closed), not a bounded read.
  const codexAuthorization = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'codex' });
  if (codexAuthorization.status === 'blocked') {
    return { status: 'unverified', detail: `codex_consent_${codexAuthorization.reason}` };
  }
  const result = listGovernanceObservations({
    workspaceDir, hostKind: 'codex', rolloutIdentity: sessionId, hostTurnId: targetTurnId, limit: 64,
  });
  if (!result.ok) return { status: 'unverified', detail: 'codex_target_evidence_unreadable' };
  const inputEvidence = result.observations.flatMap((row) =>
    (row.kind === 'user_turn' || row.kind === 'assistant_turn')
      && (row.retentionClass === 'operational' || row.retentionClass === 'promoted')
      && typeof row.visibleText === 'string' && row.visibleText.trim() !== ''
      ? [{ sourceRef: `governance_observation:${row.logicalKey}`, note: row.visibleText.slice(0, 2000) }]
      : [],
    // Rows come back in id (capture) order: slice(0, 12) keeps the EARLIEST
    // texts and drops the turn's final answer on long turns — keep the last.
  ).slice(-12);
  if (inputEvidence.length === 0) return { status: 'unverified', detail: 'codex_target_evidence_unavailable' };
  return { status: 'verified', sessionId, submissionTurnId, targetTurnId, inputEvidence };
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

  /**
   * PRI-1260: verify a host-provided session claim against THIS workspace's
   * own authorized trajectory store (the same consent-tiered store ingestion
   * writes). A claimed session that exists there — with retained turns — is
   * the strongest association PD can verify on its own authority; a session
   * that does not is a claim we do not bind (the submission stays legal and
   * unbound, with the specific cause surfaced on the receipt).
   */
  const verifyHostSession = (claim: HostSessionClaim): HostSessionVerification => {
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

  return {
    ok: true,
    call: ({ workspaceDir: boundWorkspaceDir, painId, taskId, submission, requestMeta }) => {
      const claim = submission.hostSession;
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
          ...(host === 'codex'
            ? { verifyHostSession: () => verifyCodexTarget(workspaceDir, requestMeta, submission.targetTurnId) }
            : claim !== undefined
              ? { hostSessionClaim: claim, verifyHostSession: () => verifyHostSession(claim) }
              : {}),
        },
        submission,
      );
    },
  };
}
