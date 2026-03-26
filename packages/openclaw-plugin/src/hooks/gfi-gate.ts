/**
 * GFI Gate Module
 *
 * Handles Fatigue Index (GFI) based tool blocking with TIER 0-3 classification.
 *
 * **Responsibilities:**
 * - Calculate dynamic GFI thresholds based on trust stage and line changes
 * - Apply tier-based tool blocking:
 *   - TIER 0: Read-only tools (never blocked)
 *   - TIER 1: Low-risk writes (blocked when GFI >= low_risk_block threshold)
 *   - TIER 2: High-risk operations (blocked when GFI >= high_risk_block threshold)
 *   - TIER 3: Bash commands (content-dependent blocking)
 * - Prevent subagent spawn at critically high GFI (>=90)
 *
 * **Configuration:**
 * - GFI thresholds from config.gfi_gate
 * - Trust stage multipliers for dynamic threshold calculation
 * - Large change adjustments
 */

import { getSession } from '../core/session-tracker.js';
import { estimateLineChanges } from '../core/risk-calculator.js';
import { analyzeBashCommand, calculateDynamicThreshold, type DynamicThresholdConfig } from './bash-risk.js';
import { BASH_TOOLS_SET, HIGH_RISK_TOOLS, LOW_RISK_WRITE_TOOLS, AGENT_TOOLS } from '../constants/tools.js';
import { AGENT_SPAWN_GFI_THRESHOLD } from '../config/index.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export interface GfiGateConfig {
  enabled?: boolean;
  thresholds?: {
    low_risk_block?: number;
    high_risk_block?: number;
  };
  large_change_lines?: number;
  trust_stage_multipliers?: Record<string, number>;
  bash_safe_patterns?: string[];
  bash_dangerous_patterns?: string[];
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
      return {
        block: true,
        blockReason: `[GFI Gate] 危险命令被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}

原因: 检测到危险命令模式，需要确认执行意图。

解决方案:
1. 如果确实需要执行，请确认操作意图后重试
2. 使用更安全的方式（如手动操作）
3. 咨询用户确认是否继续

注意: 危险命令需要更严格的审批流程。`,
      };
    }

    if (bashRisk === 'safe') {
      return undefined;
    }

    // normal bash - check GFI threshold
    const trustEngine = wctx.trust;
    const stage = trustEngine.getStage();
    const baseThreshold = config.thresholds?.low_risk_block || 70;
    const dynamicThreshold = calculateDynamicThreshold(
      baseThreshold,
      stage,
      0,
      {
        large_change_lines: config.large_change_lines || 50,
        trust_stage_multipliers: config.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
      }
    );

    if (currentGfi >= dynamicThreshold) {
      logger?.warn?.(`[PD:GFI_GATE] Bash blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
      };
    }

    return undefined;
  }

  // TIER 2: High-risk tools
  if (HIGH_RISK_TOOLS.has(event.toolName)) {
    const trustEngine = wctx.trust;
    const stage = trustEngine.getStage();
    const baseThreshold = config.thresholds?.high_risk_block || 40;
    const dynamicThreshold = calculateDynamicThreshold(
      baseThreshold,
      stage,
      0,
      {
        large_change_lines: config.large_change_lines || 50,
        trust_stage_multipliers: config.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
      }
    );

    if (currentGfi >= dynamicThreshold) {
      const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
      logger?.warn?.(`[PD:GFI_GATE] High-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 高风险操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 高风险工具需要更低的 GFI 阈值才能执行。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待 GFI 自然衰减后重试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
      };
    }
  }

  // TIER 1: Low-risk write tools
  if (LOW_RISK_WRITE_TOOLS.has(event.toolName)) {
    const trustEngine = wctx.trust;
    const stage = trustEngine.getStage();
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
    const baseThreshold = config.thresholds?.low_risk_block || 70;
    const dynamicThreshold = calculateDynamicThreshold(
      baseThreshold,
      stage,
      lineChanges,
      {
        large_change_lines: config.large_change_lines || 50,
        trust_stage_multipliers: config.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
      }
    );

    if (currentGfi >= dynamicThreshold) {
      const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
      logger?.warn?.(`[PD:GFI_GATE] Low-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage}${lineChanges > 50 ? `, ${lineChanges}行修改` : ''})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
      };
    }
  }

  // AGENT_TOOLS: Block subagent spawn when GFI is critically high
  if (AGENT_TOOLS.has(event.toolName)) {
    if (currentGfi >= AGENT_SPAWN_GFI_THRESHOLD) {
      logger?.warn?.(`[PD:GFI_GATE] Agent tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${AGENT_SPAWN_GFI_THRESHOLD}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 疲劳指数过高，禁止派生子智能体。

GFI: ${currentGfi}/100
阈值: ${AGENT_SPAWN_GFI_THRESHOLD} (Stage ${wctx.trust.getStage()})

原因: 高疲劳状态下派生子智能体会放大错误风险。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 简化任务后重试`,
      };
    }
  }

  return undefined;
}
