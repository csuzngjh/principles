/**
 * P1-3 — DiagRouter retry repair feedback.
 *
 * Evidence from the 2026-11-12 experiment (lab workspace, read-only):
 *   - pain 1 router attempt 1 → output_invalid (recommendations[].abstractedPrinciple
 *     is required when kind is "principle"), attempt 2 succeeded;
 *   - pain 2 router attempts 1-3 failed with the SAME schema rejection, then
 *     max_attempts_exceeded.
 * Each retry re-sent the identical prompt with no new information. The router
 * now carries `lastValidatorErrors` (written by the base runner on every
 * output_invalid) into the next attempt's message payload, freshness-gated by
 * `sourceAttemptCount` so a stale record can never leak into a later attempt.
 */
import type { vi } from 'vitest';
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import { RouterPromptBuilder } from '../../diagnostician/router-prompt-builder.js';
import { createDiagRunnerHarness, ROUTER_TASK_ID } from './__fixtures__/diag-runner-harness.js';

type MockFn = ReturnType<typeof vi.fn>;

const SCHEMA_ERROR = 'recommendations[].abstractedPrinciple is required when kind is "principle"';

function taskWithValidatorErrors(attemptCount: number, sourceAttemptCount: number): TaskRecord {
  const base = createDiagRunnerHarness('router').makeTask();
  // Preserve the existing diagnostic_json envelope (pi_metadata carries the
  // dependency task ids); only add the top-level repair record.
  const envelope: Record<string, unknown> = base.diagnosticJson
    ? JSON.parse(base.diagnosticJson) as Record<string, unknown>
    : {};
  envelope.lastValidatorErrors = {
    recordedAt: '2026-11-12T07:45:45.000Z',
    errorCategory: 'output_invalid',
    errors: [SCHEMA_ERROR],
    sourceAttemptCount,
  };
  return { ...base, attemptCount, diagnosticJson: JSON.stringify(envelope) };
}

function installTask(h: ReturnType<typeof createDiagRunnerHarness>, task: TaskRecord): void {
  const stateManager = h.deps._stateManager;
  (stateManager.acquireLease as MockFn).mockResolvedValue(task);
  const getTaskMock = stateManager.getTask as MockFn;
  // Capture the harness's original implementation BEFORE overriding, otherwise
  // delegating through the mock recurses into itself.
  const originalGetTask = getTaskMock.getMockImplementation();
  getTaskMock.mockImplementation((id: string) =>
    id === ROUTER_TASK_ID ? Promise.resolve(task) : originalGetTask?.(id),
  );
}

function submittedMessage(h: ReturnType<typeof createDiagRunnerHarness>): Record<string, unknown> {
  const invocation: unknown = h.deps._runtimeAdapter.startRun?.mock.calls[0]?.[0];
  if (invocation === null || typeof invocation !== 'object') throw new Error('missing invocation');
  const payload: unknown = Reflect.get(invocation, 'inputPayload');
  if (typeof payload !== 'string') throw new Error('missing input payload');
  const parsed: unknown = JSON.parse(payload);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid payload');
  }
  return parsed as Record<string, unknown>;
}

describe('P1-3 DiagRouter repair feedback', () => {
  it('carries fresh validator errors into the next attempt message', async () => {
    const h = createDiagRunnerHarness('router');
    installTask(h, taskWithValidatorErrors(2, 1));

    const result = await h.runner.run(ROUTER_TASK_ID);
    if (result.status !== 'succeeded') console.log('ROUTER RESULT', result);
    expect(result.status).toBe('succeeded');

    const message = submittedMessage(h);
    expect(message.validationFeedback).toEqual({
      attempt: 2,
      errors: [SCHEMA_ERROR],
    });
  });

  it('suppresses a stale validator record and never sends it', async () => {
    const h = createDiagRunnerHarness('router');
    // sourceAttemptCount 3 with current attempt 2 is not the previous attempt.
    installTask(h, taskWithValidatorErrors(2, 3));

    const result = await h.runner.run(ROUTER_TASK_ID);
    expect(result.status).toBe('succeeded');

    expect(submittedMessage(h)).not.toHaveProperty('validationFeedback');
    const events = (h.deps._eventEmitter.emitTelemetry as MockFn).mock.calls
      .map((call) => call[0] as Record<string, unknown>);
    const suppressed = events.find(
      (event) => typeof event.eventType === 'string'
        && event.eventType.endsWith('prior_validator_errors_suppressed'),
    );
    expect(suppressed).toBeDefined();
    expect((suppressed?.payload as Record<string, unknown>)?.reason).toBe('stale_source_attempt');
  });

  it('sends no feedback on a first attempt', async () => {
    const h = createDiagRunnerHarness('router');
    const task = { ...h.makeTask(), attemptCount: 1 };
    installTask(h, task);

    await h.runner.run(ROUTER_TASK_ID);

    expect(submittedMessage(h)).not.toHaveProperty('validationFeedback');
  });

  it('keeps feedback out of the static system prompt and declares the data boundary', () => {
    const builder = new RouterPromptBuilder();
    const prompt = builder.buildRouterInstruction();
    expect(prompt).toContain('validationFeedback');
    expect(prompt).not.toContain(SCHEMA_ERROR);
  });
});
