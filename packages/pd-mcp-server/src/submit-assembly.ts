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
import { listGovernanceTurnTexts } from '@principles/host-runtime';
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
    const candidates = [claim.threadId, claim.sessionId].filter((value): value is string =>
      typeof value === 'string' && value.trim().length > 0);
    if (candidates.length === 0) {
      return { status: 'unverified', detail: 'host_session_claim_empty' };
    }
    for (const candidate of candidates) {
      const userTurns = listGovernanceTurnTexts({ workspaceDir, kind: 'user_turn', sessionId: candidate, limit: 1 });
      if (userTurns.ok && userTurns.turns.length > 0) {
        return { status: 'verified', sessionId: candidate };
      }
    }
    return { status: 'unverified', detail: 'host_session_not_in_workspace_trajectory' };
  };

  return {
    ok: true,
    call: ({ workspaceDir: boundWorkspaceDir, painId, taskId, submission }) => {
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
          ...(claim !== undefined
            ? { hostSessionClaim: claim, verifyHostSession: () => verifyHostSession(claim) }
            : {}),
        },
        submission,
      );
    },
  };
}
