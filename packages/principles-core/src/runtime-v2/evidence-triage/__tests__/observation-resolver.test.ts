/**
 * Observation Resolver Tests — PRI-446
 *
 * Mirrors the plugin-side raw-observation-adapter.test.ts to keep coverage on
 * the migrated core module. The plugin file now re-exports these symbols.
 *
 * ERR checklist:
 * - ERR-001: Source kind resolved from runtime values, not `as` casts.
 * - ERR-025: Tests the real resolveSourceKind path.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSourceKind,
  buildToolFailureObservation,
  buildLlmDetectionObservation,
  buildEmpathyObservation,
  buildManualPainObservation,
  type RawObservation,
} from '../observation-resolver.js';

function obs(overrides: Partial<RawObservation> = {}): RawObservation {
  return { observedAt: '2026-06-23T00:00:00.000Z', ...overrides };
}

describe('resolveSourceKind: per-kind mapping', () => {
  it('isManualEntry → owner_reported', () => {
    expect(resolveSourceKind(obs({ isManualEntry: true }))).toBe('owner_reported');
  });

  it('isGateBlock → rulehost_block', () => {
    expect(resolveSourceKind(obs({ isGateBlock: true }))).toBe('rulehost_block');
  });

  it('isSubagentError → subagent_error', () => {
    expect(resolveSourceKind(obs({ isSubagentError: true }))).toBe('subagent_error');
  });

  it('isRateLimit true → rate_limit', () => {
    expect(resolveSourceKind(obs({ isRateLimit: true }))).toBe('rate_limit');
  });

  it('isRateLimit false → provider_failure', () => {
    expect(resolveSourceKind(obs({ isRateLimit: false }))).toBe('provider_failure');
  });

  it("pain tool + openclaw_context_bound → agent_on_owner_request", () => {
    expect(resolveSourceKind(obs({ toolName: 'pain', provenance: 'host_context_bound' }))).toBe('agent_on_owner_request');
  });

  it("skill:pain + openclaw_context_bound → agent_on_owner_request", () => {
    expect(resolveSourceKind(obs({ toolName: 'skill:pain', provenance: 'host_context_bound' }))).toBe('agent_on_owner_request');
  });

  it('pain tool without openclaw_context_bound → owner_reported', () => {
    expect(resolveSourceKind(obs({ toolName: 'pain' }))).toBe('owner_reported');
  });

  it('failureSource tool_failure → tool_failure', () => {
    expect(resolveSourceKind(obs({ toolName: 'write', failureSource: 'tool_failure' }))).toBe('tool_failure');
  });

  it('failureSource dispatch_error → dispatch_error', () => {
    expect(resolveSourceKind(obs({ toolName: 'read', failureSource: 'dispatch_error' }))).toBe('dispatch_error');
  });

  it('toolNotFound → dispatch_error', () => {
    expect(resolveSourceKind(obs({ toolNotFound: true }))).toBe('dispatch_error');
  });

  it('nonZeroExit → tool_failure', () => {
    expect(resolveSourceKind(obs({ toolName: 'read', nonZeroExit: true }))).toBe('tool_failure');
  });

  it('timedOut → tool_failure', () => {
    expect(resolveSourceKind(obs({ toolName: 'exec', timedOut: true }))).toBe('tool_failure');
  });

  it('isGfiTriggered → gfi_threshold', () => {
    expect(resolveSourceKind(obs({ detectionSource: 'llm_x', isGfiTriggered: true }))).toBe('gfi_threshold');
  });

  it("detectionSource 'llm_paralysis' → llm_paralysis", () => {
    expect(resolveSourceKind(obs({ detectionSource: 'llm_paralysis' }))).toBe('llm_paralysis');
  });

  it("detectionSource 'llm_*' (not paralysis) → semantic", () => {
    expect(resolveSourceKind(obs({ detectionSource: 'llm_repetition' }))).toBe('semantic');
  });

  it("detectionSource 'user_empathy' → empathy_inferred", () => {
    expect(resolveSourceKind(obs({ detectionSource: 'user_empathy' }))).toBe('empathy_inferred');
  });

  it('empty observation → unknown', () => {
    expect(resolveSourceKind(obs())).toBe('unknown');
  });

  it('unknown detectionSource → unknown', () => {
    expect(resolveSourceKind(obs({ detectionSource: 'something_else' }))).toBe('unknown');
  });
});

describe('resolveSourceKind: field precedence', () => {
  it('manual entry takes precedence over tool failure', () => {
    expect(resolveSourceKind(obs({ isManualEntry: true, toolName: 'read', failureSource: 'tool_failure' }))).toBe('owner_reported');
  });

  it('gate block takes precedence over tool failure', () => {
    expect(resolveSourceKind(obs({ isGateBlock: true, toolName: 'write', failureSource: 'tool_failure' }))).toBe('rulehost_block');
  });

  it('GFI triggered takes precedence over detection source prefix', () => {
    expect(resolveSourceKind(obs({ detectionSource: 'llm_paralysis', isGfiTriggered: true }))).toBe('gfi_threshold');
  });

  it('subagent error takes precedence over tool failure', () => {
    expect(resolveSourceKind(obs({ isSubagentError: true, failureSource: 'tool_failure' }))).toBe('subagent_error');
  });
});

describe('buildToolFailureObservation', () => {
  it('empty/whitespace tool name + error → dispatch_error', () => {
    const o = buildToolFailureObservation({ toolName: '', error: 'boom' });
    expect(o.failureSource).toBe('dispatch_error');
    expect(o.toolName).toBe('');
  });

  it("'tool not found' message → dispatch_error", () => {
    const o = buildToolFailureObservation({ toolName: 'read', error: 'tool not found' });
    expect(o.failureSource).toBe('dispatch_error');
  });

  it("'unknown tool' message → dispatch_error", () => {
    const o = buildToolFailureObservation({ toolName: 'read', error: 'unknown tool foo' });
    expect(o.failureSource).toBe('dispatch_error');
  });

  it('generic tool error → tool_failure', () => {
    const o = buildToolFailureObservation({ toolName: 'write', error: 'permission denied' });
    expect(o.failureSource).toBe('tool_failure');
    expect(o.nonZeroExit).toBe(false);
  });

  it('non-zero exit code marks nonZeroExit true', () => {
    const o = buildToolFailureObservation({ toolName: 'write', error: 'err', exitCode: 1 });
    expect(o.nonZeroExit).toBe(true);
  });

  it('zero exit code marks nonZeroExit false', () => {
    const o = buildToolFailureObservation({ toolName: 'write', error: 'err', exitCode: 0 });
    expect(o.nonZeroExit).toBe(false);
  });

  it('no error and zero/undefined exit → failureSource undefined (not a failure context)', () => {
    const o = buildToolFailureObservation({ toolName: 'write', error: null, exitCode: 0 });
    expect(o.failureSource).toBeUndefined();
  });

  it('preserves provenance', () => {
    const o = buildToolFailureObservation({ toolName: 'write', error: 'x', provenance: 'automatic_hook' });
    expect(o.provenance).toBe('automatic_hook');
  });
});

describe('buildLlmDetectionObservation', () => {
  it('builds observation with detectionSource and isGfiTriggered', () => {
    const o = buildLlmDetectionObservation({ detectionSource: 'llm_loop', isGfiTriggered: true });
    expect(o.detectionSource).toBe('llm_loop');
    expect(o.isGfiTriggered).toBe(true);
    expect(o.observedAt).toBeTruthy();
  });

  it('feeds into resolveSourceKind correctly', () => {
    const o = buildLlmDetectionObservation({ detectionSource: 'llm_loop', isGfiTriggered: false });
    expect(resolveSourceKind(o)).toBe('semantic');
  });
});

// ── PRI-454: New builders for empathy and manual pain paths ─────────────────

describe('buildEmpathyObservation (PRI-454)', () => {
  it('builds observation with detectionSource and isGfiTriggered', () => {
    const o = buildEmpathyObservation({ detectionSource: 'user_empathy', isGfiTriggered: true });
    expect(o.detectionSource).toBe('user_empathy');
    expect(o.isGfiTriggered).toBe(true);
    expect(o.observedAt).toBeTruthy();
  });

  it('includes sessionId when provided', () => {
    const o = buildEmpathyObservation({ detectionSource: 'user_empathy', isGfiTriggered: true, sessionId: 'sess-123' });
    expect(o.sessionId).toBe('sess-123');
  });

  it('sessionId is undefined when not provided', () => {
    const o = buildEmpathyObservation({ detectionSource: 'user_empathy', isGfiTriggered: false });
    expect(o.sessionId).toBeUndefined();
  });

  it('isGfiTriggered=true → resolveSourceKind returns gfi_threshold', () => {
    const o = buildEmpathyObservation({ detectionSource: 'user_empathy', isGfiTriggered: true });
    expect(resolveSourceKind(o)).toBe('gfi_threshold');
  });

  it('isGfiTriggered=false → resolveSourceKind returns empathy_inferred', () => {
    const o = buildEmpathyObservation({ detectionSource: 'user_empathy', isGfiTriggered: false });
    expect(resolveSourceKind(o)).toBe('empathy_inferred');
  });
});

describe('buildManualPainObservation (PRI-454)', () => {
  it('builds observation with isManualEntry=true', () => {
    const o = buildManualPainObservation({});
    expect(o.isManualEntry).toBe(true);
    expect(o.observedAt).toBeTruthy();
  });

  it('includes sessionId when provided', () => {
    const o = buildManualPainObservation({ sessionId: 'sess-456' });
    expect(o.sessionId).toBe('sess-456');
  });

  it('sessionId is undefined when not provided', () => {
    const o = buildManualPainObservation({});
    expect(o.sessionId).toBeUndefined();
  });

  it('resolveSourceKind returns owner_reported', () => {
    const o = buildManualPainObservation({});
    expect(resolveSourceKind(o)).toBe('owner_reported');
  });
});
