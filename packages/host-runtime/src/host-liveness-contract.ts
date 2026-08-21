import type { HostLivenessContract } from '@principles/core/runtime-v2';

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
