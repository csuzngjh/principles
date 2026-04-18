/**
 * Promote Implementation Command — CLI `/pd-promote-impl`
 * ========================================================
 *
 * PURPOSE: Manually promote a candidate implementation to active status
 * after replay evaluation review.
 *
 * FLOW:
 *   1. List candidates with replay reports
 *   2. Show replay report summary for selected candidate
 *   3. Ask for confirmation
 *   4. On confirm: transition candidate->active, demote previous active->disabled
 *
 * VALIDATION:
 *   - Candidate must have at least one replay report with 'pass' decision
 *   - Only candidate -> active is valid for promotion
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReplayEngine, formatReplayReport } from '../core/replay-engine.js';
import { refreshPrincipleLifecycle } from '../core/principle-internalization/lifecycle-refresh.js';
import {
  findActiveImplementation,
  loadLedger,
  transitionImplementationState,
  updateImplementation,
} from '../core/principle-tree-ledger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';
import type { Implementation, ImplementationLifecycleState } from '../types/principle-tree-schema.js';
import { withLock } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';

function getAllImplementations(stateDir: string): Implementation[] {
  const ledger = loadLedger(stateDir);
  return Object.values(ledger.tree.implementations);
}

/**
 * Type predicate: true if impl has lifecycleState of 'candidate' or 'disabled'.
 * The ledger adds lifecycleState at runtime beyond what's in the manifest interface.
 */
function isCandidateOrDisabled(
  impl: Implementation
): impl is Implementation & { lifecycleState: ImplementationLifecycleState } {
  return impl.lifecycleState === 'candidate' || impl.lifecycleState === 'disabled';
}

function _handleListCandidates(
  stateDir: string,
  isZh: boolean,
): PluginCommandResult {
  const engine = new ReplayEngine('', stateDir);
  const allImpls = getAllImplementations(stateDir);
  const candidates = allImpls.filter(isCandidateOrDisabled);

  if (candidates.length === 0) {
    return {
      text: isZh
        ? '\nℹ️ 未找到候选实现。\n\n用法: /pd-promote-impl list'
        : '\nℹ️ No candidate implementations found.\n\nUsage: /pd-promote-impl list',
    };
  }

  let output = isZh ? '\n📋 候选实现列表\n' : '\n📋 Candidate Implementations\n';
  output += `${'='.repeat(50)}\n`;

  for (const impl of candidates) {
    const hasPass = engine.hasPassingReport(impl.id);
    const passBadge = hasPass
      ? isZh ? '✅ 有通过报告' : '✅ Has pass report'
      : isZh ? '❌ 无通过报告' : '❌ No pass report';
    output += `  ${impl.id}\n`;
    output += `    Rule: ${impl.ruleId} | Version: ${impl.version}\n`;
    output += `    Replay: ${passBadge}\n\n`;
  }

  return { text: output };
}

function _handleShowReport(
  stateDir: string,
  implId: string,
  isZh: boolean,
): PluginCommandResult {
  const engine = new ReplayEngine('', stateDir);
  const report = engine.getLatestReport(implId);

  if (!report) {
    return {
      text: isZh
        ? `❌ 实现 ${implId} 没有回放报告。`
        : `❌ No replay report found for implementation ${implId}.`,
    };
  }

  return { text: formatReplayReport(report) };
}

interface RunReplayOptions {
  workspaceDir: string;
  stateDir: string;
  implId: string;
  isZh: boolean;
}

function _handleRunReplay(options: RunReplayOptions): PluginCommandResult {
  const { workspaceDir, stateDir, implId, isZh } = options;
  const engine = new ReplayEngine(workspaceDir, stateDir);

  try {
    const report = engine.runReplayForImplementation(implId);
    let text = formatReplayReport(report);
    if (report.sampleFingerprints.length === 0) {
      text += isZh
        ? '\n⚠️ 未找到已分类的 replay 样本。报告已生成，但当前结果只反映空样本集。\n'
        : '\n⚠️ No classified replay samples were found. The report was generated, but it only reflects an empty sample set.\n';
    }
    return { text };
  } catch (error: unknown) {
    return {
      text: isZh
        ? `❌ 回放评估失败: ${String(error)}`
        : `❌ Replay evaluation failed: ${String(error)}`,
    };
  }
}

interface PromoteImplOptions {
  workspaceDir: string;
  stateDir: string;
  implId: string;
  isZh: boolean;
}

