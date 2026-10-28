/**
 * SPEC-RULECODE-HOST-PROMOTION-001 — per-host shadow attribution (B3/H05)
 * and the host-contract version binding of the promotion shape validator (B).
 */
import { describe, expect, it } from 'vitest';
import { summarizeRuleCodeShadowEvents } from '../rulecode-shadow-summary.js';
import { collectOpenClawPromotionChecks } from '../openclaw-promotion-checks.js';
import type { PIArtifactSnapshot } from '../activation-types.js';
import type { HostLivenessContract } from '../openclaw-promotion-checks.js';

function shadowEntry(activationId: string, hostKind: string | undefined, decision: 'allow' | 'block' = 'allow', matched = false): unknown {
  return {
    type: 'rulehost_evaluated',
    category: 'evaluated',
    ts: '2026-10-28T10:00:00.000Z',
    data: {
      toolName: 'Bash',
      filePath: '/workspace/x.ts',
      matched,
      decision,
      activationId,
      activationMode: 'shadow',
      ...(hostKind !== undefined ? { hostKind } : {}),
    },
  };
}

describe('summarizeRuleCodeShadowEvents — per-host attribution (SPEC B3/H05)', () => {
  const activationId = 'act-attribution-1';
  const entries = [
    shadowEntry(activationId, 'codex'),
    shadowEntry(activationId, 'codex', 'allow', true),
    shadowEntry(activationId, 'openclaw'),
    shadowEntry(activationId, 'openclaw'),
    shadowEntry(activationId, 'openclaw'),
    shadowEntry(activationId, undefined), // pre-attribution legacy row
    shadowEntry('act-other', 'codex'),   // different activation — never counted
  ];

  it('counts ONLY the target host\'s samples when targetHostKind is supplied', () => {
    const codexSummary = summarizeRuleCodeShadowEvents(entries, activationId, 'codex');
    expect(codexSummary.observed).toBe(2);
    expect(codexSummary.matched).toBe(1);
    const openclawSummary = summarizeRuleCodeShadowEvents(entries, activationId, 'openclaw');
    expect(openclawSummary.observed).toBe(3);
  });

  it('H05: another host\'s samples and unattributed legacy rows can never satisfy the target host\'s threshold', () => {
    // Only OpenClaw + legacy rows exist for this activation — the Codex
    // threshold must stay empty rather than borrowing them.
    const openclawOnly = [
      shadowEntry(activationId, 'openclaw'),
      shadowEntry(activationId, 'openclaw'),
      shadowEntry(activationId, undefined),
    ];
    expect(summarizeRuleCodeShadowEvents(openclawOnly, activationId, 'codex')).toMatchObject({ observed: 0, matched: 0, neutralControl: 0 });
  });

  it('keeps the historical unfiltered aggregate when no target host is resolved (backward compatibility)', () => {
    const summary = summarizeRuleCodeShadowEvents(entries, activationId);
    expect(summary.observed).toBe(6);
  });
});

const BASE_CONTRACT: HostLivenessContract = {
  version: 'codex-v2@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['Bash'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'status', capabilityId: 'pd_status', toolName: 'Bash', params: { command: 'pd status' }, expectedDecision: 'allow' },
    { probeId: 'deactivate', capabilityId: 'rulecode_deactivate', toolName: 'Bash', params: { command: 'pd activation deactivate --activation-id test' }, expectedDecision: 'allow' },
    { probeId: 'pause', capabilityId: 'rulecode_global_pause', toolName: 'Bash', params: { command: 'pd activation emergency-pause' }, expectedDecision: 'allow' },
    { probeId: 'review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

function neutralArtifact(): PIArtifactSnapshot {
  return {
    artifactId: 'artifact-attribution',
    artifactKind: 'rule',
    sourceTaskId: 'task-attribution',
    sourcePrincipleId: 'principle-1',
    sourceRuleId: 'rule-attribution',
    lineageArtifactIds: ['parent-1'],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      implementationCode: 'export function evaluate(){ return { decision: "allow", matched: false, reason: "neutral" }; }',
      affectedTools: ['edit_file'],
    }),
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

describe('collectOpenClawPromotionChecks — host-contract version binding (SPEC B)', () => {
  it('accepts a per-host contract whose version matches the resolver\'s expectation', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: BASE_CONTRACT,
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'runtime_compatibility')?.status).toBe('passed');
  });

  it('rejects a shape-valid contract of the WRONG host version (no cross-host capability inheritance)', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: { ...BASE_CONTRACT, version: 'openclaw-legacy@1' },
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    const compatibility = checks.find(check => check.checkId === 'runtime_compatibility');
    expect(compatibility?.status).toBe('failed');
    expect(compatibility?.reasonCode).toBe('host_liveness_contract_missing_invalid_or_unsupported');
  });

  it('defaults to the OpenClaw legacy version for pre-existing callers (exact prior behavior)', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: { ...BASE_CONTRACT, version: 'openclaw-legacy@1' },
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'runtime_compatibility')?.status).toBe('passed');
  });
});
