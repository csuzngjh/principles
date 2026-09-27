import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ToolCallEventDataSchema,
  RuntimeV2PromptActivationsInjectedEventDataSchema,
} from '../types/event-types.js';

describe('PRI-750 receipt chain event fields (runId / toolCallId)', () => {
  it('tool_call data accepts runId + toolCallId when present', () => {
    const input = { toolName: 'edit', runId: 'run-abc', toolCallId: 'call-123' };
    expect(Value.Check(ToolCallEventDataSchema, input)).toBe(true);
  });

  it('tool_call data stays compatible when runId/toolCallId are absent', () => {
    expect(Value.Check(ToolCallEventDataSchema, { toolName: 'edit', error: 'boom', exitCode: 1 })).toBe(true);
  });

  it('runtime_v2_prompt_activations_injected accepts runId when present and stays compatible when absent', () => {
    const base = {
      sessionId: 'sess-1',
      workspaceDir: '/ws',
      principleIds: [],
      activationIds: [],
      artifactIds: [],
      injectedCount: 0,
      skippedWarnings: [],
      injectedCharCount: 0,
      budget: 2000,
    };
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, { ...base, runId: 'turn-1' })).toBe(true);
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, base)).toBe(true);
  });

  it('PRI-904: accepts the fair-rotation observability fields and stays compatible without them', () => {
    const base = {
      sessionId: 'sess-1',
      workspaceDir: '/ws',
      principleIds: ['p1'],
      activationIds: ['act_1'],
      artifactIds: ['art_1'],
      injectedCount: 1,
      skippedWarnings: [],
      injectedCharCount: 208,
      budget: 2000,
    };
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, base)).toBe(true);
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, {
      ...base,
      runId: 'run-42',
      selectionPolicy: 'fair_rotation_v1',
      eligibleCount: 16,
      rotationStartIndex: 7,
      droppedActivationIds: ['act_10', 'act_11'],
      oversizedActivationIds: [],
    })).toBe(true);
    // Unknown policy literals are rejected (wire shape stays closed).
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, {
      ...base,
      selectionPolicy: 'random_shuffle_v9',
    })).toBe(false);
  });
});
