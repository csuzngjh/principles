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
import { withLock } from '../utils/file-lock.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import {
  loadLedger,
  findActiveImplementation,
  listImplementationsForRule,
} from '../core/principle-tree-ledger.js';
import { ReplayEngine, formatReplayReport } from '../core/replay-engine.js';
import type { Implementation } from '../types/principle-tree-schema.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

/**
 * Get all implementations from the ledger.
 */
function getAllImplementations(stateDir: string): Implementation[] {
  const ledger = loadLedger(stateDir);
  return Object.values(ledger.tree.implementations);
}

/**
 * Handle the /pd-promote-impl command.
 *
 * Usage:
 *   /pd-promote-impl list                          - List candidates
 *   /pd-promote-impl show <implId>                 - Show replay report
 *   /pd-promote-impl <implId>                      - Promote a candidate
 */
export function handlePromoteImplCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const stateDir = workspaceDir;
  const lang = (ctx.config?.language as string) || 'en';
  const isZh = lang === 'zh';

  const args = (ctx.args || '').trim().split(/\s+/);
  const subcommand = args[0] || '';
  const implId = args[1] || '';

  // Subcommand: list
  if (subcommand === 'list' || subcommand === '') {
    return _handleListCandidates(stateDir, isZh);
  }

  // Subcommand: show
  if (subcommand === 'show') {
    if (!implId) {
      return {
        text: isZh
          ? '\u8bf7\u6307\u5b9a\u8981\u67e5\u770b\u7684\u5b9e\u73b0ID: /pd-promote-impl show <implId>'
          : 'Please specify an implementation ID: /pd-promote-impl show <implId>',
      };
    }
    return _handleShowReport(stateDir, implId, isZh);
  }

  // Promote by ID
  return _handlePromoteImpl(stateDir, subcommand, isZh);
}

function _handleListCandidates(
  stateDir: string,
  isZh: boolean
): PluginCommandResult {
  const engine = new ReplayEngine('', stateDir);
  const allImpls = getAllImplementations(stateDir);
  const candidates = allImpls.filter(
    (impl) => (impl as any).lifecycleState === 'candidate'
  );

  if (candidates.length === 0) {
    return {
      text: isZh
        ? '\n\u2139\ufe0f \u672a\u627e\u5230\u5019\u9009\u5b9e\u73b0\u3002\n\n\u7528\u6cd5: /pd-promote-impl list'
        : '\n\u2139\ufe0f No candidate implementations found.\n\nUsage: /pd-promote-impl list',
    };
  }

  let output = isZh ? '\n\ud83d\udccb \u5019\u9009\u5b9e\u73b0\u5217\u8868\n' : '\n\ud83d\udccb Candidate Implementations\n';
  output += `${'='.repeat(50)}\n`;

  for (const impl of candidates) {
    const hasPass = engine.hasPassingReport(impl.id);
    const passBadge = hasPass
      ? isZh ? '\u2705 \u6709\u901a\u8fc7\u62a5\u544a' : '\u2705 Has pass report'
      : isZh ? '\u274c \u65e0\u901a\u8fc7\u62a5\u544a' : '\u274c No pass report';
    output += `  ${impl.id}\n`;
    output += `    Rule: ${impl.ruleId} | Version: ${impl.version}\n`;
    output += `    Replay: ${passBadge}\n\n`;
  }

  return { text: output };
}

