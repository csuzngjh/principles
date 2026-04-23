/**
 * StartRunInput construction validation tests.
 *
 * Verifies that the StartRunInput built by DiagnosticianRunner.invokeRuntime()
 * conforms to StartRunInputSchema and contains the expected fields.
 *
 * Approach: Mirror the construction logic from invokeRuntime() in a helper function,
 * then validate the output against the TypeBox schema. This avoids wiring up the
 * full DiagnosticianRunner with mock stores.
 */
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { StartRunInputSchema } from '../../runtime-protocol.js';
import type { StartRunInput, ContextItem } from '../../runtime-protocol.js';
import type { DiagnosticianInvocationInput } from '../../diagnostician-output.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';

/** Mirrors DiagnosticianRunner.invokeRuntime() construction logic exactly. */
function buildStartRunInput(
  context: DiagnosticianContextPayload,
  taskId: string,
  timeoutMs: number,
): StartRunInput {
  const invocationInput: DiagnosticianInvocationInput = {
    agentId: 'diagnostician',
    taskId,
    context,
    outputSchemaRef: 'diagnostician-output-v1',
    timeoutMs,
  };

  return {
    agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
    taskRef: { taskId },
    inputPayload: invocationInput,
    contextItems: [{ role: 'system', content: JSON.stringify(invocationInput) }],
    outputSchemaRef: 'diagnostician-output-v1',
    timeoutMs,
  };
}

/** Minimal DiagnosticianContextPayload for testing. */
function makeTestContext(): DiagnosticianContextPayload {
  return {
    contextId: 'ctx-test-001',
    contextHash: 'abc123',
    taskId: 'test-task-001',
    workspaceDir: '/tmp/test',
    sourceRefs: [],
    diagnosisTarget: { reasonSummary: 'Test diagnosis target', severity: 'medium' },
    conversationWindow: [],
  };
}

describe('StartRunInput construction from invokeRuntime()', () => {
  const context = makeTestContext();
  const taskId = 'test-task-001';
  const timeoutMs = 30000;
  const input = buildStartRunInput(context, taskId, timeoutMs);

  it('passes Value.Check against StartRunInputSchema', () => {
    expect(Value.Check(StartRunInputSchema, input)).toBe(true);
  });

  it('agentSpec field is { agentId: "diagnostician", schemaVersion: "v1" }', () => {
    expect(input.agentSpec).toEqual({ agentId: 'diagnostician', schemaVersion: 'v1' });
  });

  it('taskRef field is { taskId: "<taskId>" }', () => {
    expect(input.taskRef).toEqual({ taskId: 'test-task-001' });
  });

  it('outputSchemaRef is "diagnostician-output-v1"', () => {
    expect(input.outputSchemaRef).toBe('diagnostician-output-v1');
  });

  it('inputPayload is a DiagnosticianInvocationInput with agentId="diagnostician"', () => {
    const payload = input.inputPayload as DiagnosticianInvocationInput;
    expect(payload.agentId).toBe('diagnostician');
    expect(payload.taskId).toBe(taskId);
    expect(payload.outputSchemaRef).toBe('diagnostician-output-v1');
    expect(payload.timeoutMs).toBe(timeoutMs);
  });

  it('contextItems is an array with at least one system-role entry containing JSON-stringified invocation input', () => {
    expect(input.contextItems.length).toBeGreaterThanOrEqual(1);
    const systemItem = input.contextItems.find((item: ContextItem) => item.role === 'system');
    expect(systemItem).toBeDefined();
    if (!systemItem) return;
    const parsed = JSON.parse(systemItem.content);
    expect(parsed.agentId).toBe('diagnostician');
    expect(parsed.taskId).toBe(taskId);
  });
});
