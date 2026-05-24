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
}

const PRODUCTION_WORKSPACE_PREFIXES = [
  'D:\\.openclaw\\workspace',
  'C:\\Users\\Administrator\\.openclaw\\workspace',
  path.join(os.homedir(), '.openclaw', 'workspace'),
];

function isProductionWorkspace(workspaceDir: string): boolean {
  const normalized = path.resolve(workspaceDir).toLowerCase();
  for (const prefix of PRODUCTION_WORKSPACE_PREFIXES) {
    if (normalized.startsWith(prefix.toLowerCase())) {
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
  const generatedAt = new Date().toISOString();

  if (isProductionWorkspace(workspaceDir)) {
    const blockedChannel: ChannelFixtureResult = {
      channel: 'prompt',
      status: 'failed',
      canActivateResult: { ok: false, reason: 'production_workspace_blocked', riskLevel: 'low' },
      activationDecision: { decision: 'refused', reason: 'production_workspace_blocked', channel: 'prompt' },
      evidence: { workspaceDir: path.basename(workspaceDir) },
      failureReason: 'Baseline must not write to production workspace',
      nextAction: 'Use a temp workspace or explicit non-production directory',
      dependsOnLegacy: false,
    };
    return {
      status: 'failed',
      generatedAt,
      workspaceMode,
      channels: channels.map(ch => ({ ...blockedChannel, channel: ch })),
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
