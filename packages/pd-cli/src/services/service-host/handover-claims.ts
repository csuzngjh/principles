/**
 * Host-binding verification for the §8.4 handover (PRI-1282 Phase 4).
 *
 * Thin wrapper over the EXISTING authorized-discovery authorities
 * (`collectHostWorkspaceClaims` + `findForeignWorkspaceOwner`) — the handover
 * never invents a second binding source. A workspace is handover-eligible
 * when OpenClaw holds a VALIDATED claim (default dir / host declaration /
 * payload binding) and no OTHER host claims it.
 */
import * as path from 'node:path';
import { findForeignWorkspaceOwner, collectHostWorkspaceClaims } from '@principles/install-layout';
import { resolveCoordinatorInstallIdentity } from './install-identity.js';
import { claimOptionsFor } from './coordinator-common.js';
import type { BindingReadDiagnostic } from '@principles/install-layout';

export interface HandoverBindingResult {
  /** An OpenClaw claim (any of the three validated sources) names this workspace. */
  readonly openclawClaimed: boolean;
  /** Cross-host conflict owner(s); `null` when unambiguous. */
  readonly foreignOwner: string | null;
}

export function collectHostWorkspaceClaimsFor(
  workspaceDir: string,
  homeDir: string,
  env?: Readonly<Record<string, string | undefined>>,
): HandoverBindingResult {
  const identity = resolveCoordinatorInstallIdentity(env ?? process.env, { trustedHomeDir: homeDir });
  if (!identity.ok) return { openclawClaimed: false, foreignOwner: 'install_identity_unresolved' };
  const diagnostics: BindingReadDiagnostic[] = [];
  const options = claimOptionsFor(identity.identity, diagnostics);
  const claims = collectHostWorkspaceClaims(options);
  const canonical = path.resolve(workspaceDir);
  const samePath = (candidate: string): boolean => {
    const a = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    const b = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    return a === b;
  };
  const openclawClaimed = claims.some((claim) => claim.host === 'openclaw' && samePath(claim.workspaceDir));
  const foreign = findForeignWorkspaceOwner('openclaw', canonical, options);
  const foreignOwner = foreign.owners.length > 0 ? foreign.owners.join('+') : null;
  return { openclawClaimed, foreignOwner };
}