function _handleShowReport(
  stateDir: string,
  implId: string,
  isZh: boolean
): PluginCommandResult {
  const engine = new ReplayEngine('', stateDir);
  const report = engine.getLatestReport(implId);

  if (!report) {
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0 ${implId} \u6ca1\u6709\u56de\u653e\u62a5\u544a\u3002`
        : `\u274c No replay report found for implementation ${implId}.`,
    };
  }

  const formatted = formatReplayReport(report);
  return { text: formatted };
}

function _handlePromoteImpl(
  stateDir: string,
  implId: string,
  isZh: boolean
): PluginCommandResult {
  const engine = new ReplayEngine('', stateDir);
  const allImpls = getAllImplementations(stateDir);
  const candidate = allImpls.find((i) => i.id === implId);

  if (!candidate) {
    return {
      text: isZh
        ? `\u274c \u672a\u627e\u5230\u5b9e\u73b0: ${implId}`
        : `\u274c Implementation not found: ${implId}`,
    };
  }

  const currentState = (candidate as any).lifecycleState || 'candidate';

  // Validate: only promote from candidate or disabled (re-enable)
  if (currentState !== 'candidate' && currentState !== 'disabled') {
    return {
      text: isZh
        ? `\u274c \u53ea\u80fd\u4fc3\u8fdb candidate \u6216 disabled \u72b6\u6001\u7684\u5b9e\u73b0\u3002\u5f53\u524d: ${currentState}`
        : `\u274c Can only promote 'candidate' or 'disabled' implementations. Current: ${currentState}`,
    };
  }

  // Validate: must have passing replay report
  if (!engine.hasPassingReport(implId)) {
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0 ${implId} \u6ca1\u6709\u901a\u8fc7\u7684\u56de\u653e\u62a5\u544a\uff0c\u65e0\u6cd5\u4fc3\u8fdb\u3002\n\n\u8bf7\u5148\u8fd0\u884c\u56de\u653e\u8bc4\u4f30\u3002`
        : `\u274c Implementation ${implId} has no passing replay report. Promotion rejected.\n\nPlease run a replay evaluation first.`,
    };
  }

  // Show report summary
  const report = engine.getLatestReport(implId);
  let output = '';
  if (report) {
    output = formatReplayReport(report) + '\n';
  }

  // If re-enabling (disabled -> active), simpler flow
  if (currentState === 'disabled') {
    // Transition disabled -> active
    const ledger = loadLedger(stateDir);
    const impl = ledger.tree.implementations[implId];
    if (!impl) {
      return {
        text: isZh
          ? `\u274c \u5b9e\u73b0\u5df2\u4e0d\u5b58\u5728: ${implId}`
          : `\u274c Implementation gone: ${implId}`,
      };
    }

    (impl as any).lifecycleState = 'active';
    impl.updatedAt = new Date().toISOString();
    ledger.tree.implementations[implId] = impl;

    // Write ledger atomically
    const ledgerPath = path.join(stateDir, 'principle_training_state.json');
    withLock(ledgerPath, () => {
      fs.writeFileSync(ledgerPath, JSON.stringify(
        { _tree: ledger.tree }, null, 2
      ), 'utf-8');
    });

    output += isZh
      ? `\n\u2705 \u5b9e\u73b0\u5df2\u91cd\u65b0\u542f\u7528: ${implId}\n   \u72b6\u6001: disabled -> active`
      : `\n\u2705 Implementation re-enabled: ${implId}\n   State: disabled -> active`;

    return { text: output };
  }

  // Promotion flow: candidate -> active
  // Find current active for same rule
  const activeForRule = findActiveImplementation(stateDir, candidate.ruleId);

  // Record previousActive on candidate
  const ledger = loadLedger(stateDir);
  const candidateImpl = ledger.tree.implementations[implId];
  if (!candidateImpl) {
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0\u5df2\u4e0d\u5b58\u5728: ${implId}`
        : `\u274c Implementation gone: ${implId}`,
    };
  }

  // Set previousActive before transition
  if (activeForRule) {
    (candidateImpl as any).previousActive = activeForRule.id;
  }

  // Transition: candidate -> active
  (candidateImpl as any).lifecycleState = 'active';
  candidateImpl.updatedAt = new Date().toISOString();
  ledger.tree.implementations[implId] = candidateImpl;

  // Transition previous active -> disabled
  if (activeForRule) {
    const activeImpl = ledger.tree.implementations[activeForRule.id];
    if (activeImpl) {
      (activeImpl as any).lifecycleState = 'disabled';
      activeImpl.updatedAt = new Date().toISOString();
      ledger.tree.implementations[activeForRule.id] = activeImpl;

      output += isZh
        ? `\n\u524d\u4e00\u4e2a\u6d3b\u8dc3\u5b9e\u73b0\u5df2\u7981\u7528: ${activeForRule.id}\n   \u72b6\u6001: active -> disabled`
        : `\nPrevious active implementation disabled: ${activeForRule.id}\n   State: active -> disabled`;
    }
  }

  // Write ledger atomically
  const ledgerPath = path.join(stateDir, 'principle_training_state.json');
  withLock(ledgerPath, () => {
    fs.writeFileSync(ledgerPath, JSON.stringify(
      { _tree: ledger.tree }, null, 2
    ), 'utf-8');
  });

  // Record promotion event in ledger evolution log
  const eventsDir = path.join(
    stateDir,
    '.state',
    'principles',
    'implementations',
    implId,
    'events'
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
    fs.writeFileSync(eventPath, JSON.stringify(promotionEvent, null, 2), 'utf-8');
  });

  output += isZh
    ? `\n\n\u2705 \u5b9e\u73b0\u5df2\u4fc3\u8fdb: ${implId}\n   \u72b6\u6001: candidate -> active`
    : `\n\n\u2705 Implementation promoted: ${implId}\n   State: candidate -> active`;

  return { text: output };
}
