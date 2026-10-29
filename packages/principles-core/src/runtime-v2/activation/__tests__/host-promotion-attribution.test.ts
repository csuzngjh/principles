/**
 * SPEC-RULECODE-HOST-PROMOTION-001 — per-host shadow attribution (B3/H05)
 * and the host-contract version binding of the promotion shape validator (B).
 */
import { describe, expect, it } from 'vitest';
import { summarizeRuleCodeShadowEvents } from '../rulecode-shadow-summary.js';
import { collectOpenClawPromotionChecks } from '../openclaw-promotion-checks.js';
import { validateRecoveryControlSurfaces } from '../recovery-control-surfaces.js';
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

  // ── Review finding 3 (P2): unhealthy events must pass the host filter too ──

  function unhealthyEntry(activationId: string, hostKind: string | undefined): unknown {
    return {
      type: 'rulehost_unhealthy',
      category: 'failure',
      ts: '2026-10-28T10:00:00.000Z',
      data: {
        activationId,
        ...(hostKind !== undefined ? { hostKind } : {}),
      },
    };
  }

  it('R3-red→green: a foreign-host rulehost_unhealthy event must not pollute the target host\'s error count', () => {
    // Exact reviewer reproducer: workbuddy unhealthy + codex target.
    const summary = summarizeRuleCodeShadowEvents(
      [{ type: 'rulehost_unhealthy', data: { activationId, hostKind: 'workbuddy' } }],
      activationId,
      'codex',
    );
    expect(summary.errors).toBe(0);
    expect(summary.observed).toBe(0);
  });

  it('R3: an unattributed unhealthy event counts toward NO host when a target is specified', () => {
    expect(summarizeRuleCodeShadowEvents([unhealthyEntry(activationId, undefined)], activationId, 'codex').errors).toBe(0);
    expect(summarizeRuleCodeShadowEvents([unhealthyEntry(activationId, undefined)], activationId, 'workbuddy').errors).toBe(0);
  });

  it('R3: the target host\'s OWN unhealthy events still count — never silenced wholesale', () => {
    expect(summarizeRuleCodeShadowEvents([unhealthyEntry(activationId, 'codex')], activationId, 'codex').errors).toBe(1);
  });

  it('R3: unattributed unhealthy events keep the legacy no-target behavior (counted)', () => {
    expect(summarizeRuleCodeShadowEvents([unhealthyEntry(activationId, undefined)], activationId).errors).toBe(1);
  });

  it('R3: foreign-host samples AND anomalies together cannot affect the target host\'s threshold inputs', () => {
    const mixed = [
      shadowEntry(activationId, 'workbuddy'),
      shadowEntry(activationId, 'workbuddy'),
      unhealthyEntry(activationId, 'workbuddy'),
      unhealthyEntry(activationId, undefined),
    ];
    const codexSummary = summarizeRuleCodeShadowEvents(mixed, activationId, 'codex');
    expect(codexSummary).toMatchObject({ observed: 0, matched: 0, errors: 0, neutralControl: 0 });
  });
});

