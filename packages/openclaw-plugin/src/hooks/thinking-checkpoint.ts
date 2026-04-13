/**
 * Thinking Checkpoint Module
 *
 * Enforces P-10 deep reflection requirement for high-risk tool operations.
 *
 * **Responsibilities:**
 * - Check if high-risk tools have recent deep thinking (T-01 through T-10)
 * - Block high-risk operations without preceding deep reflection
 * - Configurable time window for thinking validity (default 5 minutes)
 * - Provide clear guidance on required action (deep_reflect tool usage)
 *
 * **Configuration:**
 * - Thinking checkpoint settings from profile.thinking_checkpoint
 * - Window duration for thinking validity
 * - High-risk tool list
 */

import { hasRecentThinking } from '../core/session-tracker.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import { 
  THINKING_CHECKPOINT_WINDOW_MS,
  THINKING_CHECKPOINT_DEFAULT_HIGH_RISK_TOOLS 
} from '../config/index.js';

export interface ThinkingCheckpointConfig {
  enabled?: boolean;
  window_ms?: number;
  high_risk_tools?: string[];
}

/**
 * Checks if a tool call requires a recent deep thinking checkpoint.
 *
 * This enforces P-10 (Thinking OS Checkpoint) - high-risk operations must
 * be preceded by deep reflection within the configured time window.
 *
 * @param event - The before_tool_call event
 * @param config - Thinking checkpoint configuration from profile
 * @param sessionId - Current session ID
 * @param logger - Optional logger for info messages
 * @returns Block result if thinking required, undefined otherwise
 */
 
// eslint-disable-next-line @typescript-eslint/max-params
export function checkThinkingCheckpoint(
  event: PluginHookBeforeToolCallEvent,
  config: ThinkingCheckpointConfig,
  sessionId: string | undefined,
   
  logger?: { info?: (message: string) => void }
): PluginHookBeforeToolCallResult | undefined {
  const enabled = config.enabled ?? false;
  const windowMs = config.window_ms ?? THINKING_CHECKPOINT_WINDOW_MS;
  const highRiskTools = config.high_risk_tools ?? [...THINKING_CHECKPOINT_DEFAULT_HIGH_RISK_TOOLS];

  if (!enabled || !sessionId) {
    return undefined;
  }

  const isHighRisk = highRiskTools.includes(event.toolName);
  if (!isHighRisk) {
    return undefined;
  }

  const hasThinking = hasRecentThinking(sessionId, windowMs);
  if (!hasThinking) {
    logger?.info?.(`[PD:THINKING_GATE] High-risk tool "${event.toolName}" called without recent deep thinking`);

    return {
      block: true,
      blockReason: `[Thinking OS Checkpoint] 高风险操作 "${event.toolName}" 需要先进行深度思考。\n\n请先使用 deep_reflect 工具分析当前情况，然后再尝试此操作。\n\n这是强制性检查点，目的是确保决策质量。\n\n提示：调用 deep_reflect 后，${Math.round(windowMs/60000)}分钟内的操作将自动放行。\n\n可在PROFILE.json中设置 thinking_checkpoint.enabled: false 来禁用此检查。`,
    };
  }

  return undefined;
}
