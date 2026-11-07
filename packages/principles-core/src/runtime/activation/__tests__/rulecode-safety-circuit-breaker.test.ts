import { describe, expect, it } from 'vitest';
import { evaluateRuleCodeSafetyCircuit, initialRuleCodeSafetyCircuitState } from '../rulecode-safety-circuit-breaker.js';

describe('RuleCode safety circuit breaker', () => {
  it('trips immediately for protected controls and runtime health failures', () => {
    expect(evaluateRuleCodeSafetyCircuit(initialRuleCodeSafetyCircuitState(), { toolName: 'pd', decision: 'allow', outsideApprovedScope: false, protectedCapabilityMatched: true }).trip).toBe('protected_capability_matched');
    expect(evaluateRuleCodeSafetyCircuit(initialRuleCodeSafetyCircuitState(), { toolName: 'write', decision: 'error', outsideApprovedScope: false, healthFailure: 'timeout' }).trip).toBe('runtime_health_failure');
  });

  it('trips after three consecutive errors and resets the sequence on success', () => {
    let state = initialRuleCodeSafetyCircuitState();
    for (let index = 0; index < 2; index += 1) { ({ state } = evaluateRuleCodeSafetyCircuit(state, { toolName: 'write', decision: 'error', outsideApprovedScope: false })); }
    expect(evaluateRuleCodeSafetyCircuit(state, { toolName: 'write', decision: 'error', outsideApprovedScope: false }).trip).toBe('three_consecutive_errors');
    expect(evaluateRuleCodeSafetyCircuit(state, { toolName: 'write', decision: 'allow', outsideApprovedScope: false }).state.consecutiveErrors).toBe(0);
  });

  it('trips for five consecutive blocks spanning three tools', () => {
    let state = initialRuleCodeSafetyCircuitState();
    for (const toolName of ['write', 'bash', 'write', 'agent']) { ({ state } = evaluateRuleCodeSafetyCircuit(state, { toolName, decision: 'block', outsideApprovedScope: false })); }
    expect(evaluateRuleCodeSafetyCircuit(state, { toolName: 'bash', decision: 'block', outsideApprovedScope: false }).trip).toBe('broad_consecutive_blocking');
  });

  it('trips when more than eighty percent of the latest twenty calls are blocked outside scope', () => {
    let state = initialRuleCodeSafetyCircuitState();
    for (let index = 0; index < 19; index += 1) { ({ state } = evaluateRuleCodeSafetyCircuit(state, { toolName: `tool-${index}`, decision: index < 17 ? 'block' : 'allow', outsideApprovedScope: index < 17 })); }
    expect(evaluateRuleCodeSafetyCircuit(state, { toolName: 'last', decision: 'allow', outsideApprovedScope: false }).trip).toBe('outside_scope_block_ratio');
  });
});
