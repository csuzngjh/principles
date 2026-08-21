export interface RuleCodeSafetySample {
  toolName: string;
  decision: 'allow' | 'block' | 'requireApproval' | 'auto_correct' | 'error';
  outsideApprovedScope: boolean;
  protectedCapabilityMatched?: boolean;
  neutralProbeFailed?: boolean;
  healthFailure?: 'load' | 'compatibility' | 'context' | 'invalid_result' | 'timeout' | 'exception';
}

export interface RuleCodeSafetyCircuitState {
  consecutiveErrors: number;
  consecutiveBlocks: { toolName: string }[];
  latestEligible: { blocked: boolean; outsideApprovedScope: boolean }[];
}

export type RuleCodeSafetyTripReason = 'protected_capability_matched' | 'host_liveness_probe_failed' | 'runtime_health_failure' | 'three_consecutive_errors' | 'broad_consecutive_blocking' | 'outside_scope_block_ratio';

export function initialRuleCodeSafetyCircuitState(): RuleCodeSafetyCircuitState {
  return { consecutiveErrors: 0, consecutiveBlocks: [], latestEligible: [] };
}

export function evaluateRuleCodeSafetyCircuit(state: RuleCodeSafetyCircuitState, sample: RuleCodeSafetySample): { state: RuleCodeSafetyCircuitState; trip: RuleCodeSafetyTripReason | null } {
  if (sample.protectedCapabilityMatched) return { state, trip: 'protected_capability_matched' };
  if (sample.neutralProbeFailed) return { state, trip: 'host_liveness_probe_failed' };
  if (sample.healthFailure) return { state, trip: 'runtime_health_failure' };
  const consecutiveErrors = sample.decision === 'error' ? state.consecutiveErrors + 1 : 0;
  const consecutiveBlocks = sample.decision === 'block' ? [...state.consecutiveBlocks, { toolName: sample.toolName }].slice(-5) : [];
  const latestEligible = [...state.latestEligible, { blocked: sample.decision === 'block', outsideApprovedScope: sample.outsideApprovedScope }].slice(-20);
  const next = { consecutiveErrors, consecutiveBlocks, latestEligible };
  if (consecutiveErrors >= 3) return { state: next, trip: 'three_consecutive_errors' };
  if (consecutiveBlocks.length >= 5 && new Set(consecutiveBlocks.map(value => value.toolName)).size >= 3) return { state: next, trip: 'broad_consecutive_blocking' };
  if (latestEligible.length === 20 && latestEligible.filter(value => value.blocked && value.outsideApprovedScope).length / 20 > 0.8) return { state: next, trip: 'outside_scope_block_ratio' };
  return { state: next, trip: null };
}
