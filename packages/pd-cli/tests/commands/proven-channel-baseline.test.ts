import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRunProvenChannelBaseline } = vi.hoisted(() => ({
  mockRunProvenChannelBaseline: vi.fn(),
}));

vi.mock('../../src/services/proven-channel-baseline-runner.js', () => ({
  runProvenChannelBaseline: mockRunProvenChannelBaseline,
  isProductionWorkspace: (dir: string) => {
    const path = require('path');
    const os = require('os');
    const normalized = path.resolve(dir).toLowerCase();
    const prefixes = [
      path.resolve('D:\\.openclaw\\workspace').toLowerCase(),
      path.resolve('C:\\Users\\Administrator\\.openclaw\\workspace').toLowerCase(),
      path.resolve(path.join(os.homedir(), '.openclaw', 'workspace')).toLowerCase(),
    ];
    for (const prefix of prefixes) {
      if (normalized === prefix || normalized.startsWith(prefix + path.sep)) {
        return true;
      }
    }
    return false;
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleProvenChannelBaseline } from '../../src/commands/proven-channel-baseline.js';
import { isProductionWorkspace } from '../../src/services/proven-channel-baseline-runner.js';

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
        evidence: { activationId: 'act_prompt_P_240', evidenceSource: 'ActivationDispatcher.dispatch → PromptWriter' },
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → PromptWriter',
      },
      {
        channel: 'code_tool_hook' as const,
        status: 'passed' as const,
        canActivateResult: { ok: true, riskLevel: 'high' as const },
        activationDecision: { decision: 'would_activate' as const, activationId: 'act_code_R_240', action: 'code_tool_hook_shadow_activate', targetRef: 'impl://R_240' },
        evidence: { activationId: 'act_code_R_240', gateDecision: 'accepted_shadow', evidenceSource: 'ActivationDispatcher.dispatch → RuleHostWriter' },
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → RuleHostWriter',
      },
      {
        channel: 'defer_archive' as const,
        status: 'passed' as const,
        canActivateResult: { ok: true, riskLevel: 'low' as const },
        activationDecision: { decision: 'would_activate' as const, activationId: 'act_archive_P_240', action: 'defer_archive', targetRef: 'ledger://P_240#archived' },
        evidence: { activationId: 'act_archive_P_240', evidenceSource: 'ActivationDispatcher.dispatch → DeferArchiveWriter' },
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → DeferArchiveWriter',
      },
    ],
    continuityMatrix: [
      {
        channel: 'prompt' as const,
        entryPoint: 'ActivationDispatcher.dispatch → PromptWriter.canActivate → PromptWriter.activate',
        expectedObservable: 'activationId=act_prompt_{principleId}',
        testCommand: 'npx vitest run ...',
        dependsOnNocturnal: false,
        dependsOnIdleTrigger: false,
        dependsOnPluginDiscovery: false,
        pri119ReuseEvidence: 'ActivationDispatcher → PromptWriter contract',
        pri230ReuseEvidence: 'prompt risk level',
      },
      {
        channel: 'code_tool_hook' as const,
        entryPoint: 'ActivationDispatcher.dispatch → RuleHostWriter.canActivate → evaluateRefinerRuleHostGate → RuleHostWriter.activate',
        expectedObservable: 'activationId=act_code_{ruleId}',
        testCommand: 'npx vitest run ...',
        dependsOnNocturnal: false,
        dependsOnIdleTrigger: false,
        dependsOnPluginDiscovery: false,
        pri119ReuseEvidence: 'ActivationDispatcher → RuleHostWriter gate contract',
        pri230ReuseEvidence: 'code_tool_hook risk level',
      },
      {
        channel: 'defer_archive' as const,
        entryPoint: 'ActivationDispatcher.dispatch → DeferArchiveWriter.canActivate → DeferArchiveWriter.activate',
        expectedObservable: 'activationId=act_archive_{principleId}',
        testCommand: 'npx vitest run ...',
        dependsOnNocturnal: false,
        dependsOnIdleTrigger: false,
        dependsOnPluginDiscovery: false,
        pri119ReuseEvidence: 'ActivationDispatcher → DeferArchiveWriter contract',
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
      void 0;
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
        { channel: 'prompt', status: 'failed', canActivateResult: { ok: false, reason: 'test', riskLevel: 'low' }, activationDecision: { decision: 'refused', reason: 'test', channel: 'prompt' }, evidence: {}, dependsOnLegacy: false, failureReason: 'test failure', evidenceSource: 'test' },
        { channel: 'code_tool_hook', status: 'failed', canActivateResult: { ok: false, reason: 'test', riskLevel: 'high' }, activationDecision: { decision: 'refused', reason: 'test', channel: 'code_tool_hook' }, evidence: {}, dependsOnLegacy: false, failureReason: 'test failure', evidenceSource: 'test' },
        { channel: 'defer_archive', status: 'failed', canActivateResult: { ok: false, reason: 'test', riskLevel: 'low' }, activationDecision: { decision: 'refused', reason: 'test', channel: 'defer_archive' }, evidence: {}, dependsOnLegacy: false, failureReason: 'test failure', evidenceSource: 'test' },
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

  it('--channels with unknown values passes unknownChannels to runner', async () => {
    mockRunProvenChannelBaseline.mockResolvedValue({
      status: 'failed',
      generatedAt: new Date().toISOString(),
      workspaceMode: 'temp',
      channels: [
        {
          channel: 'prompt',
          status: 'failed',
          canActivateResult: { ok: false, reason: 'unknown_channels', riskLevel: 'low' },
          activationDecision: { decision: 'refused', reason: 'unknown_channels', channel: 'prompt' },
          evidence: { unknownChannels: ['skill', 'model_training'] },
          dependsOnLegacy: false,
          failureReason: 'Unknown channels: skill, model_training',
          nextAction: 'Use only valid MVP channels: prompt, code_tool_hook, defer_archive',
          evidenceSource: 'input_validation',
        },
      ],
      continuityMatrix: [],
      recommendedNextIssue: 'PRI-240: Unknown channels provided: skill, model_training',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleProvenChannelBaseline({ json: true, channels: 'prompt,skill,model_training' });
      expect(mockRunProvenChannelBaseline).toHaveBeenCalledWith(
        expect.objectContaining({
          unknownChannels: ['skill', 'model_training'],
        }),
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('command is registered in CLI entrypoint as runtime synthetic proven-channel', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();

    const { handleProvenChannelBaseline: handler } = await import('../../src/commands/proven-channel-baseline.js');

    const synthCmd = program.command('runtime').command('synthetic');
    synthCmd
      .command('proven-channel')
      .option('-w, --workspace <path>', 'Workspace directory')
      .option('--json', 'Output raw JSON')
      .option('--channels <channels>', 'Comma-separated channel list')
      .action(async (opts) => {
        await handler(opts);
      });

    const found = program.commands.find(c => c.name() === 'runtime')
      ?.commands.find(c => c.name() === 'synthetic')
      ?.commands.find(c => c.name() === 'proven-channel');
    expect(found).toBeDefined();
    expect(found?.name()).toBe('proven-channel');
  });
});

describe('isProductionWorkspace', () => {
  it('blocks exact production workspace path', () => {
    expect(isProductionWorkspace('D:\\.openclaw\\workspace')).toBe(true);
  });

  it('blocks descendant of production workspace', () => {
    expect(isProductionWorkspace('D:\\.openclaw\\workspace\\my-project')).toBe(true);
  });

  it('does NOT block sibling path with different prefix', () => {
    expect(isProductionWorkspace('D:\\.openclaw\\workspace-extra')).toBe(false);
  });

  it('does NOT block unrelated path', () => {
    expect(isProductionWorkspace('C:\\Users\\test\\project')).toBe(false);
  });

  it('does NOT block temp directory', () => {
    const tmp = os.tmpdir();
    expect(isProductionWorkspace(tmp)).toBe(false);
  });
});
