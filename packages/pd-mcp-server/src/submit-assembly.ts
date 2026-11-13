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
import { submitPainCapability } from '@principles/core/runtime/pain-submit-capability';
import type { SubmitCapabilityCall } from './server.js';
import type { PdMcpHost } from './workspace.js';

export interface SubmitAssemblyResult {
  readonly ok: boolean;
  readonly call?: SubmitCapabilityCall;
  /** Sanitized reason category/aggregate — never a workspace path. */
  readonly reason?: string;
}

/**
 * Bind the Core submit capability to the workspace-effective PD config.
 * Called once at MCP startup; the returned function is what the tool handler
 * invokes per request.
 */
export function assembleSubmitCapability(
  workspaceDir: string,
  host: PdMcpHost,
): SubmitAssemblyResult {
  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    return {
      ok: false,
      reason: config.errors.map((entry) => entry.reason).join('; ') || 'pd_config_invalid',
    };
  }

  const stateDir = path.join(workspaceDir, '.state');
  const effectiveConfig = config.effective;

  return {
    ok: true,
    call: ({ workspaceDir: boundWorkspaceDir, painId, taskId, submission }) =>
      submitPainCapability(
        {
          workspaceDir: boundWorkspaceDir,
          stateDir,
          painId,
          taskId,
          hostKind: host,
          effectiveConfig,
          getEnvVar: (name: string) => process.env[name],
        },
        submission,
      ),
  };
}
