/**
 * Host-binding verification for the §8.4 handover (PRI-1282 Phase 4).
 *
 * Thin wrapper over the EXISTING authorized-discovery authorities
 * (`collectHostWorkspaceClaims` + `findForeignWorkspaceOwner`) — the handover
 * never invents a second binding source. A workspace is handover-eligible
 * when OpenClaw holds a VALIDATED claim (default dir / host declaration /
 * payload binding) and no OTHER host claims it.
 */
import * as fs from 'node:fs';
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
  /**
   * PRI-1282 review (P1-4): a binding file that could not be read or parsed
   * is NOT "no claim" — it means foreign ownership cannot be proven either
   * way, and the handover must fail closed. Lists the offending files.
   */
  readonly bindingUnverifiable: string | null;
}

export function collectHostWorkspaceClaimsFor(
  workspaceDir: string,
  homeDir: string,
  env?: Readonly<Record<string, string | undefined>>,
): HandoverBindingResult {
  const identity = resolveCoordinatorInstallIdentity(env ?? process.env, { trustedHomeDir: homeDir });
  if (!identity.ok) return { openclawClaimed: false, foreignOwner: 'install_identity_unresolved', bindingUnverifiable: null };
  const diagnostics: BindingReadDiagnostic[] = [];
  const options = claimOptionsFor(identity.identity, diagnostics);
  const claims = collectHostWorkspaceClaims(options);
  const canonical = path.resolve(workspaceDir);
  // Claims are matched by REAL-directory identity, not lexical spelling —
  // the manifest may hold an alias of the same directory (PRI-1282 review),
  // which is exactly the shape `findForeignWorkspaceOwner` resolves too.
  const identityOf = (candidate: string): string => {
    const lexical = path.resolve(candidate);
    let resolved = lexical;
    try {
      resolved = fs.realpathSync.native(lexical);
    } catch {
      // Best effort: a missing path compares lexically.
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const canonicalIdentity = identityOf(canonical);
  const samePath = (candidate: string): boolean => identityOf(candidate) === canonicalIdentity;
  const openclawClaimed = claims.some((claim) => claim.host === 'openclaw' && samePath(claim.workspaceDir));
  const foreign = findForeignWorkspaceOwner('openclaw', canonical, options);
  const foreignOwner = foreign.owners.length > 0 ? foreign.owners.join('+') : null;
  // PRI-1282 review (P1-4): an unreadable/malformed binding file was skipped
  // during claim collection — treat "cannot verify foreign ownership" as a
  // blocking fact, not as silence. The caller fails closed on this.
  const bindingUnverifiable = diagnostics.length > 0
    ? diagnostics.map((d) => `${d.file}(${d.status})`).join(', ')
    : null;
  return { openclawClaimed, foreignOwner, bindingUnverifiable };
}
