/**
 * Disable Implementation Command — CLI `/pd-disable-impl`
 * ========================================================
 *
 * PURPOSE: Manually disable an active implementation (e.g., regression in production).
 *
 * FLOW:
 *   1. List active implementations
 *   2. Select target, ask for reason
 *   3. Transition active -> disabled (or candidate -> disabled)
 *   4. Record disabledAt, disabledBy, disabledReason
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import {
  loadLedger,
  isValidLifecycleTransition,
  listImplementationsForRule,
  getAllowedTransitions,
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
 * Handle the /pd-disable-impl command.
 *
 * Usage:
 *   /pd-disable-impl list                        - List active implementations
 *   /pd-disable-impl <implId>                    - Disable an implementation
 *   /pd-disable-impl <implId> --reason "<reason>" - Disable with reason
 */
export function handleDisableImplCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const stateDir = workspaceDir;
  const lang = (ctx.config?.language as string) || 'en';
  const isZh = lang === 'zh';

  const args = (ctx.args || '').trim();

  // Parse args: [implId] [--reason "..."]
  const parts = args.split(/\s+/);
  const subcommand = parts[0] || '';
  const implId = subcommand === 'list' ? '' : subcommand;
  const reasonMatch = args.match(/--reason\s+"([^"]+)"/) || args.match(/--reason\s+(\S+)/);
  const reason = reasonMatch ? reasonMatch[1] : null;

  // Subcommand: list
  if (subcommand === 'list' || subcommand === '') {
    return _handleListActive(stateDir, isZh);
  }

  // Disable
  return _handleDisableImpl(stateDir, implId, reason, isZh);
}

function _handleListActive(
  stateDir: string,
  isZh: boolean
): PluginCommandResult {
  const allImpls = getAllImplementations(stateDir);
  const activeImpls = allImpls.filter(
    (impl) => (impl as any).lifecycleState === 'active' || (impl as any).lifecycleState === 'candidate'
  );

  if (activeImpls.length === 0) {
    return {
      text: isZh
        ? '\n\u2139\ufe0f \u6ca1\u6709\u53ef\u7981\u7528\u7684\u5b9e\u73b0\u3002'
        : '\n\u2139\ufe0f No implementations available to disable.',
    };
  }

  let output = isZh
    ? '\n\ud83d\udccb \u53ef\u7981\u7528\u5b9e\u73b0\n'
    : '\n\ud83d\udccb Available Implementations to Disable\n';
  output += `${'='.repeat(50)}\n`;

  for (const impl of activeImpls) {
    const stateLabel = (impl as any).lifecycleState || 'candidate';
    output += `  ${impl.id}\n`;
    output += `    Rule: ${impl.ruleId} | State: ${stateLabel} | Version: ${impl.version}\n`;
    if ((impl as any).disabledReason) {
      output += `    Previous reason: ${(impl as any).disabledReason}\n`;
    }
    output += '\n';
  }

  output += isZh
    ? `\u7528\u6cd5: /pd-disable-impl <implId> --reason "\u539f\u56e0"`
    : `Usage: /pd-disable-impl <implId> --reason "reason"`;

  return { text: output };
}

function _handleDisableImpl(
  stateDir: string,
  implId: string,
  reason: string | null,
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

  const currentState = (target as any).lifecycleState || 'candidate';

  // Validate: active -> disabled or candidate -> disabled
  if (currentState !== 'active' && currentState !== 'candidate') {
    const allowed = getAllowedTransitions(currentState as ImplementationLifecycleState);
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0 ${implId} \u5f53\u524d\u72b6\u6001: ${currentState}\n\u5141\u8bb8\u8fc7\u6e21: ${allowed.join(', ') || '\u65e0\u8fc7\u6e21'}`
        : `\u274c Implementation ${implId} is in state: ${currentState}\nAllowed transitions: ${allowed.join(', ') || 'none'}`,
    };
  }

  const reasonText = reason || (isZh ? '\u7528\u6237\u624b\u52a8\u7981\u7528' : 'User manual disable');

  // Perform transition
  const ledger = loadLedger(stateDir);
  const impl = ledger.tree.implementations[implId];
  if (!impl) {
    return {
      text: isZh
        ? `\u274c \u5b9e\u73b0\u5df2\u4e0d\u5b58\u5728: ${implId}`
        : `\u274c Implementation gone: ${implId}`,
    };
  }

  (impl as any).lifecycleState = 'disabled';
  (impl as any).disabledAt = new Date().toISOString();
  (impl as any).disabledBy = (ctx as any).sessionId || 'manual';
  (impl as any).disabledReason = reasonText;
  impl.updatedAt = new Date().toISOString();
  ledger.tree.implementations[implId] = impl;

  // Write ledger atomically
  const ledgerPath = path.join(stateDir, 'principle_training_state.json');
  withLock(ledgerPath, () => {
    fs.writeFileSync(ledgerPath, JSON.stringify(
      { _tree: ledger.tree }, null, 2
    ), 'utf-8');
  });

  return {
    text: isZh
      ? `\n\u2705 \u5b9e\u73b0\u5df2\u7981\u7528: ${implId}\n   \u72b6\u6001: ${currentState} -> disabled\n   \u539f\u56e0: ${reasonText}`
      : `\n\u2705 Implementation disabled: ${implId}\n   State: ${currentState} -> disabled\n   Reason: ${reasonText}`,
  };
}
