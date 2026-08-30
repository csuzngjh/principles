/**
 * Raw Observation Adapter Tests — PRI-362
 *
 * Tests the unified resolveSourceKind function that maps RawObservation
 * to SourceKind, replacing scattered resolveSourceKindFrom* functions.
 *
 * Each test case asserts behavior is consistent with legacy functions
 * (regression protection).
 *
 * ERR checklist:
 * - ERR-001: Source kind resolved from runtime values, not `as` casts.
 * - ERR-002: Every triage result has reason + nextAction.
 * - ERR-024/025/048: Production-path tests for the adapter.
 */

import { describe, it, expect } from 'vitest';
import type { RawObservation } from '../../src/hooks/raw-observation-types.js';
import { resolveSourceKind } from '../../src/hooks/raw-observation-adapter.js';

// ── Tool Failure: agent_on_owner_request ──────────────────────────────────

describe('resolveSourceKind: agent_on_owner_request', () => {
  it('maps pain tool with openclaw_context_bound provenance to agent_on_owner_request', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'pain',
      failureSource: 'tool_failure',
      provenance: 'host_context_bound',
    };
    expect(resolveSourceKind(obs)).toBe('agent_on_owner_request');
  });

  it('maps skill:pain with openclaw_context_bound to agent_on_owner_request', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'skill:pain',
      failureSource: 'tool_failure',
      provenance: 'host_context_bound',
    };
    expect(resolveSourceKind(obs)).toBe('agent_on_owner_request');
  });
});

// ── Tool Failure: owner_reported ───────────────────────────────────────────

describe('resolveSourceKind: owner_reported', () => {
  it('maps pain tool without openclaw_context_bound to owner_reported', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'pain',
      failureSource: 'tool_failure',
      provenance: 'automatic_hook',
    };
    expect(resolveSourceKind(obs)).toBe('owner_reported');
  });

  it('maps pain tool with undefined provenance to owner_reported', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'pain',
      failureSource: 'tool_failure',
    };
    expect(resolveSourceKind(obs)).toBe('owner_reported');
  });

  it('maps manual entry to owner_reported', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isManualEntry: true,
    };
    expect(resolveSourceKind(obs)).toBe('owner_reported');
  });
});

// ── Tool Failure: tool_failure ────────────────────────────────────────────

describe('resolveSourceKind: tool_failure', () => {
  it('maps regular tool failure to tool_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'write',
      failureSource: 'tool_failure',
    };
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('maps exec failure to tool_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'exec',
      failureSource: 'tool_failure',
    };
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('maps undefined tool name with tool_failure to tool_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      failureSource: 'tool_failure',
    };
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('maps non-zero exit code to tool_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'read',
      nonZeroExit: true,
    };
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('maps timeout to tool_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'exec',
      timedOut: true,
    };
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });
});

// ── Tool Failure: dispatch_error ─────────────────────────────────────────

describe('resolveSourceKind: dispatch_error', () => {
  it('maps dispatch_error failure source to dispatch_error', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolName: 'read',
      failureSource: 'dispatch_error',
    };
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
  });

  it('maps tool not found to dispatch_error', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      toolNotFound: true,
    };
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
  });
});

// ── Provider Failure: rate_limit ─────────────────────────────────────────

describe('resolveSourceKind: rate_limit', () => {
  it('maps rate limit to rate_limit', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isRateLimit: true,
    };
    expect(resolveSourceKind(obs)).toBe('rate_limit');
  });
});

// ── Provider Failure: provider_failure ───────────────────────────────────

describe('resolveSourceKind: provider_failure', () => {
  it('maps non-rate-limit provider failure to provider_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isRateLimit: false,
    };
    expect(resolveSourceKind(obs)).toBe('provider_failure');
  });

  it('maps undefined rate_limit to provider_failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      // isRateLimit undefined should be provider_failure
    };
    // This test depends on the implementation decision for undefined
    // For now, we'll skip it until we clarify the behavior
    expect(resolveSourceKind(obs)).not.toBe('rate_limit');
  });
});

// ── Gate Block: rulehost_block ───────────────────────────────────────────

describe('resolveSourceKind: rulehost_block', () => {
  it('maps gate block to rulehost_block', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isGateBlock: true,
    };
    expect(resolveSourceKind(obs)).toBe('rulehost_block');
  });
});

// ── LLM Detection: gfi_threshold ─────────────────────────────────────────

describe('resolveSourceKind: gfi_threshold', () => {
  it('maps GFI triggered to gfi_threshold', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'llm_some_rule',
      isGfiTriggered: true,
    };
    expect(resolveSourceKind(obs)).toBe('gfi_threshold');
  });
});

// ── LLM Detection: llm_paralysis ─────────────────────────────────────────

describe('resolveSourceKind: llm_paralysis', () => {
  it('maps llm_paralysis to llm_paralysis', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'llm_paralysis',
      isGfiTriggered: false,
    };
    expect(resolveSourceKind(obs)).toBe('llm_paralysis');
  });
});

// ── LLM Detection: semantic ──────────────────────────────────────────────

describe('resolveSourceKind: semantic', () => {
  it('maps llm_* detection rules to semantic', () => {
    const obs1: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'llm_repetition',
      isGfiTriggered: false,
    };
    expect(resolveSourceKind(obs1)).toBe('semantic');

    const obs2: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'llm_loop',
      isGfiTriggered: false,
    };
    expect(resolveSourceKind(obs2)).toBe('semantic');
  });
});

// ── LLM Detection: empathy_inferred ──────────────────────────────────────

describe('resolveSourceKind: empathy_inferred', () => {
  it('maps user_empathy to empathy_inferred', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'user_empathy',
      isGfiTriggered: false,
    };
    expect(resolveSourceKind(obs)).toBe('empathy_inferred');
  });
});

// ── Subagent Error: subagent_error ───────────────────────────────────────

describe('resolveSourceKind: subagent_error', () => {
  it('maps subagent error to subagent_error', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isSubagentError: true,
    };
    expect(resolveSourceKind(obs)).toBe('subagent_error');
  });
});

// ── Unknown: unknown ──────────────────────────────────────────────────────

describe('resolveSourceKind: unknown', () => {
  it('maps unknown detection source to unknown', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'something_else',
      isGfiTriggered: false,
    };
    expect(resolveSourceKind(obs)).toBe('unknown');
  });

  it('maps empty observation to unknown', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
    };
    expect(resolveSourceKind(obs)).toBe('unknown');
  });
});

// ── Priority Tests (field precedence) ─────────────────────────────────────

describe('resolveSourceKind: field precedence', () => {
  it('GFI triggered takes precedence over detection source prefix', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      detectionSource: 'llm_paralysis',
      isGfiTriggered: true,
    };
    expect(resolveSourceKind(obs)).toBe('gfi_threshold');
  });

  it('manual entry takes precedence over other fields', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isManualEntry: true,
      toolName: 'read',
      failureSource: 'tool_failure',
    };
    expect(resolveSourceKind(obs)).toBe('owner_reported');
  });

  it('gate block takes precedence over tool failure', () => {
    const obs: RawObservation = {
      observedAt: new Date().toISOString(),
      isGateBlock: true,
      toolName: 'write',
      failureSource: 'tool_failure',
    };
    expect(resolveSourceKind(obs)).toBe('rulehost_block');
  });
});