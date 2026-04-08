/**
 * Rollback Implementation Command — CLI `/pd-rollback-impl`
 * ==========================================================
 *
 * PURPOSE: Revert the current active implementation and restore the previous one.
 *
 * FLOW:
 *   1. List active implementations
 *   2. On confirm: current -> disabled, previous -> active
 *
 * SAFETY:
 *   - If no previous active: current -> disabled (degrades to hard-boundary gates)
 *   - Rollback records persisted with full audit trail
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { refreshPrincipleLifecycle } from '../core/principle-internalization/lifecycle-refresh.js';
import {
  loadLedger,
  transitionImplementationState,
} from '../core/principle-tree-ledger.js';
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
 * Handle the /pd-rollback-impl command.
 *
 * Usage:
 *   /pd-rollback-impl list                          - List active implementations
 *   /pd-rollback-impl <implId>                      - Rollback current active
 *   /pd-rollback-impl <implId> --reason "<reason>"  - Rollback with reason
 */
export function handleRollbackImplCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const stateDir = WorkspaceContext.fromHookContext({ ...ctx, workspaceDir }).stateDir;
  const lang = (ctx.config?.language as string) || 'en';
  const isZh = lang === 'zh';

  const args = (ctx.args || '').trim();

  // Parse args
  const subcommand = args.split(/\s+/)[0] || '';
  const implId = subcommand === 'list' ? '' : subcommand;
  const reasonMatch = args.match(/--reason\s+"([^"]+)"/) || args.match(/--reason\s+(\S+)/);
  const reason = reasonMatch ? reasonMatch[1] : null;

  // List active
  if (subcommand === 'list' || subcommand === '') {
    return _handleListActiveRollback(stateDir, isZh);
  }

  return _handleRollbackImpl(workspaceDir, stateDir, implId, reason, isZh, ctx.sessionId);
}

function _handleListActiveRollback(
  stateDir: string,
  isZh: boolean
): PluginCommandResult {
  const allImpls = getAllImplementations(stateDir);
  const activeImpls = allImpls.filter(
    (impl) => (impl as any).lifecycleState === 'active'
  );

  if (activeImpls.length === 0) {
    return {
      text: isZh
        ? '\n\u2139\ufe0f \u6ca1\u6709\u6d3b\u8dc3\u5b9e\u73b0\u53ef\u56de\u6eda\u3002'
        : '\n\u2139\ufe0f No active implementations to rollback.',
    };
  }

  let output = isZh ? '\n\ud83d\udccb \u53ef\u56de\u6eda\u6d3b\u8dc3\u5b9e\u73b0\n' : '\n\ud83d\udccb Active Implementations Available for Rollback\n';
  output += `${'='.repeat(50)}\n`;

  for (const impl of activeImpls) {
    const hasPrevious = (impl as any).previousActive ? '\u2705' : '\u26a0\ufe0f \u65e0\u524d\u4e00\u4e2a';
    output += `  ${impl.id}\n`;
    output += `    Rule: ${impl.ruleId} | Version: ${impl.version}\n`;
    output += `    Has previous: ${hasPrevious}\n`;
    if ((impl as any).previousActive) {
      output += `    Previous: ${(impl as any).previousActive}\n`;
    }
    output += '\n';
  }

  output += isZh
    ? '\u7528\u6cd5: /pd-rollback-impl <implId> --reason "\u539f\u56e0"'
    : 'Usage: /pd-rollback-impl <implId> --reason "reason"';

  return { text: output };
}

