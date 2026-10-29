import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCliRecoveryCapabilities } from '@principles/host-runtime';
import type { RecoveryCapabilityEvidence } from '@principles/core/runtime-v2';

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 R3/R4: CLI-channel recovery reachability
 * for the pd-cli readiness path. Thin wrapper — the real subprocess probes
 * live in host-runtime (`probeCliRecoveryCapabilities`) so the Console
 * readiness assembly reuses the SAME implementation. This wrapper only
 * resolves the built pd CLI entry for the CURRENT environment and fails
 * closed (all capabilities not-verified) when it cannot.
 *
 * Evidence semantics (R4/P1): the CLI subprocess channel can prove
 * `pd_status` and `rulecode_deactivate` (real `--dry-run` validation path —
 * no audit write, no mutation); the console-channel capabilities are
 * reported NOT-VERIFIED with the precise reason — never fabricated as ok.
 */

export { DEACTIVATE_DRY_RUN_PROBE_ACTIVATION_ID } from '@principles/host-runtime';

function resolveCliEntry(): string | null {
  // Built layout: dist/commands/<this>.js with the entry at dist/index.js.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'index.js'),
    path.resolve(process.cwd(), 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Probe the CLI-channel recovery capabilities against the target workspace.
 * When `expectedActivationId` is supplied, pd_status additionally requires
 * that activation to appear in the listing — proof the probe targeted the
 * governed workspace, not merely some workspace.
 */
export async function probeCliRecoveryReachability(workspaceDir: string, expectedActivationId?: string, options?: { timeoutMs?: number }): Promise<RecoveryCapabilityEvidence[]> {
  const cliEntry = resolveCliEntry();
  if (cliEntry === null) {
    return [
      { capabilityId: 'pd_status', channel: 'cli', ok: false, workspaceMatched: false, detail: 'pd CLI entry not found (built entry missing in this environment)' },
      { capabilityId: 'rulecode_deactivate', channel: 'cli', ok: false, workspaceMatched: false, detail: 'pd CLI entry not found (built entry missing in this environment)' },
      { capabilityId: 'rulecode_global_pause', channel: 'console', ok: false, workspaceMatched: false, detail: 'console-channel control: verifying the HTTP-only recovery entry requires the Owner Console process; a CLI subprocess cannot produce this evidence' },
      { capabilityId: 'owner_review_access', channel: 'console', ok: false, workspaceMatched: false, detail: 'console-channel control: verifying the HTTP-only recovery entry requires the Owner Console process; a CLI subprocess cannot produce this evidence' },
    ];
  }
  return probeCliRecoveryCapabilities({ cliEntry, workspaceDir, ...(expectedActivationId !== undefined ? { expectedActivationId } : {}), ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
}
