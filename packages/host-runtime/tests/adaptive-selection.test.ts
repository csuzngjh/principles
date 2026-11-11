/**
 * Phase-1 stability (S5): the adaptive principle selector is the last caller
 * that reached the runtime adapter without an `outputSchemaRef`, so its model
 * answer bypassed the schema-gated validation every other runner gets.
 *
 * Red-before-green: before S5 the captured `startRun` input carried no
 * `outputSchemaRef`, and a `{status:'selected'}` answer (missing id/digest)
 * came back as a plain payload instead of failing schema validation.
 *
 * Conflict note (PRI-1170 / PR #2513): this file only covers the schema-ref
 * handoff. The admission/completion deadline semantics exercised by
 * `createSingleModelSelector` are owned by PR #2513 and are deliberately not
 * re-asserted here, so the two changes cannot drift into two timing systems.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDRuntimeError, PiAiRuntimeAdapter, type StartRunInput } from '@principles/core/runtime';
import {
  createSingleModelSelector,
  type BoundedSelectionInput,
} from '../src/adaptive-selection.js';

const boundedInput: BoundedSelectionInput = {
  payload: {
    currentInstruction: 'select at most one principle for this turn',
    priorMessages: [],
    candidates: [],
  },
  entries: [],
  priorDropped: 0,
};

function spyAdapter(): StartRunInput[] {
  const captured: StartRunInput[] = [];
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockImplementation(
    async function (this: unknown, input: StartRunInput) {
      captured.push(input);
      return {runId: 'run-s5', runtimeKind: 'pi-ai', startedAt: new Date().toISOString()};
    },
  );
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockResolvedValue({
    runId: 'run-s5',
    payload: {status: 'none_applicable'},
  });
  return captured;
}

function selector() {
  return createSingleModelSelector({
    admissionDeadlineAt: Date.now() + 10_000,
    model: {provider: 'sensenova', model: 'deepseek-v4-flash', apiKeyEnv: 'UNUSED_IN_SPYED_TEST'},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSingleModelSelector — S5 output schema handoff', () => {
  it('passes the registered adaptive selection schema to startRun', async () => {
    const captured = spyAdapter();

    await selector().select(boundedInput);

    // RED (before S5): outputSchemaRef was undefined, so Path 3 ran without
    // schema validation or repair.
    expect(captured).toHaveLength(1);
    expect(captured[0].outputSchemaRef).toBe('adaptive-selection-output');
  });

  it('labels an adapter schema rejection as SELECTION_OUTPUT_INVALID, not TRANSPORT_FAILED', async () => {
    // With the schema registered, an incomplete answer (e.g. `selected`
    // without digest) is rejected by the adapter before the host guard runs.
    // The failure code must stay diagnosable instead of degrading to the
    // generic transport code.
    vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockRejectedValue(
      new PDRuntimeError('output_invalid', 'LLM output does not match adaptive-selection-output schema'),
    );

    const s = selector();
    await expect(s.select(boundedInput)).rejects.toThrow('SELECTION_OUTPUT_INVALID');
    expect(s.report().failure).toBe('SELECTION_OUTPUT_INVALID');
    expect(s.report().status).toBe('failed');
  });

  it('separates an unregistered selector schema from an invalid model answer', async () => {
    // A missing registry entry is a deployment/configuration fault, not a
    // malformed model answer. Reporting it as SELECTION_OUTPUT_INVALID points
    // operators at the wrong subsystem.
    vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockRejectedValue(
      new PDRuntimeError('output_invalid', 'Unknown outputSchemaRef: adaptive-selection-output', {
        parseFailureReason: 'unknown_output_schema_ref',
        outputSchemaRef: 'adaptive-selection-output',
        nextAction: 'Register the schema in OUTPUT_SCHEMA_REGISTRY',
      }),
    );

    const s = selector();
    // RED (before the split): reported SELECTION_OUTPUT_INVALID.
    await expect(s.select(boundedInput)).rejects.toThrow('SELECTION_SCHEMA_UNAVAILABLE');
    expect(s.report().failure).toBe('SELECTION_SCHEMA_UNAVAILABLE');
    expect(s.report().status).toBe('failed');
  });
});
