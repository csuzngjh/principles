import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRunProvenChannelBaseline } = vi.hoisted(() => ({
  mockRunProvenChannelBaseline: vi.fn(),
}));

vi.mock('../../src/services/proven-channel-baseline-runner.js', () => ({
  runProvenChannelBaseline: mockRunProvenChannelBaseline,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleProvenChannelBaseline } from '../../src/commands/proven-channel-baseline.js';

function makePassedSummary() {
  return {
    status: 'passed' as const,
    workspaceMode: 'temp' as const,
    generatedAt: new Date().toISOString(),
    channels: [
      {
        channel: 'prompt' as const,
        status: 'passed' as const,
        canActivateResult: { ok: true, riskLevel: 'low' as const },
        activationDecision: { decision: 'would_activate' as const, activationId: 'act_prompt_P_240', action: 'prompt_activate', targetRef: 'ledger://P_240' },
        evidence: { activationId: 'act_prompt_P_240' },
        dependsOnLegacy: false,
      },
      {
        channel: 'code_tool_hook' as const,
        status: 'passed' as const,
        canActivateResult: { ok: true, riskLevel: 'high' as const },
        activationDecision: { decision: 'would_activate' as const, activationId: 'act_code_R_240', action: 'code_tool_hook_shadow_activate', targetRef: 'impl://R_240' },
        evidence: { activationId: 'act_code_R_240', gateDecision: 'accepted_shadow' },
        dependsOnLegacy: false,
      },
      {
        channel: 'defer_archive' as const,
        status: 'passed' as const,
        canActivateResult: { ok: true, riskLevel: 'low' as const },
        activationDecision: { decision: 'would_activate' as const, activationId: 'act_archive_P_240', action: 'defer_archive', targetRef: 'ledger://P_240#archived' },
        evidence: { activationId: 'act_archive_P_240' },
        dependsOnLegacy: false,
      },
    ],
    continuityMatrix: [
      {
        channel: 'prompt' as const,
        entryPoint: 'PromptWriter.canActivate → PromptWriter.activate',
        expectedObservable: 'activationId=act_prompt_{principleId}',
        testCommand: 'npx vitest run ...',
        dependsOnNocturnal: false,
        dependsOnIdleTrigger: false,
        dependsOnPluginDiscovery: false,
        pri119ReuseEvidence: 'PromptWriter contract',
        pri230ReuseEvidence: 'prompt risk level',
      },
      {
        channel: 'code_tool_hook' as const,
        entryPoint: 'RuleHostWriter.canActivate → evaluateRefinerRuleHostGate → RuleHostWriter.activate',
        expectedObservable: 'activationId=act_code_{ruleId}',
        testCommand: 'npx vitest run ...',
        dependsOnNocturnal: false,
        dependsOnIdleTrigger: false,
        dependsOnPluginDiscovery: false,
        pri119ReuseEvidence: 'RuleHostWriter gate contract',
        pri230ReuseEvidence: 'code_tool_hook risk level',
      },
      {
        channel: 'defer_archive' as const,
        entryPoint: 'DeferArchiveWriter.canActivate → DeferArchiveWriter.activate',
        expectedObservable: 'activationId=act_archive_{principleId}',
        testCommand: 'npx vitest run ...',
        dependsOnNocturnal: false,
        dependsOnIdleTrigger: false,
        dependsOnPluginDiscovery: false,
        pri119ReuseEvidence: 'DeferArchiveWriter contract',
        pri230ReuseEvidence: 'defer_archive risk level',
      },
    ],
  };
}

describe('handleProvenChannelBaseline (CLI handler)', () => {
  let tempDir = '';
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-proven-test-'));
    mockRunProvenChannelBaseline.mockReset();
    process.exitCode = undefined as unknown as number;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
    }
    process.exitCode = originalExitCode;
  });

  it('uses temp workspace when no workspace specified', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'temp',
    });

    await handleProvenChannelBaseline({});

    expect(mockRunProvenChannelBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceMode: 'temp' }),
    );
    const calledDir = mockRunProvenChannelBaseline.mock.calls[0][0].workspaceDir;
    expect(calledDir).toContain('pd-proven-channel-');
  });

  it('uses explicit workspace when --workspace is provided', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'explicit_workspace',
    });

    await handleProvenChannelBaseline({ workspace: tempDir });

    expect(mockRunProvenChannelBaseline).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: tempDir,
        workspaceMode: 'explicit_workspace',
      }),
    );
  });

  it('--json output contains status, workspaceMode, generatedAt, channels, continuityMatrix', async () => {
    const summary = makePassedSummary();
    mockRunProvenChannelBaseline.mockResolvedValue(summary);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ json: true });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('workspaceMode');
      expect(parsed).toHaveProperty('generatedAt');
      expect(parsed).toHaveProperty('channels');
      expect(parsed).toHaveProperty('continuityMatrix');
      expect(parsed.channels).toHaveLength(3);
      expect(parsed.continuityMatrix).toHaveLength(3);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('sets process.exitCode = 1 when status is failed', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      ...makePassedSummary(),
      status: 'failed',
      channels: [
        { channel: 'prompt', status: 'failed', canActivateResult: { ok: false, reason: 'test', riskLevel: 'low' }, activationDecision: { decision: 'refused', reason: 'test', channel: 'prompt' }, evidence: {}, dependsOnLegacy: false, failureReason: 'test failure' },
        { channel: 'code_tool_hook', status: 'failed', canActivateResult: { ok: false, reason: 'test', riskLevel: 'high' }, activationDecision: { decision: 'refused', reason: 'test', channel: 'code_tool_hook' }, evidence: {}, dependsOnLegacy: false, failureReason: 'test failure' },
        { channel: 'defer_archive', status: 'failed', canActivateResult: { ok: false, reason: 'test', riskLevel: 'low' }, activationDecision: { decision: 'refused', reason: 'test', channel: 'defer_archive' }, evidence: {}, dependsOnLegacy: false, failureReason: 'test failure' },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ workspace: tempDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('sets process.exitCode = 1 when status is degraded', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      ...makePassedSummary(),
      status: 'degraded',
      channels: [
        { channel: 'prompt', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false },
        { channel: 'code_tool_hook', status: 'degraded', canActivateResult: { ok: true, riskLevel: 'high' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: true, failureReason: 'depends on legacy' },
        { channel: 'defer_archive', status: 'passed', canActivateResult: { ok: true, riskLevel: 'low' }, activationDecision: { decision: 'would_activate', activationId: 'a', action: 'b', targetRef: 'c' }, evidence: {}, dependsOnLegacy: false },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ workspace: tempDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('cleans up temp workspace on success', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue(makePassedSummary());

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({});

      const calledDir = mockRunProvenChannelBaseline.mock.calls[0][0].workspaceDir;
      expect(fs.existsSync(calledDir)).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not delete explicit workspace after run', async () => {
    fs.mkdirSync(path.join(tempDir, '.pd'), { recursive: true });

    mockRunProvenChannelBaseline.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'explicit_workspace',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ workspace: tempDir });
      expect(fs.existsSync(tempDir)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('production workspace is blocked by runner', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      status: 'failed',
      generatedAt: new Date().toISOString(),
      workspaceMode: 'explicit_workspace',
      channels: [
        { channel: 'prompt', status: 'failed', canActivateResult: { ok: false, reason: 'production_workspace_blocked', riskLevel: 'low' }, activationDecision: { decision: 'refused', reason: 'production_workspace_blocked', channel: 'prompt' }, evidence: {}, dependsOnLegacy: false, failureReason: 'Baseline must not write to production workspace', nextAction: 'Use a temp workspace' },
      ],
      continuityMatrix: [],
      recommendedNextIssue: 'PRI-240: Production workspace blocked',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ json: true, workspace: tempDir });
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('failed');
      expect(parsed.channels[0].failureReason).toContain('production');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('channel results include failureReason and nextAction when failed', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      status: 'failed',
      generatedAt: new Date().toISOString(),
      workspaceMode: 'temp',
      channels: [
        {
          channel: 'prompt',
          status: 'failed',
          canActivateResult: { ok: false, reason: 'artifact_kind_not_principle', riskLevel: 'low' },
          activationDecision: { decision: 'refused', reason: 'can_activate_refused', channel: 'prompt', riskLevel: 'low' },
          evidence: { canActivateResult: { ok: false, reason: 'artifact_kind_not_principle' } },
          dependsOnLegacy: false,
          failureReason: 'PromptWriter.canActivate refused: artifact_kind_not_principle',
          nextAction: 'Check artifact kind is "principle" and validationStatus is "validated"',
        },
      ],
      continuityMatrix: [],
      recommendedNextIssue: 'PRI-240: Prompt channel fixture failed',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ json: true });
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.channels[0].failureReason).toBeTruthy();
      expect(parsed.channels[0].nextAction).toBeTruthy();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('continuity matrix has no legacy dependencies', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue(makePassedSummary());

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ json: true });
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      for (const entry of parsed.continuityMatrix) {
        expect(entry.dependsOnNocturnal).toBe(false);
        expect(entry.dependsOnIdleTrigger).toBe(false);
        expect(entry.dependsOnPluginDiscovery).toBe(false);
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
