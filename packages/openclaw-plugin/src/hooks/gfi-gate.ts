/**
 * GFI Gate Module
 *
 * Handles Fatigue Index (GFI) based tool blocking with TIER 0-3 classification.
 *
 * **Responsibilities:**
 * - Calculate dynamic GFI thresholds based on EP tier and line changes
 * - Apply tier-based tool blocking:
 *   - TIER 0: Read-only tools (never blocked)
 *   - TIER 1: Low-risk writes (blocked when GFI >= low_risk_block threshold)
 *   - TIER 2: High-risk operations (blocked when GFI >= high_risk_block threshold)
 *   - TIER 3: Bash commands (content-dependent blocking)
 * - Prevent subagent spawn at critically high GFI (>=90)
 *
 * **Configuration:**
 * - GFI thresholds from config.gfi_gate
 * - EP tier multipliers for dynamic threshold calculation
 * - Large change adjustments
 *
 * **Block Persistence:**
 * - Uses shared `recordGateBlockAndReturn` from gate-block-helper.ts
 * - Ensures single authoritative block persistence path
 */

import { getSession } from '../core/session-tracker.js';
import { estimateLineChanges } from '../core/risk-calculator.js';
import { analyzeBashCommand, calculateDynamicThreshold, type DynamicThresholdConfig } from './bash-risk.js';
import { BASH_TOOLS_SET, HIGH_RISK_TOOLS, LOW_RISK_WRITE_TOOLS, AGENT_TOOLS } from '../constants/tools.js';
import { AGENT_SPAWN_GFI_THRESHOLD } from '../config/index.js';
import { recordGateBlockAndReturn } from './gate-block-helper.js';
import { getEvolutionEngine } from '../core/evolution-engine.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export interface GfiGateConfig {
  enabled?: boolean;
  thresholds?: {
    low_risk_block?: number;
    high_risk_block?: number;
  };
  large_change_lines?: number;
  ep_tier_multipliers?: Record<string, number>;
  bash_safe_patterns?: string[];
  bash_dangerous_patterns?: string[];
}

/**
 * Internal helper to call the shared block helper with gfi-gate source tag.
 */
function block(
  wctx: WorkspaceContext,
  filePath: string,
  reason: string,
  toolName: string,
  sessionId: string | undefined,
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void }
): PluginHookBeforeToolCallResult {
  return recordGateBlockAndReturn(wctx, {
    filePath,
    reason,
    toolName,
    sessionId,
    blockSource: 'gfi-gate',
  }, logger || { warn: () => {}, error: () => {} });
}

export function checkGfiGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  sessionId: string | undefined,
  config: GfiGateConfig,
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
): PluginHookBeforeToolCallResult | undefined {
  if (!config || config.enabled === false || !sessionId) {
    return undefined;
  }

  const session = getSession(sessionId);
  const currentGfi = session?.currentGfi || 0;

  // TIER 3: Bash commands
  if (BASH_TOOLS_SET.has(event.toolName)) {
    const command = String(event.params.command || event.params.args || '');
    const bashRisk = analyzeBashCommand(
      command,
      config.bash_safe_patterns || [],
      config.bash_dangerous_patterns || [],
      logger
    );

    if (bashRisk === 'dangerous') {
      logger?.warn?.(`[PD:GFI_GATE] Dangerous bash command blocked: ${command.substring(0, 50)}...`);
      return block(wctx, command.substring(0, 100), `危险命令被拦截。检测到危险命令模式，需要确认执行意图。`, event.toolName, sessionId, logger);
    }

    if (bashRisk === 'safe') {
      return undefined;
    }

    // normal bash - check GFI threshold
    const evolutionEngine = getEvolutionEngine(wctx.workspaceDir);
    const tier = evolutionEngine.getTier();
    const baseThreshold = config.thresholds?.low_risk_block || 70;
    const dynamicThreshold = calculateDynamicThreshold(
      baseThreshold,
      tier,
      0,
      {
        large_change_lines: config.large_change_lines || 50,
        ep_tier_multipliers: config.ep_tier_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5, '5': 2.0 },
      }
    );

    if (currentGfi >= dynamicThreshold) {
      logger?.warn?.(`[PD:GFI_GATE] Bash blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return block(wctx, command.substring(0, 100), `疲劳指数过高 (GFI: ${currentGfi}/${dynamicThreshold})。系统进入保护模式。`, event.toolName, sessionId, logger);
    }

    return undefined;
  }

  // TIER 2: High-risk tools
  if (HIGH_RISK_TOOLS.has(event.toolName)) {
    const evolutionEngine = getEvolutionEngine(wctx.workspaceDir);
    const tier = evolutionEngine.getTier();
    const baseThreshold = config.thresholds?.high_risk_block || 40;
    const dynamicThreshold = calculateDynamicThreshold(
      baseThreshold,
      tier,
      0,
      {
        large_change_lines: config.large_change_lines || 50,
        ep_tier_multipliers: config.ep_tier_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5, '5': 2.0 },
      }
    );

    if (currentGfi >= dynamicThreshold) {
      const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
      logger?.warn?.(`[PD:GFI_GATE] High-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return block(wctx, filePath, `高风险操作被拦截。GFI: ${currentGfi}/${dynamicThreshold}。高风险工具需要更低的阈值。`, event.toolName, sessionId, logger);
    }
  }

  // TIER 1: Low-risk write tools
  if (LOW_RISK_WRITE_TOOLS.has(event.toolName)) {
    const evolutionEngine = getEvolutionEngine(wctx.workspaceDir);
    const tier = evolutionEngine.getTier();
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
    const baseThreshold = config.thresholds?.low_risk_block || 70;
    const dynamicThreshold = calculateDynamicThreshold(
      baseThreshold,
      tier,
      lineChanges,
      {
        large_change_lines: config.large_change_lines || 50,
        ep_tier_multipliers: config.ep_tier_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5, '5': 2.0 },
      }
    );

    if (currentGfi >= dynamicThreshold) {
      const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
      logger?.warn?.(`[PD:GFI_GATE] Low-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return block(wctx, filePath, `疲劳指数过高 (GFI: ${currentGfi}/${dynamicThreshold})。系统进入保护模式。`, event.toolName, sessionId, logger);
    }
  }

  // AGENT_TOOLS: Block subagent spawn when GFI is critically high
  if (AGENT_TOOLS.has(event.toolName)) {
    if (currentGfi >= AGENT_SPAWN_GFI_THRESHOLD) {
      logger?.warn?.(`[PD:GFI_GATE] Agent tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${AGENT_SPAWN_GFI_THRESHOLD}`);
      return block(wctx, 'subagent-spawn', `疲劳指数过高，禁止派生子智能体。GFI: ${currentGfi}/${AGENT_SPAWN_GFI_THRESHOLD}`, event.toolName, sessionId, logger);
    }
  }

  return undefined;
}