function _handlePromoteImpl(options: PromoteImplOptions): PluginCommandResult {
  const { workspaceDir, stateDir, implId, isZh } = options;
  const engine = new ReplayEngine('', stateDir);
  const allImpls = getAllImplementations(stateDir);
  const candidate = allImpls.find((i) => i.id === implId);

  if (!candidate) {
    return {
      text: isZh
        ? `❌ 未找到实现: ${implId}`
        : `❌ Implementation not found: ${implId}`,
    };
  }

  const currentState = candidate.lifecycleState || 'candidate';

  if (currentState !== 'candidate' && currentState !== 'disabled') {
    return {
      text: isZh
        ? `❌ 只能晋升 candidate 或 disabled 状态的实现。当前: ${currentState}`
        : `❌ Can only promote 'candidate' or 'disabled' implementations. Current: ${currentState}`,
    };
  }

  if (!engine.hasPassingReport(implId)) {
    return {
      text: isZh
        ? `❌ 实现 ${implId} 没有通过的回放报告，无法晋升。\n\n请先运行回放评估。`
        : `❌ Implementation ${implId} has no passing replay report. Promotion rejected.\n\nPlease run a replay evaluation first.`,
    };
  }

  const report = engine.getLatestReport(implId);
  let output = '';
  if (report) {
    output = `${formatReplayReport(report)}\n`;
  }

  if (currentState === 'disabled') {
    transitionImplementationState(stateDir, implId, 'active');
    updateImplementation(stateDir, implId, {
      disabledAt: undefined,
      disabledBy: undefined,
      disabledReason: undefined,
    });
    try {
      refreshPrincipleLifecycle(workspaceDir, stateDir);
    } catch (err) {
      console.warn('[promote-impl] Lifecycle refresh failed (re-enable):', err instanceof Error ? err.stack : err);
    }

    output += isZh
      ? `\n✅ 实现已重新启用: ${implId}\n   状态: disabled -> active`
      : `\n✅ Implementation re-enabled: ${implId}\n   State: disabled -> active`;

    return { text: output };
  }

  const activeForRule = findActiveImplementation(stateDir, candidate.ruleId);

  if (activeForRule) {
    updateImplementation(stateDir, implId, {
      previousActive: activeForRule.id,
    });
  }

  transitionImplementationState(stateDir, implId, 'active');

  if (activeForRule) {
    transitionImplementationState(stateDir, activeForRule.id, 'disabled');

    output += isZh
      ? `\n上一个活跃实现已禁用: ${activeForRule.id}\n   状态: active -> disabled`
      : `\nPrevious active implementation disabled: ${activeForRule.id}\n   State: active -> disabled`;
  }

  const eventsDir = path.join(
    stateDir,
    'principles',
    'implementations',
    implId,
    'events',
  );
  if (!fs.existsSync(eventsDir)) {
    fs.mkdirSync(eventsDir, { recursive: true });
  }
  const eventPath = path.join(eventsDir, 'promotion.json');
  const promotionEvent = {
    eventType: 'promotion',
    implementationId: implId,
    ruleId: candidate.ruleId,
    fromState: 'candidate',
    toState: 'active',
    previousActive: activeForRule?.id ?? null,
    replayReportId: report
      ? report.generatedAt.replace(/[:.]/g, '-')
      : null,
    promotedAt: new Date().toISOString(),
  };
  withLock(eventPath, () => {
    atomicWriteFileSync(eventPath, JSON.stringify(promotionEvent, null, 2));
  });
  try {
    refreshPrincipleLifecycle(workspaceDir, stateDir);
  } catch (err) {
    console.warn('[promote-impl] Lifecycle refresh failed (promotion):', err instanceof Error ? err.stack : err);
  }

  output += isZh
    ? `\n\n✅ 实现已晋升: ${implId}\n   状态: candidate -> active`
    : `\n\n✅ Implementation promoted: ${implId}\n   State: candidate -> active`;

  return { text: output };
}

export function handlePromoteImplCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'promote-impl');
  const {stateDir} = WorkspaceContext.fromHookContext({ ...ctx, workspaceDir });
  const lang = (ctx.config?.language as string) || 'en';
  const isZh = lang === 'zh';

  const args = (ctx.args || '').trim().split(/\s+/);
  const subcommand = args[0] || '';
  const implId = args[1] || '';

  if (subcommand === 'list' || subcommand === '') {
    return _handleListCandidates(stateDir, isZh);
  }

  if (subcommand === 'show') {
    if (!implId) {
      return {
        text: isZh
          ? '请指定要查看的实现ID: /pd-promote-impl show <implId>'
          : 'Please specify an implementation ID: /pd-promote-impl show <implId>',
      };
    }
    return _handleShowReport(stateDir, implId, isZh);
  }

  if (subcommand === 'eval') {
    if (!implId) {
      return {
        text: isZh
          ? '请指定要评估的实现ID: /pd-promote-impl eval <implId>'
          : 'Please specify an implementation ID: /pd-promote-impl eval <implId>',
      };
    }
    return _handleRunReplay({ workspaceDir, stateDir, implId, isZh });
  }

  return _handlePromoteImpl({ workspaceDir, stateDir, implId: subcommand, isZh });
}
