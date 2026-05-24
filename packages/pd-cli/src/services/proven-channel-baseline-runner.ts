import * as path from 'path';
import * as os from 'os';
import {
  runPromptFixture,
  runRuleHostFixture,
  runDeferArchiveFixture,
  computeProvenChannelStatus,
  generateContinuityMatrix,
  recommendProvenChannelNextIssue,
  isMvpChannel,
  MVP_CHANNELS,
} from '@principles/core/runtime-v2';
import type {
  ChannelFixtureResult,
  ProvenChannelBaselineSummary,
  MvpChannel,
} from '@principles/core/runtime-v2';

export interface ProvenChannelBaselineRunnerOptions {
  workspaceDir: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  channels?: MvpChannel[];
  unknownChannels?: string[];
  emptyChannelInput?: boolean;
}

function isProductionWorkspace(workspaceDir: string): boolean {
  const normalized = path.resolve(workspaceDir).toLowerCase();
  const productionPrefixes = [
    path.resolve('D:\\.openclaw\\workspace').toLowerCase(),
    path.resolve('C:\\Users\\Administrator\\.openclaw\\workspace').toLowerCase(),
    path.resolve(path.join(os.homedir(), '.openclaw', 'workspace')).toLowerCase(),
  ];
  for (const prefix of productionPrefixes) {
    if (normalized === prefix || normalized.startsWith(prefix + path.sep)) {
      return true;
    }
  }
  return false;
}

export async function runProvenChannelBaseline(
  opts: ProvenChannelBaselineRunnerOptions,
): Promise<ProvenChannelBaselineSummary> {
  const { workspaceDir, workspaceMode } = opts;
  const channels = opts.channels ?? [...MVP_CHANNELS];
  const unknownChannels = opts.unknownChannels ?? [];
  const emptyChannelInput = opts.emptyChannelInput ?? false;
  const generatedAt = new Date().toISOString();

  if (emptyChannelInput) {
    return {
      status: 'failed',
      generatedAt,
      workspaceMode,
      channels: [],
      inputValidationFailure: {
        reason: 'empty_channel_input',
        message: '--channels was provided but contained no valid channel names',
        nextAction: 'Provide at least one valid MVP channel: prompt, code_tool_hook, defer_archive',
      },
      continuityMatrix: generateContinuityMatrix(),
      recommendedNextIssue: 'PRI-240: --channels input was empty — no fixtures were executed',
    };
  }

  if (unknownChannels.length > 0) {
    return {
      status: 'failed',
      generatedAt,
      workspaceMode,
      channels: [],
      inputValidationFailure: {
        reason: 'unknown_channels',
        message: `Unknown channels: ${unknownChannels.join(', ')}. Valid channels: prompt, code_tool_hook, defer_archive`,
        nextAction: 'Use only valid MVP channels: prompt, code_tool_hook, defer_archive',
        unknownChannels,
      },
      continuityMatrix: generateContinuityMatrix(),
      recommendedNextIssue: `PRI-240: Unknown channels provided: ${unknownChannels.join(', ')}`,
    };
  }

  if (isProductionWorkspace(workspaceDir)) {
    return {
      status: 'failed',
      generatedAt,
      workspaceMode,
      channels: [],
      inputValidationFailure: {
        reason: 'production_workspace_blocked',
        message: 'Baseline must not write to production workspace',
        nextAction: 'Use a temp workspace or explicit non-production directory',
      },
      continuityMatrix: generateContinuityMatrix(),
      recommendedNextIssue: 'PRI-240: Production workspace blocked — use temp workspace',
    };
  }

  const results: ChannelFixtureResult[] = [];

  for (const channel of channels) {
    if (!isMvpChannel(channel)) {
      continue;
    }

    let result: ChannelFixtureResult = {
      channel,
      status: 'failed',
      canActivateResult: { ok: false, reason: 'unsupported_channel', riskLevel: 'low' },
      activationDecision: { decision: 'refused', reason: 'unsupported_channel', channel },
      evidence: {},
      failureReason: `Channel ${channel} is not an MVP channel`,
      nextAction: 'Use one of: prompt, code_tool_hook, defer_archive',
      dependsOnLegacy: false,
      evidenceSource: 'channel_validation',
    };

    switch (channel) {
      case 'prompt':
        result = await runPromptFixture();
        break;
      case 'code_tool_hook':
        result = await runRuleHostFixture();
        break;
      case 'defer_archive':
        result = await runDeferArchiveFixture();
        break;
      default: {
        const _exhaustive: never = channel;
      }
    }

    results.push(result);
  }

  const status = computeProvenChannelStatus(results);
  const continuityMatrix = generateContinuityMatrix();

  return {
    status,
    generatedAt,
    workspaceMode,
    channels: results,
    continuityMatrix,
    recommendedNextIssue: recommendProvenChannelNextIssue(results),
  };
}

export { isProductionWorkspace };