function _handleRollbackImpl(
  workspaceDir: string,
  stateDir: string,
  implId: string,
  reason: string | null,
  isZh: boolean,
  sessionId?: string,
): PluginCommandResult {
  const allImpls = getAllImplementations(stateDir);
  const currentActive = allImpls.find((i) => i.id === implId);

  if (!currentActive) {
    return {
      text: isZh
        ? `\u274c \u672a\u627e\u5230\u5b9e\u73b0: ${implId}`
        : `\u274c Implementation not found: ${implId}`,
    };
  }

  const currentState = (currentActive as any).lifecycleState;
  if (currentState !== 'active') {
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0 ${implId} \u5f53\u524d\u72b6\u6001: ${currentState}\n\u53ea\u80fd\u56de\u6eda\u6d3b\u8dc3\u5b9e\u73b0\u3002`
        : `\u274c Implementation ${implId} is in state: ${currentState}\nCan only rollback active implementations.`,
    };
  }

  const previousActiveId = (currentActive as any).previousActive;
  const reasonText = reason || (isZh ? '\u7528\u6237\u624b\u52a8\u56de\u6eda' : 'User manual rollback');

  // Step 1: Current active -> disabled
  transitionImplementationState(stateDir, implId, 'disabled');

  let restoredMessage = '';

  if (previousActiveId && allImpls.some((i) => i.id === previousActiveId)) {
    // Step 2: Restore previous active -> active
    transitionImplementationState(stateDir, previousActiveId, 'active');

    restoredMessage = isZh
      ? `\n   \u5df2\u6062\u590d\u524d\u4e00\u4e2a\u6d3b\u8dc3\u5b9e\u73b0: ${previousActiveId}\n   \u72b6\u6001: disabled -> active`
      : `\n   Restored previous active implementation: ${previousActiveId}\n   State: disabled -> active`;
  } else {
    // No previous active — degrade to hard-boundary gates (per Phase 12 D-08)
    restoredMessage = isZh
      ? `\n   \u26a0\ufe0f \u6ca1\u6709\u524d\u4e00\u4e2a\u6d3b\u8dc3\u5b9e\u73b0\uff0c\u8be5\u89c4\u5219\u6ca1\u6709\u6d3b\u8dc3\u5b9e\u73b0\u3002`
        + `\n   GFI\u3001Progressive Gate\u7b49\u786c\u56fa\u62b1\u95e8\u4ecd\u7136\u6b63\u5e38\u8fd0\u884c\u3002`
      : `\n   \u26a0\ufe0f No previous active implementation. Rule has no active code implementation.`
        + ` Existing hard-boundary gates (GFI, Progressive Gate) continue functioning normally.`;
  }

  // Store rollback record
  const rollbackDir = path.join(
    stateDir,
    'principles',
    'implementations',
    implId,
    'rollbacks'
  );
  if (!fs.existsSync(rollbackDir)) {
    fs.mkdirSync(rollbackDir, { recursive: true });
  }

  const rollbackRecord = {
    rolledBackBy: sessionId || 'manual',
    rolledBackAt: new Date().toISOString(),
    reason: reasonText,
    previousImplementationId: previousActiveId || null,
    restoredImplementationId: previousActiveId && allImpls.some((i) => i.id === previousActiveId)
      ? previousActiveId
      : null,
    rolledBackImplId: implId,
  };

  const rollbackTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = path.join(rollbackDir, `${rollbackTimestamp}.json`);
  withLock(rollbackPath, () => {
    fs.writeFileSync(rollbackPath, JSON.stringify(rollbackRecord, null, 2), 'utf-8');
  });
  refreshPrincipleLifecycle(workspaceDir, stateDir);

  let output = isZh
    ? `\n\u2705 \u56de\u6eda\u5b8c\u6210: ${implId}\n   \u72b6\u6001: active -> disabled\n   \u539f\u56e0: ${reasonText}`
    : `\n\u2705 Rollback complete: ${implId}\n   State: active -> disabled\n   Reason: ${reasonText}`;

  output += restoredMessage;

  return { text: output };
}

/**
 * Handle natural language rollback request.
 * Detects phrases like "回滚这个规则实现", "rollback this implementation".
 */
export function handleNaturalLanguageRollbackImpl(
  workspaceDir: string,
  sessionId: string | undefined,
  reason: string
): { success: boolean; message: string } {
  const isZh = reason.match(/[\u4e00-\u9fff]/) || false;
  const stateDir = WorkspaceContext.fromHookContext({ workspaceDir }).stateDir;

  if (!sessionId) {
    return {
      success: false,
      message: isZh ? '\u65e0\u6cd5\u8bc6\u522b\u5f53\u524d\u4f1a\u8bdd' : 'Session not found',
    };
  }

  // Natural language entry: get last active implementation
  const allImpls = getAllImplementations(stateDir);
  const lastActive = allImpls.find((i) => (i as any).lifecycleState === 'active');

  if (!lastActive) {
    return {
      success: false,
      message: isZh ? '\u5f53\u524d\u6ca1\u6709\u6d3b\u8dc3\u5b9e\u73b0' : 'No active implementations',
    };
  }

  // Would be called via the hook — return the impl ID for the hook to route
  return {
    success: true,
    message: `${lastActive.id}|${reason}`,
  };
}
