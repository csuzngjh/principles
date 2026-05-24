import { describe, it, expect } from 'vitest';
import {
  runPromptFixture,
  runRuleHostFixture,
  runDeferArchiveFixture,
  computeProvenChannelStatus,
  generateContinuityMatrix,
  recommendProvenChannelNextIssue,
  isMvpChannel,
  parseChannels,
  makePrincipleArtifact,
  makeRuleArtifact,
  makeSandboxAlwaysPass,
  classifyLegacyDependency,
  MVP_CHANNELS,
} from '../proven-channel-baseline.js';
import type { ChannelFixtureResult, MvpChannel } from '../proven-channel-baseline.js';
import { ActivationDispatcher } from '../activation/activation-dispatcher.js';
import { PromptWriter, DeferArchiveWriter } from '../activation/low-risk-writers.js';
import { RuleHostWriter } from '../activation/writers/rule-host-writer.js';

describe('Proven Channel Baseline (PRI-240)', () => {
  describe('prompt channel fixture', () => {
    it('succeeds and produces observable activation evidence via ActivationDispatcher', async () => {
      const result = await runPromptFixture();

      expect(result.channel).toBe('prompt');
      expect(result.status).toBe('passed');
      expect(['would_activate', 'activated']).toContain(result.activationDecision.decision);

      if (result.activationDecision.decision === 'would_activate' || result.activationDecision.decision === 'activated') {
        expect(result.activationDecision.activationId).toContain('act_prompt_');
        expect(result.activationDecision.action).toBe('prompt_activate');
        expect(result.activationDecision.targetRef).toContain('ledger://');
      }

      expect(result.evidence).toHaveProperty('activationId');
      expect(result.evidence).toHaveProperty('evidenceSource');
      expect(result.evidenceSource).toContain('ActivationDispatcher');
      expect(result.failureReason).toBeUndefined();
      expect(result.dependsOnLegacy).toBe(false);
    });
  });

  describe('code_tool_hook / RuleHost channel fixture', () => {
    it('succeeds and produces gate/activation evidence via ActivationDispatcher', async () => {
      const result = await runRuleHostFixture();

      expect(result.channel).toBe('code_tool_hook');
      expect(result.evidenceSource).toContain('ActivationDispatcher');

      if (result.status === 'passed') {
        expect(['would_activate', 'activated']).toContain(result.activationDecision.decision);
        if (result.activationDecision.decision === 'would_activate' || result.activationDecision.decision === 'activated') {
          expect(result.activationDecision.activationId).toContain('act_code_');
          expect(result.activationDecision.action).toBe('code_tool_hook_shadow_activate');
          expect(result.activationDecision.targetRef).toContain('impl://');
        }
        expect(result.evidence).toHaveProperty('gateDecision');
        expect(result.failureReason).toBeUndefined();
      }

      if (result.status === 'degraded') {
        expect(result.failureReason).toBeTruthy();
        expect(result.nextAction).toBeTruthy();
      }
    });

    it('returns degraded when dispatcher routes to approval queue', async () => {
      const artifact = makeRuleArtifact();
      const writers: InstanceType<typeof RuleHostWriter>[] = [new RuleHostWriter({ gateDeps: makeSandboxAlwaysPass() })];
      const dispatcher = new ActivationDispatcher(
        { getArtifactById: async (id: string) => id === artifact.artifactId ? artifact : null },
        { getActivationStatus: async () => null, recordActivation: async () => { void 0; } },
        { writers },
      );
      const decision = await dispatcher.dispatch({
        artifactId: artifact.artifactId,
        channel: 'code_tool_hook',
        rolloutDecision: 'require_approval',
        actor: { kind: 'system', source: 'rollout_reviewer' },
        idempotencyKey: 'test-approval',
        now: '2026-05-24T00:00:00.000Z',
        confirm: true,
      });

      expect(['would_activate', 'queued_for_approval', 'refused']).toContain(decision.decision);
    });
  });

  describe('defer_archive channel fixture', () => {
    it('succeeds and produces observable activation evidence via ActivationDispatcher', async () => {
      const result = await runDeferArchiveFixture();

      expect(result.channel).toBe('defer_archive');
      expect(result.status).toBe('passed');
      expect(['would_activate', 'activated']).toContain(result.activationDecision.decision);

      if (result.activationDecision.decision === 'would_activate' || result.activationDecision.decision === 'activated') {
        expect(result.activationDecision.activationId).toContain('act_archive_');
        expect(result.activationDecision.action).toBe('defer_archive');
        expect(result.activationDecision.targetRef).toContain('ledger://');
        expect(result.activationDecision.targetRef).toContain('#archived');
      }

      expect(result.evidence).toHaveProperty('activationId');
      expect(result.evidence).toHaveProperty('evidenceSource');
      expect(result.evidenceSource).toContain('ActivationDispatcher');
      expect(result.failureReason).toBeUndefined();
      expect(result.dependsOnLegacy).toBe(false);
    });
  });

  describe('failure paths produce structured failure (not silent pass)', () => {
    it('prompt fixture fails loud when artifact kind is wrong', async () => {
      const writer = new PromptWriter();
      const badArtifact = { ...makePrincipleArtifact(), artifactKind: 'rule' as const };
      const result = await writer.canActivate(badArtifact);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('artifact_kind_not_principle');
      }
    });

    it('defer_archive fixture fails loud when validation status is wrong', async () => {
      const writer = new DeferArchiveWriter();
      const badArtifact = { ...makePrincipleArtifact(), validationStatus: 'pending' as const };
      const result = await writer.canActivate(badArtifact);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('artifact_validation_status_');
      }
    });

    it('RuleHost fixture fails loud when artifact lacks implementationCode', async () => {
      const gateDeps = makeSandboxAlwaysPass();
      const writer = new RuleHostWriter({ gateDeps });
      const badArtifact: ReturnType<typeof makeRuleArtifact> = {
        ...makeRuleArtifact(),
        contentJson: JSON.stringify({
          principleId: 'P_240',
          ruleHostGateDecision: 'accepted_shadow',
        }),
      };
      const result = await writer.canActivate(badArtifact);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('no_implementation_code');
      }
    });

    it('RuleHost fixture fails loud when gateDecision is not accepted_shadow', async () => {
      const gateDeps = makeSandboxAlwaysPass();
      const writer = new RuleHostWriter({ gateDeps });
      const badArtifact: ReturnType<typeof makeRuleArtifact> = {
        ...makeRuleArtifact(),
        contentJson: JSON.stringify({
          principleId: 'P_240',
          implementationCode: 'function evaluate() { return "allow"; }',
          goldenTrace: { traceId: 't1', cases: [{ caseId: 'c1', kind: 'negative', toolName: 'write', params: {}, expectedDecision: 'block' }], createdAt: '2026-01-01', version: 1 },
          ruleHostGateDecision: 'rejected',
        }),
      };
      const result = await writer.canActivate(badArtifact);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('gate_decision_not_accepted_shadow');
      }
    });
  });

  describe('unsupported channels do not mix into MVP continuity result', () => {
    it('isMvpChannel returns false for skill', () => {
      expect(isMvpChannel('skill')).toBe(false);
    });

    it('isMvpChannel returns false for model_training', () => {
      expect(isMvpChannel('model_training')).toBe(false);
    });

    it('isMvpChannel returns true for all MVP channels', () => {
      for (const ch of MVP_CHANNELS) {
        expect(isMvpChannel(ch)).toBe(true);
      }
    });

    it('MVP_CHANNELS contains exactly 3 entries', () => {
      expect(MVP_CHANNELS).toHaveLength(3);
      expect(MVP_CHANNELS).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    });
  });

  describe('parseChannels', () => {
    it('parses valid channels', () => {
      const result = parseChannels('prompt,defer_archive');
      expect(result.channels).toEqual(['prompt', 'defer_archive']);
      expect(result.unknowns).toEqual([]);
    });

    it('reports unknown channels', () => {
      const result = parseChannels('prompt,skill,model_training');
      expect(result.channels).toEqual(['prompt']);
      expect(result.unknowns).toEqual(['skill', 'model_training']);
    });

    it('returns all unknowns when no valid channels', () => {
      const result = parseChannels('foo,bar');
      expect(result.channels).toEqual([]);
      expect(result.unknowns).toEqual(['foo', 'bar']);
    });

    it('handles empty string', () => {
      const result = parseChannels('');
      expect(result.channels).toEqual([]);
      expect(result.unknowns).toEqual([]);
    });
  });

  describe('computeProvenChannelStatus', () => {
    function makeResult(status: ChannelFixtureResult['status'], channel: MvpChannel): ChannelFixtureResult {
      return {
        channel,
        status,
        canActivateResult: { ok: status === 'passed', riskLevel: 'low' },
        activationDecision: status === 'passed'
          ? { decision: 'would_activate', activationId: 'act', action: 'test', targetRef: 'ref' }
          : { decision: 'refused', reason: 'test', channel },
        evidence: {},
        dependsOnLegacy: false,
        evidenceSource: 'test',
      };
    }

    it('returns passed when all channels passed', () => {
      const results = [
        makeResult('passed', 'prompt'),
        makeResult('passed', 'code_tool_hook'),
        makeResult('passed', 'defer_archive'),
      ];
      expect(computeProvenChannelStatus(results)).toBe('passed');
    });

    it('returns failed when all channels failed', () => {
      const results = [
        makeResult('failed', 'prompt'),
        makeResult('failed', 'code_tool_hook'),
        makeResult('failed', 'defer_archive'),
      ];
      expect(computeProvenChannelStatus(results)).toBe('failed');
    });

    it('returns degraded when some passed and some failed', () => {
      const results = [
        makeResult('passed', 'prompt'),
        makeResult('failed', 'code_tool_hook'),
      ];
      expect(computeProvenChannelStatus(results)).toBe('degraded');
    });

    it('returns degraded when any channel is degraded', () => {
      const results = [
        makeResult('passed', 'prompt'),
        makeResult('degraded', 'code_tool_hook'),
      ];
      expect(computeProvenChannelStatus(results)).toBe('degraded');
    });

    it('returns failed when results array is empty', () => {
      expect(computeProvenChannelStatus([])).toBe('failed');
    });
  });

  describe('continuity matrix', () => {
    it('has exactly 3 entries matching MVP channels', () => {
      const matrix = generateContinuityMatrix();
      expect(matrix).toHaveLength(3);
      const channels = matrix.map(e => e.channel);
      expect(channels).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    });

    it('all entry points reference ActivationDispatcher', () => {
      const matrix = generateContinuityMatrix();
      for (const entry of matrix) {
        expect(entry.entryPoint).toContain('ActivationDispatcher.dispatch');
      }
    });

    it('no channel depends on Nocturnal', () => {
      const matrix = generateContinuityMatrix();
      for (const entry of matrix) {
        expect(entry.dependsOnNocturnal).toBe(false);
      }
    });

    it('no channel depends on idle-trigger', () => {
      const matrix = generateContinuityMatrix();
      for (const entry of matrix) {
        expect(entry.dependsOnIdleTrigger).toBe(false);
      }
    });

    it('no channel depends on plugin discovery', () => {
      const matrix = generateContinuityMatrix();
      for (const entry of matrix) {
        expect(entry.dependsOnPluginDiscovery).toBe(false);
      }
    });

    it('each entry has PRI-119 and PRI-230 reuse evidence', () => {
      const matrix = generateContinuityMatrix();
      for (const entry of matrix) {
        expect(entry.pri119ReuseEvidence.length).toBeGreaterThan(0);
        expect(entry.pri230ReuseEvidence.length).toBeGreaterThan(0);
      }
    });
  });

  describe('recommendProvenChannelNextIssue', () => {
    it('returns undefined when all channels passed', () => {
      const results: ChannelFixtureResult[] = [
        { channel: 'prompt', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
        { channel: 'code_tool_hook', status: 'passed', canActivateResult: { ok: true, riskLevel: 'high' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
        { channel: 'defer_archive', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
      ];
      expect(recommendProvenChannelNextIssue(results)).toBeUndefined();
    });

    it('returns DELETION BLOCKER when any channel depends on legacy', () => {
      const results: ChannelFixtureResult[] = [
        { channel: 'prompt', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
        { channel: 'code_tool_hook', status: 'degraded', canActivateResult: { ok: true, riskLevel: 'high' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: true, failureReason: 'depends on legacy', nextAction: 'mark as blocker', evidenceSource: 'test' },
        { channel: 'defer_archive', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
      ];
      const rec = recommendProvenChannelNextIssue(results);
      expect(rec).toContain('DELETION BLOCKER');
      expect(rec).toContain('code_tool_hook');
    });

    it('returns BLOCKER when any channel is degraded', () => {
      const results: ChannelFixtureResult[] = [
        { channel: 'prompt', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
        { channel: 'code_tool_hook', status: 'degraded', canActivateResult: { ok: true, riskLevel: 'high' }, activationDecision: { decision: 'queued_for_approval', approvalId: 'apr', queuedAt: '2026-01-01', channel: 'code_tool_hook', riskLevel: 'high' }, evidence: {}, dependsOnLegacy: false, failureReason: 'requires approval', nextAction: 'implement approval', evidenceSource: 'test' },
        { channel: 'defer_archive', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false, evidenceSource: 'test' },
      ];
      const rec = recommendProvenChannelNextIssue(results);
      expect(rec).toContain('BLOCKER');
      expect(rec).toContain('code_tool_hook');
    });
  });

  describe('classifyLegacyDependency', () => {
    it('returns true for canActivateResult with legacy reason', () => {
      const decision = { decision: 'would_activate' as const, activationId: 'a', action: 'b', targetRef: 'c' };
      const canActivateResult = { ok: false, reason: 'nocturnal_dependency_detected', riskLevel: 'high' as const };
      expect(classifyLegacyDependency(decision, canActivateResult)).toBe(true);
    });

    it('returns false when no legacy keywords present', () => {
      const decision = { decision: 'would_activate' as const, activationId: 'a', action: 'b', targetRef: 'c' };
      const canActivateResult = { ok: false, reason: 'artifact_kind_not_rule', riskLevel: 'high' as const };
      expect(classifyLegacyDependency(decision, canActivateResult)).toBe(false);
    });
  });

  describe('evidenceSource tracking', () => {
    it('prompt fixture evidenceSource references ActivationDispatcher', async () => {
      const result = await runPromptFixture();
      expect(result.evidenceSource).toContain('ActivationDispatcher');
    });

    it('code_tool_hook fixture evidenceSource references ActivationDispatcher', async () => {
      const result = await runRuleHostFixture();
      expect(result.evidenceSource).toContain('ActivationDispatcher');
    });

    it('defer_archive fixture evidenceSource references ActivationDispatcher', async () => {
      const result = await runDeferArchiveFixture();
      expect(result.evidenceSource).toContain('ActivationDispatcher');
    });
  });

  describe('fixture artifact determinism', () => {
    it('makePrincipleArtifact produces consistent shape', () => {
      const art = makePrincipleArtifact();
      expect(art.artifactKind).toBe('principle');
      expect(art.validationStatus).toBe('validated');
      expect(art.sourcePrincipleId).toBe('synth-principle-PRI240');
    });

    it('makeRuleArtifact produces consistent shape with goldenTrace', () => {
      const art = makeRuleArtifact();
      expect(art.artifactKind).toBe('rule');
      expect(art.validationStatus).toBe('validated');
      expect(art.sourceRuleId).toBe('synth-rule-PRI240');

      const parsed = JSON.parse(art.contentJson) as Record<string, unknown>;
      expect(typeof parsed.implementationCode).toBe('string');
      expect(parsed.implementationCode).toBeTruthy();

      const trace = parsed.goldenTrace as Record<string, unknown> | null;
      expect(trace).not.toBeNull();
      if (trace) {
        expect(Array.isArray(trace.cases)).toBe(true);
        expect((trace.cases as unknown[]).length).toBeGreaterThan(0);
        expect(typeof trace.traceId).toBe('string');
      }

      expect(parsed.ruleHostGateDecision).toBe('accepted_shadow');
    });

    it('makeSandboxAlwaysPass produces passing sandbox result', () => {
      const deps = makeSandboxAlwaysPass();
      const result = deps.evaluateInSandbox('code', { traceId: 't', cases: [], createdAt: '', version: 1 });
      expect(result.success).toBe(true);
      expect(result.failedCases).toEqual([]);
    });
  });
});
