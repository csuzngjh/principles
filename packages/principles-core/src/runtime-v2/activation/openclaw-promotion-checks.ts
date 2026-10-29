import type { PIArtifactSnapshot } from './activation-types.js';
import type { PromotionReadinessCheck } from './promotion-readiness-evaluator.js';
import { validateRecoveryControlSurfaces } from './recovery-control-surfaces.js';

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
  /**
   * SPEC-RULECODE-HOST-PROMOTION-001 B: the contract version the workspace
   * host resolver handed out for THIS promotion target. The shape validator
   * only accepts a contract whose version matches — a Codex (or WorkBuddy)
   * workspace can no longer present the OpenClaw legacy contract (or vice
   * versa) as its capability authority. Defaults to the OpenClaw legacy
   * version so pre-existing callers keep their exact behavior.
   */
  expectedHostContractVersion?: string;
  existingLiveArtifacts: readonly PIArtifactSnapshot[];
  validateProductionArtifact(artifact: PIArtifactSnapshot): Promise<{ ok: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const DEFAULT_HOST_CONTRACT_VERSION = 'openclaw-legacy@1';

function validateHostContract(value: unknown, expectedVersion: string): HostLivenessContract | null {
  if (!isRecord(value)) return null;
  const {outOfBandControls} = value;
  const {protectedCapabilities} = value;
  const {neutralProbes} = value;
  if (value.version !== expectedVersion
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
    version: expectedVersion,
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
  const contract = validateHostContract(
    input.hostContract,
    input.expectedHostContractVersion ?? DEFAULT_HOST_CONTRACT_VERSION,
  );
  // Review R1 (SPEC-RULECODE-HOST-PROMOTION-001): the contract SHAPE alone
  // never certifies control health. Validate its recovery entries against the
  // real-surface registry (command/route registrations proven by the
  // cross-package contract tests that import it).
  const recoverySurfaces = contract !== null ? validateRecoveryControlSurfaces(contract) : null;

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

  // Review R1: emergency controls are healthy only when ALL of the following
  // hold — the contract shape-bound to the resolver's version, the safety
  // flag on, every recovery entry verified against the REAL surface registry,
  // AND the composed rule set (candidate + existing live) still allows the
  // control probes (a rule combination that blocks a recovery action must
  // fail readiness even when each rule passes individually-composed replay
  // of its own trace).
  const emergencyControlsHealthy = contract !== null
    && input.safetyControlsEnabled
    && recoverySurfaces !== null
    && recoverySurfaces.ok
    && probesPassed;
  const emergencyReason = contract === null
    ? 'out_of_band_controls_unavailable'
    : !input.safetyControlsEnabled
      ? 'safety_controls_disabled'
      : recoverySurfaces !== null && !recoverySurfaces.ok
        ? recoverySurfaces.reason
        : 'control_probe_composition_failed';
  return [
    { checkId: 'bounded_scope', status: bounded ? 'passed' : 'failed', ...(!bounded ? { reasonCode: 'explicit_affected_tools_required' } : {}) },
    { checkId: 'runtime_compatibility', status: contract ? 'passed' : 'failed', ...(!contract ? { reasonCode: 'host_liveness_contract_missing_invalid_or_unsupported' } : {}) },
    { checkId: 'host_liveness_composition', status: probesPassed ? 'passed' : 'failed', ...(!probesPassed ? { reasonCode: 'neutral_probe_or_live_composition_failed' } : {}) },
    { checkId: 'emergency_controls', status: emergencyControlsHealthy ? 'passed' : 'failed', ...(!emergencyControlsHealthy ? { reasonCode: emergencyReason } : {}) },
    { checkId: 'runtime_shadow_evidence', status: contract?.supportsShadowEvidence === true ? 'passed' : 'failed', ...(contract?.supportsShadowEvidence === true ? {} : { reasonCode: 'runtime_shadow_evidence_unsupported' }) },
    { checkId: 'owner_identity_configuration', status: input.ownerIdentityConfigured ? 'passed' : 'failed', ...(!input.ownerIdentityConfigured ? { reasonCode: 'configured_owner_missing' } : {}) },
  ];
}
