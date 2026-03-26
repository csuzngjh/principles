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

import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';

// TODO: Extract types from gate.ts related to GFI gate configuration
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

// TODO: Extract GFI calculation and threshold logic from gate.ts
export function calculateDynamicThreshold(
  baseThreshold: number,
  trustStage: number,
  lineChanges: number,
  config: {
    large_change_lines: number;
    trust_stage_multipliers: Record<string, number>;
  }
): number {
  // TODO: Implement dynamic threshold calculation
  // This is currently in gate.ts lines 112-132
  throw new Error('Not implemented yet');
}

// TODO: Extract GFI gate check logic from gate.ts
export function checkGfiGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  config: GfiGateConfig,
  currentGfi: number
): PluginHookBeforeToolCallResult | void {
  // TODO: Implement GFI gate check
  // This is currently in gate.ts lines 207-379
  throw new Error('Not implemented yet');
}
