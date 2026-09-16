import type { HostLivenessContract } from '@principles/core/runtime-v2';
import { loadHostToolDeclarations } from './host-tool-declaration.js';

/** Adapter-owned facts consumed by the non-bypassable RuleCode promotion gate. */
export const OPENCLAW_HOST_LIVENESS_CONTRACT: HostLivenessContract = {
  version: 'openclaw-legacy@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['bash', 'exec_command'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['bash', 'exec_command'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['bash', 'exec_command'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'probe-pd-status', capabilityId: 'pd_status', toolName: 'bash', params: { command: 'pd status' }, expectedDecision: 'allow' },
    { probeId: 'probe-rule-deactivate', capabilityId: 'rulecode_deactivate', toolName: 'bash', params: { command: 'pd activation deactivate --activation-id test' }, expectedDecision: 'allow' },
    { probeId: 'probe-global-pause', capabilityId: 'rulecode_global_pause', toolName: 'bash', params: { command: 'pd activation emergency-pause' }, expectedDecision: 'allow' },
    { probeId: 'probe-owner-review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

export type PromotionHostLivenessResolution =
  | {
      ok: true;
      hostKind: 'openclaw';
      hostContract: HostLivenessContract;
      hostRuntimeVersion: string;
    }
  | {
      ok: false;
      /** Stable machine-readable fail-closed reason (also surfaced as the hostRuntimeVersion marker in failure snapshots / capability reporting). */
      reason: 'host_declarations_unreadable' | 'promotion_host_unsupported' | 'multi_host_promotion_ambiguous';
      hostKinds: readonly string[];
      hostContract: null;
      hostRuntimeVersion: null;
      nextAction: string;
    };

/**
 * PRI-813: resolve the promotion host-liveness contract from the workspace's
 * REAL host declarations instead of unconditionally inheriting the OpenClaw
 * contract (which made Codex workspaces report runtime_compatibility /
 * runtime_shadow_evidence as passed — a false capability claim; the promotion
 * then only ever failed on sample count, hiding the unsupported truth).
 *
 * Resolution rules (fail closed outside the one host with an approved
 * capability authority):
 * - no host declared anything yet → OpenClaw contract (the historical
 *   governance default; nothing on the workspace contradicts it, and
 *   existing workspaces rely on it);
 * - only openclaw declared → OPENCLAW_HOST_LIVENESS_CONTRACT;
 * - only a non-openclaw host (e.g. codex) → promotion_host_unsupported
 *   (Codex promotion stays explicitly unsupported until an evidence-backed
 *   capability authority decision exists — no second host contract here);
 * - multiple hosts declared → multi_host_promotion_ambiguous (never guess a
 *   target host; the Owner decides host-selection policy separately).
 *
 * This function intentionally creates no Codex contract, no capability
 * registry, and no new store — it only routes the existing single authority
 * truthfully.
 */
export function resolvePromotionHostLiveness(workspaceDir: string): PromotionHostLivenessResolution {
  const loaded = loadHostToolDeclarations(workspaceDir);
  if (!loaded.ok) {
    if (loaded.reason === 'host_tool_declaration_missing') {
      // No host has declared itself on this workspace yet. Nothing contradicts
      // the historical OpenClaw governance assumption, and existing
      // workspaces rely on it — keep the OpenClaw contract (the loader never
      // guesses policy; this resolver is the deciding consumer).
      return {
        ok: true,
        hostKind: 'openclaw',
        hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
        hostRuntimeVersion: OPENCLAW_HOST_LIVENESS_CONTRACT.version,
      };
    }
    return {
      ok: false,
      reason: 'host_declarations_unreadable',
      hostKinds: [],
      hostContract: null,
      hostRuntimeVersion: null,
      nextAction: `repair the host tool declarations before promoting: ${loaded.reason} (${loaded.nextAction})`,
    };
  }
  const hostKinds = [...new Set(loaded.declarations.map(declaration => declaration.hostKind))].sort();
  const nonOpenClawKinds = hostKinds.filter(kind => kind !== 'openclaw');
  if (nonOpenClawKinds.length === 0) {
    return {
      ok: true,
      hostKind: 'openclaw',
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: OPENCLAW_HOST_LIVENESS_CONTRACT.version,
    };
  }
  if (hostKinds.length > 1) {
    return {
      ok: false,
      reason: 'multi_host_promotion_ambiguous',
      hostKinds,
      hostContract: null,
      hostRuntimeVersion: null,
      nextAction: `the workspace declares multiple hosts (${hostKinds.join(', ')}); promotion requires an unambiguous governing host — decide the promotion target host first`,
    };
  }
  return {
    ok: false,
    reason: 'promotion_host_unsupported',
    hostKinds,
    hostContract: null,
    hostRuntimeVersion: null,
    nextAction: `host '${hostKinds[0]}' has no approved promotion capability authority; promotion on this host is explicitly unsupported until an evidence-backed capability decision exists`,
  };
}
