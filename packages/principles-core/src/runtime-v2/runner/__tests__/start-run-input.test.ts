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
import { DiagnosticianPromptBuilder } from '../../diagnostician-prompt-builder.js';
import { StartRunInputSchema } from '../../runtime-protocol.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';

/** Mirrors DiagnosticianRunner.invokeRuntime() construction logic exactly. */
function buildStartRunInput(
  context: DiagnosticianContextPayload,
  taskId: string,
  timeoutMs: number,
): StartRunInput {
  const builder = new DiagnosticianPromptBuilder();
  const { message } = builder.buildPrompt(context);

  return {
    agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
    taskRef: { taskId },
    inputPayload: message,
    contextItems: [],
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

  it('inputPayload is a JSON string containing taskId and diagnosticInstruction', () => {
    const payload = JSON.parse(input.inputPayload as string);
    expect(payload.taskId).toBe(taskId);
    expect(payload.diagnosticInstruction).toBeDefined();
    expect(payload.diagnosticInstruction.length).toBeGreaterThan(100);
  });

  it('contextItems is empty (instruction is embedded in inputPayload)', () => {
    expect(input.contextItems).toHaveLength(0);
  });
});
