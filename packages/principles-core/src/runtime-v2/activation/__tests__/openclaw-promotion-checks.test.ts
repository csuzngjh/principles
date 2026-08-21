import { describe, expect, it } from 'vitest';
import { createProductionGateDeps } from '../production-gate-deps.js';
import { RuleHostWriter } from '../writers/rule-host-writer.js';
import { collectOpenClawPromotionChecks } from '../openclaw-promotion-checks.js';
import type { PIArtifactSnapshot } from '../activation-types.js';
import type { HostLivenessContract } from '../openclaw-promotion-checks.js';

const OPENCLAW_HOST_LIVENESS_CONTRACT: HostLivenessContract = {
  version: 'openclaw-legacy@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['bash'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['bash'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['bash'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'status', capabilityId: 'pd_status', toolName: 'bash', params: { command: 'pd status' }, expectedDecision: 'allow' },
    { probeId: 'deactivate', capabilityId: 'rulecode_deactivate', toolName: 'bash', params: { command: 'pd activation deactivate --activation-id test' }, expectedDecision: 'allow' },
    { probeId: 'pause', capabilityId: 'rulecode_global_pause', toolName: 'bash', params: { command: 'pd activation emergency-pause' }, expectedDecision: 'allow' },
    { probeId: 'review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

function artifact(id: string, implementationCode: string): PIArtifactSnapshot {
  return {
    artifactId: id,
    artifactKind: 'rule',
    sourceTaskId: `task-${id}`,
    sourcePrincipleId: 'principle-1',
    sourceRuleId: `rule-${id}`,
    lineageArtifactIds: ['parent-1'],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      implementationCode,
      goldenTrace: {
        traceId: `trace-${id}`,
        sourcePainId: 'pain-1',
        cases: [
          { caseId: 'negative', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
          { caseId: 'positive', kind: 'positive', toolName: 'edit_file', params: { path: '/workspace/safe.ts' }, expectedDecision: 'allow' },
        ],
        createdAt: '2026-08-21T00:00:00.000Z',
        version: 1,
      },
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['edit_file', 'bash'],
    }),
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

const safeCode = `function evaluate(input) {
  const risky = input.action.toolName === 'edit_file' && input.action.paramsSummary.path === '/etc/passwd';
  return { decision: risky ? 'block' : 'allow', matched: risky, reason: risky ? 'risk path' : 'neutral' };
}`;

const controlBlockingCode = `function evaluate(input) {
  const blocksControl = input.action.toolName === 'bash';
  const risky = input.action.toolName === 'edit_file' && input.action.paramsSummary.path === '/etc/passwd';
  return { decision: blocksControl || risky ? 'block' : 'allow', matched: blocksControl || risky, reason: blocksControl ? 'deny shell' : risky ? 'risk path' : 'neutral' };
}`;

describe('OpenClaw Host Liveness promotion checks', () => {
  const writer = new RuleHostWriter({ gateDeps: createProductionGateDeps() });

  it('runs neutral probes through production validation for the candidate and live composition', async () => {
    const checks = await collectOpenClawPromotionChecks(artifact('candidate', safeCode), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      existingLiveArtifacts: [artifact('live', controlBlockingCode)],
      validateProductionArtifact: value => writer.canActivate(value),
    });
    expect(checks.find(check => check.checkId === 'host_liveness_composition')).toEqual({
      checkId: 'host_liveness_composition',
      status: 'failed',
      reasonCode: 'neutral_probe_or_live_composition_failed',
    });
  });

  it('fails compatibility, emergency, shadow evidence, and composition when the adapter contract is unavailable', async () => {
    const checks = await collectOpenClawPromotionChecks(artifact('candidate', safeCode), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: null,
      existingLiveArtifacts: [],
      validateProductionArtifact: value => writer.canActivate(value),
    });
    expect(checks.filter(check => check.status === 'failed').map(check => check.checkId)).toEqual([
      'runtime_compatibility',
      'host_liveness_composition',
      'emergency_controls',
      'runtime_shadow_evidence',
    ]);
  });
});
