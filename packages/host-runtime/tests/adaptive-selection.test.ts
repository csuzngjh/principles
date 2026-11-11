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
import { PiAiRuntimeAdapter, type StartRunInput } from '@principles/core/runtime';
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
});
