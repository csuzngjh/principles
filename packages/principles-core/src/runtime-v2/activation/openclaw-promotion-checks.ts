import type { PIArtifactSnapshot } from './activation-types.js';
import type { ToolSemanticRegistry } from '../internalization/tool-semantic-registry.js';
import type { PromotionReadinessCheck } from './promotion-readiness-evaluator.js';
import { validateRecoveryControlSurfaces, RECOVERY_CONTROL_SURFACES } from './recovery-control-surfaces.js';
import { verifyRecoveryProbeComposition } from './recovery-composition.js';

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
  /**
   * Review R3/P1: composition verification executes through the production
   * boundary (same hardened evaluator + mergeDecisions as the shared gate)
   * and needs the project root for path normalization, exactly like the
   * golden-trace replay does.
   */
  projectDir?: string;
  toolSemantics?: ToolSemanticRegistry;
  /**
   * Review R3/P1: target-environment reachability evidence for the recovery
   * controls, produced per readiness evaluation by the CALLER through a
   * bounded, non-destructive probe (never cached, never destructive):
   * - CLI channel: the caller spawns the real read-only status command and
   *   verifies it executes, parses, and reflects the TARGET workspace;
   * - console channel: the caller proves the control's durable substrate is
   *   reachable from this process (and the authenticated review route served
   *   this request) — the full HTTP entry path from the Owner's browser is
   *   e2e/isolated-test evidence, not something a server can self-assert.
   * Absent or failed evidence keeps emergency_controls FAILED — a registry
   * proof in code is not an environment health fact.
   */
  recoveryReachability?: RecoveryReachabilityEvidence;
  validateProductionArtifact(artifact: PIArtifactSnapshot): Promise<{ ok: boolean }>;
}

export interface RecoveryReachabilityEvidence {
  source: 'cli-status-probe' | 'console-store-probe';
  ok: boolean;
  /** The probe was observed to target the workspace this readiness run governs. */
  workspaceMatched: boolean;
  /** Bounded, structured detail for the failed case (rc-9). */
  detail?: string;
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
  // Review R3/P1: probe coverage is required for the RULE-INTERCEPTABLE
  // capabilities only (registry CLI channel). Console-channel recovery never
  // passes through the RuleHost gate, so its verification is not a rule
  // replay — probes for those capabilities are rejected by the registry
  // validator instead of demanded here.
  const cliProbeCapabilities = RECOVERY_CONTROL_SURFACES
    .filter(surface => surface.channel === 'cli')
    .map(surface => surface.capabilityId);
  if (!cliProbeCapabilities.every(capability => neutralProbeList.some(
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

  // Review R3/P1: composition verification runs through the PRODUCTION
  // composition boundary — every rule of the composed set compiled by the
  // same hardened evaluator production replay uses, evaluated on each
  // rule-interceptable probe input, merged by the same mergeDecisions the
  // shared gate uses. Per-artifact golden-trace replay alone is NOT
  // "composition verification" and is no longer described or used as one.
  let composition: ReturnType<typeof verifyRecoveryProbeComposition>;
  if (contract && scopeAvoidsProtectedCapabilities) {
    composition = verifyRecoveryProbeComposition({
      artifacts: [artifact, ...input.existingLiveArtifacts],
      probes: contract.neutralProbes.map(probe => ({ probeId: probe.probeId, toolName: probe.toolName, params: probe.params })),
      projectDir: input.projectDir ?? '.',
      ...(input.toolSemantics !== undefined ? { toolSemantics: input.toolSemantics } : {}),
    });
  } else if (contract) {
    composition = { ok: false, probeId: '__scope__', reason: 'artifact scope overlaps protected capabilities' };
  } else {
    // No validated contract → no verified composition (parity with the
    // pre-R3 probesPassed contract requirement).
    composition = { ok: false, probeId: '__contract__', reason: 'no validated host contract' };
  }

  // Review R3/P1: emergency controls are healthy only when ALL of the
  // following hold — the contract shape-bound to the resolver's version, the
  // safety flag on, every recovery entry verified against the REAL surface
  // registry, TARGET-ENVIRONMENT reachability evidence produced by this very
  // readiness evaluation (no cached "verified once" state), AND the composed
  // rule set (candidate + existing live) allows the rule-interceptable
  // recovery probes through the production merge boundary. Console-channel
  // controls are covered by registry + reachability + structural
  // independence (they never pass through the RuleHost gate; isolated-env
  // route tests prove the pause path and its effect on the gate).
  const reachability = input.recoveryReachability;
  const emergencyControlsHealthy = contract !== null
    && input.safetyControlsEnabled
    && recoverySurfaces !== null
    && recoverySurfaces.ok
    && reachability !== undefined
    && reachability.ok
    && reachability.workspaceMatched
    && composition.ok;
  const emergencyReason = contract === null
    ? 'out_of_band_controls_unavailable'
    : !input.safetyControlsEnabled
      ? 'safety_controls_disabled'
      : recoverySurfaces !== null && !recoverySurfaces.ok
        ? recoverySurfaces.reason
        : reachability === undefined || !reachability.ok || !reachability.workspaceMatched
          ? 'recovery_reachability_unverified'
          : 'control_probe_composition_failed';
  return [
    { checkId: 'bounded_scope', status: bounded ? 'passed' : 'failed', ...(!bounded ? { reasonCode: 'explicit_affected_tools_required' } : {}) },
    { checkId: 'runtime_compatibility', status: contract ? 'passed' : 'failed', ...(!contract ? { reasonCode: 'host_liveness_contract_missing_invalid_or_unsupported' } : {}) },
    { checkId: 'host_liveness_composition', status: composition.ok ? 'passed' : 'failed', ...(!composition.ok ? { reasonCode: composition.probeId.startsWith('__') ? `recovery_composition_${composition.probeId.slice(2)}` : 'recovery_probe_composition_blocked' } : {}) },
    { checkId: 'emergency_controls', status: emergencyControlsHealthy ? 'passed' : 'failed', ...(!emergencyControlsHealthy ? { reasonCode: emergencyReason } : {}) },
    { checkId: 'runtime_shadow_evidence', status: contract?.supportsShadowEvidence === true ? 'passed' : 'failed', ...(contract?.supportsShadowEvidence === true ? {} : { reasonCode: 'runtime_shadow_evidence_unsupported' }) },
    { checkId: 'owner_identity_configuration', status: input.ownerIdentityConfigured ? 'passed' : 'failed', ...(!input.ownerIdentityConfigured ? { reasonCode: 'configured_owner_missing' } : {}) },
  ];
}