const BASE_CONTRACT: HostLivenessContract = {
  version: 'codex-v2@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['rulecode_global_pause'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'status', capabilityId: 'pd_status', toolName: 'Bash', params: { command: 'pd activation list --json' }, expectedDecision: 'allow' },
    { probeId: 'deactivate', capabilityId: 'rulecode_deactivate', toolName: 'Bash', params: { command: 'pd activation deactivate --activation-id recovery-probe' }, expectedDecision: 'allow' },
    { probeId: 'pause', capabilityId: 'rulecode_global_pause', toolName: 'rulecode_global_pause', params: {}, expectedDecision: 'allow' },
    { probeId: 'review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

/** The pre-review contract shape: fabricated `pd status` / `pd activation emergency-pause` probes. */
const FABRICATED_COMMANDS_CONTRACT: HostLivenessContract = {
  ...BASE_CONTRACT,
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
      goldenTrace: {
        traceId: 'trace-attribution',
        sourcePainId: 'pain-attribution',
        cases: [
          { caseId: 'negative', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
          { caseId: 'positive', kind: 'positive', toolName: 'edit_file', params: { path: '/workspace/safe.ts' }, expectedDecision: 'allow' },
        ],
        createdAt: '2026-10-28T00:00:00.000Z',
        version: 1,
      },
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

// ── Review finding 1 (P1): capability declarations ≠ real recovery checks ──

describe('emergency_controls binds to the REAL recovery surface registry (SPEC R1)', () => {
  it('passes only with a registry-verified contract, the safety flag, and passing control-probe composition', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: BASE_CONTRACT,
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'emergency_controls')).toEqual({
      checkId: 'emergency_controls',
      status: 'passed',
    });
  });

  it('R1-red→green: shape-valid contract + flag ON, but probes name NON-EXISTENT commands (pd status / pd activation emergency-pause) → FAIL', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: FABRICATED_COMMANDS_CONTRACT,
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'emergency_controls')).toMatchObject({
      status: 'failed',
      reasonCode: 'recovery_control_probe_mismatch',
    });
  });

  it('R1: a console-channel control probed through a fabricated shell command → FAIL (no CLI command exists for the global pause)', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: {
        ...BASE_CONTRACT,
        neutralProbes: BASE_CONTRACT.neutralProbes.map(probe =>
          probe.capabilityId === 'rulecode_global_pause'
            ? { ...probe, toolName: 'Bash', params: { command: 'pd activation emergency-pause' } }
            : probe),
      },
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'emergency_controls')).toMatchObject({
      status: 'failed',
      reasonCode: 'recovery_control_probe_mismatch',
    });
  });

  it('R1: a registry capability the contract does not declare → FAIL as unregistered (direct registry validation; the shape validator rejects the same contract earlier in the check pipeline)', async () => {
    const stripped = {
      ...BASE_CONTRACT,
      protectedCapabilities: BASE_CONTRACT.protectedCapabilities.filter(c => c.capabilityId !== 'rulecode_global_pause'),
      neutralProbes: BASE_CONTRACT.neutralProbes.filter(p => p.capabilityId !== 'rulecode_global_pause'),
    };
    expect(validateRecoveryControlSurfaces(stripped)).toMatchObject({
      ok: false,
      reason: 'recovery_control_surface_unregistered',
      capabilityId: 'rulecode_global_pause',
    });
  });

  it('R1: a rule COMBINATION that blocks the recovery probes fails emergency_controls even though each artifact is individually valid', async () => {
    // The candidate is neutral, but the existing live rule denies every Bash
    // call — recovery through the CLI channel is unreachable under composition.
    const controlBlocking = { ...neutralArtifact(), contentJson: JSON.stringify({
      implementationCode: `function evaluate(input) { const b = input.action.toolName === 'Bash' || input.action.toolName === 'bash'; return { decision: b ? 'block' : 'allow', matched: b, reason: b ? 'deny shell' : 'neutral' }; }`,
      affectedTools: ['edit_file'],
    }) };
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: true,
      hostContract: BASE_CONTRACT,
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [controlBlocking],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'emergency_controls')).toMatchObject({
      status: 'failed',
      reasonCode: 'control_probe_composition_failed',
    });
    expect(checks.find(check => check.checkId === 'host_liveness_composition')?.status).toBe('failed');
  });

  it('R1: safety flag OFF still fails with the flag reason (registry alone is not health either)', async () => {
    const checks = await collectOpenClawPromotionChecks(neutralArtifact(), {
      ownerIdentityConfigured: true,
      safetyControlsEnabled: false,
      hostContract: BASE_CONTRACT,
      expectedHostContractVersion: 'codex-v2@1',
      existingLiveArtifacts: [],
      validateProductionArtifact: async () => ({ ok: true }),
    });
    expect(checks.find(check => check.checkId === 'emergency_controls')).toMatchObject({
      status: 'failed',
      reasonCode: 'safety_controls_disabled',
    });
  });
});
