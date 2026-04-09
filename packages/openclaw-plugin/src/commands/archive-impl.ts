/**
 * Archive Implementation Command — CLI `/pd-archive-impl`
 * ========================================================
 *
 * PURPOSE: Permanently archive an implementation (disabled -> archived,
 * active -> archived, or candidate -> archived).
 *
 * Used for permanent cleanup of implementations that are no longer relevant.
 */

import { WorkspaceContext } from '../core/workspace-context.js';
import { refreshPrincipleLifecycle } from '../core/principle-internalization/lifecycle-refresh.js';
import {
  loadLedger,
  transitionImplementationState,
  updateImplementation,
} from '../core/principle-tree-ledger.js';
import type { Implementation, ImplementationLifecycleState } from '../types/principle-tree-schema.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';

/**
 * Get all implementations from the ledger.
 */
function getAllImplementations(stateDir: string): Implementation[] {
  const ledger = loadLedger(stateDir);
  return Object.values(ledger.tree.implementations);
}

/**
 * Valid archive transitions: disabled -> archived, active -> archived, candidate -> archived
 */
function canArchive(state: ImplementationLifecycleState): boolean {
  return ['disabled', 'active', 'candidate'].includes(state);
}

/**
 * Handle the /pd-archive-impl command.
 *
 * Usage:
 *   /pd-archive-impl <implId>   - Archive an implementation
 *   /pd-archive-impl list       - List archivable implementations
 */
export function handleArchiveImplCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const {stateDir} = WorkspaceContext.fromHookContext({ ...ctx, workspaceDir });
  const lang = (ctx.config?.language as string) || 'en';
  const isZh = lang === 'zh';

  const args = (ctx.args || '').trim().split(/\s+/);
  const subcommand = args[0] || '';

  // Subcommand: list
  if (subcommand === 'list') {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: Mutual recursion between helper functions - reordering would break logical grouping
    return _handleListArchivable(stateDir, isZh);
  }

  // Archive by ID
  const targetId = subcommand;
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: Mutual recursion between helper functions - reordering would break logical grouping
  return _handleArchiveImpl(workspaceDir, stateDir, targetId, isZh);
}

function _handleListArchivable(
  stateDir: string,
  isZh: boolean
): PluginCommandResult {
  const allImpls = getAllImplementations(stateDir);
  const archivable = allImpls.filter(
    (impl) => canArchive(impl.lifecycleState || 'candidate')
  );

  if (archivable.length === 0) {
    return {
      text: isZh
        ? '\n\u2139\ufe0f \u6ca1\u6709\u53ef\u5f52\u6863\u7684\u5b9e\u73b0\u3002'
        : '\n\u2139\ufe0f No implementations available to archive.',
    };
  }

  let output = isZh ? '\n\ud83d\udccb \u53ef\u5f52\u6863\u5b9e\u73b0\n' : '\n\ud83d\udccb Available Implementations to Archive\n';
  output += `${'='.repeat(50)}\n`;

  for (const impl of archivable) {
    const stateLabel = impl.lifecycleState || 'candidate';
    output += `  ${impl.id}\n`;
    output += `    Rule: ${impl.ruleId} | State: ${stateLabel}\n\n`;
  }

  output += isZh
    ? '\u7528\u6cd5: /pd-archive-impl <implId>'
    : 'Usage: /pd-archive-impl <implId>';

  return { text: output };
}

// eslint-disable-next-line @typescript-eslint/max-params -- Reason: Command handler signature must match OpenClaw plugin interface - breaking API change to options objects would affect public contracts
function _handleArchiveImpl(
  workspaceDir: string,
  stateDir: string,
  implId: string,
  isZh: boolean
): PluginCommandResult {
  const allImpls = getAllImplementations(stateDir);
  const target = allImpls.find((i) => i.id === implId);

  if (!target) {
    return {
      text: isZh
        ? `\u274c \u672a\u627e\u5230\u5b9e\u73b0: ${implId}`
        : `\u274c Implementation not found: ${implId}`,
    };
  }

  const currentState = target.lifecycleState || 'candidate';

  if (!canArchive(currentState)) {
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0 ${implId} \u4e0d\u80fd\u4ece ${currentState} \u5f52\u6863\u3002\u5df2\u5f52\u6863\u7684\u5b9e\u73b0\u4e0d\u80fd\u518d\u6b21\u5f52\u6863\u3002`
        : `\u274c Implementation ${implId} cannot be archived from state: ${currentState}. Archived implementations cannot be archived again.`,
    };
  }

  transitionImplementationState(stateDir, implId, 'archived');
  updateImplementation(stateDir, implId, {
    archivedAt: new Date().toISOString(),
  });
  refreshPrincipleLifecycle(workspaceDir, stateDir);

  return {
    text: isZh
      ? `\n\u2705 \u5b9e\u73b0\u5df2\u5f52\u6863: ${implId}\n   \u72b6\u6001: ${currentState} -> archived`
      : `\n\u2705 Implementation archived: ${implId}\n   State: ${currentState} -> archived`,
  };
}
