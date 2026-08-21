import type { PIArtifactSnapshot } from './activation-types.js';
import type { PromotionReadinessCheck } from './promotion-readiness-evaluator.js';

export interface HostLivenessContract {
  version: string;
  supportsShadowEvidence: boolean;
  outOfBandControls: readonly ('activation_deactivate' | 'global_rulecode_pause' | 'owner_review_console')[];
  protectedCapabilities: readonly {
    capabilityId: string;
    hostToolAliases: readonly string[];
  }[];
  neutralProbes: readonly {
    probeId: string;
    capabilityId: string;
    toolName: string;
    params: Readonly<Record<string, unknown>>;
    expectedDecision: 'allow';
  }[];
}

interface OpenClawPromotionCheckInput {
  ownerIdentityConfigured: boolean;
  safetyControlsEnabled: boolean;
  hostContract: unknown;
  existingLiveArtifacts: readonly PIArtifactSnapshot[];
  validateProductionArtifact(artifact: PIArtifactSnapshot): Promise<{ ok: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateHostContract(value: unknown): HostLivenessContract | null {
  if (!isRecord(value)) return null;
  const {outOfBandControls} = value;
  const {protectedCapabilities} = value;
  const {neutralProbes} = value;
  if (value.version !== 'openclaw-legacy@1'
    || value.supportsShadowEvidence !== true
    || !Array.isArray(outOfBandControls)
    || !Array.isArray(protectedCapabilities)
    || !Array.isArray(neutralProbes)) return null;
  const requiredControls = ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'] as const;
  if (!requiredControls.every(control => outOfBandControls.includes(control))) return null;
  const protectedIds = new Set<string>();
  const protectedCapabilityList: HostLivenessContract['protectedCapabilities'][number][] = [];
  for (const capability of protectedCapabilities) {
    if (!isRecord(capability) || !isNonEmptyString(capability.capabilityId)
      || !Array.isArray(capability.hostToolAliases)
      || !capability.hostToolAliases.every(isNonEmptyString)) return null;
    // RUNTIME_CONTRACT: hostToolAliases elements validated individually above.
    protectedCapabilityList.push({ capabilityId: capability.capabilityId, hostToolAliases: capability.hostToolAliases });
    protectedIds.add(capability.capabilityId);
  }
  const requiredCapabilities = ['pd_status', 'rulecode_deactivate', 'rulecode_global_pause', 'owner_review_access'] as const;
  if (!requiredCapabilities.every(capability => protectedIds.has(capability))) return null;
  const neutralProbeList: HostLivenessContract['neutralProbes'][number][] = [];
  for (const probe of neutralProbes) {
    if (!isRecord(probe) || !isNonEmptyString(probe.probeId)
      || !isNonEmptyString(probe.capabilityId) || !protectedIds.has(probe.capabilityId)
      || !isNonEmptyString(probe.toolName) || !isRecord(probe.params)
      || probe.expectedDecision !== 'allow') return null;
    neutralProbeList.push({
      probeId: probe.probeId,
      capabilityId: probe.capabilityId,
      toolName: probe.toolName,
      params: probe.params,
      expectedDecision: 'allow',
    });
  }
  if (!requiredCapabilities.every(capability => neutralProbeList.some(
    probe => probe.capabilityId === capability,
  ))) return null;
  return {
    version: 'openclaw-legacy@1',
    supportsShadowEvidence: true,
    outOfBandControls: requiredControls,
    protectedCapabilities: protectedCapabilityList,
    neutralProbes: neutralProbeList,
  };
}

function parseArtifactContent(artifact: PIArtifactSnapshot): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(artifact.contentJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function artifactWithNeutralProbes(
  artifact: PIArtifactSnapshot,
  contract: HostLivenessContract,
): PIArtifactSnapshot | null {
  const content = parseArtifactContent(artifact);
  if (!content || !isRecord(content.goldenTrace) || !Array.isArray(content.goldenTrace.cases)) return null;
  const cases = contract.neutralProbes.map(probe => ({
    caseId: `host-liveness:${probe.probeId}`,
    kind: 'positive',
    toolName: probe.toolName,
    params: { ...probe.params },
    expectedDecision: 'allow',
  }));
  const trace = {
    traceId: `${String(content.goldenTrace.traceId)}:host-liveness`,
    sourcePainId: String(content.goldenTrace.sourcePainId),
    cases: [...content.goldenTrace.cases, ...cases],
    createdAt: String(content.goldenTrace.createdAt),
    version: 1,
  };
  return { ...artifact, contentJson: JSON.stringify({ ...content, goldenTrace: trace }) };
}

export async function collectOpenClawPromotionChecks(
  artifact: PIArtifactSnapshot,
  input: OpenClawPromotionCheckInput,
): Promise<PromotionReadinessCheck[]> {
  const content = parseArtifactContent(artifact);
  const affectedTools = content && Array.isArray(content.affectedTools)
    ? content.affectedTools.filter(isNonEmptyString)
    : [];
  const bounded = affectedTools.length > 0
    && affectedTools.every(value => value !== '*' && value.toLowerCase() !== 'all');
  const protectedCapabilityIds = new Set([
    'pd_status', 'rulecode_deactivate', 'rulecode_global_pause', 'owner_review_access',
  ]);
  const scopeAvoidsProtectedCapabilities = bounded
    && affectedTools.every(value => !protectedCapabilityIds.has(value));
  const contract = validateHostContract(input.hostContract);

  let probesPassed = false;
  if (contract && scopeAvoidsProtectedCapabilities) {
    probesPassed = true;
    for (const candidate of [artifact, ...input.existingLiveArtifacts]) {
      const withProbes = artifactWithNeutralProbes(candidate, contract);
      if (!withProbes || !(await input.validateProductionArtifact(withProbes)).ok) {
        probesPassed = false;
        break;
      }
    }
  }

  const emergencyControlsHealthy = contract !== null && input.safetyControlsEnabled;
  return [
    { checkId: 'bounded_scope', status: bounded ? 'passed' : 'failed', ...(!bounded ? { reasonCode: 'explicit_affected_tools_required' } : {}) },
    { checkId: 'runtime_compatibility', status: contract ? 'passed' : 'failed', ...(!contract ? { reasonCode: 'host_liveness_contract_missing_invalid_or_unsupported' } : {}) },
    { checkId: 'host_liveness_composition', status: probesPassed ? 'passed' : 'failed', ...(!probesPassed ? { reasonCode: 'neutral_probe_or_live_composition_failed' } : {}) },
    { checkId: 'emergency_controls', status: emergencyControlsHealthy ? 'passed' : 'failed', ...(!emergencyControlsHealthy ? { reasonCode: contract ? 'safety_controls_disabled' : 'out_of_band_controls_unavailable' } : {}) },
    { checkId: 'runtime_shadow_evidence', status: contract?.supportsShadowEvidence === true ? 'passed' : 'failed', ...(contract?.supportsShadowEvidence === true ? {} : { reasonCode: 'runtime_shadow_evidence_unsupported' }) },
    { checkId: 'owner_identity_configuration', status: input.ownerIdentityConfigured ? 'passed' : 'failed', ...(!input.ownerIdentityConfigured ? { reasonCode: 'configured_owner_missing' } : {}) },
  ];
}
