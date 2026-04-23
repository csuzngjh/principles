/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * ResilientContextAssembler test suite.
 *
 * Tests error wrapping, degraded payload generation, telemetry emission,
 * and schema compliance for all degradation scenarios.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianContextPayloadSchema } from '../context-payload.js';
import { ResilientContextAssembler } from './resilient-context-assembler.js';
import { StoreEventEmitter } from './event-emitter.js';
import type { ContextAssembler } from './context-assembler.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';
import { PDRuntimeError } from '../error-categories.js';

function createFailingInner(error: Error): ContextAssembler {
  return {
    assemble: vi.fn(async () => { throw error; }),
  };
}

function createSucceedingInner(payload: DiagnosticianContextPayload): ContextAssembler {
  return {
    assemble: vi.fn(async () => payload),
  };
}

function makeValidPayload(taskId: string): DiagnosticianContextPayload {
  return {
    contextId: '00000000-0000-4000-8000-000000000001',
    contextHash: createHash('sha256').update('test').digest('hex'),
    taskId,
    workspaceDir: '/tmp/test',
    sourceRefs: [taskId],
    diagnosisTarget: { reasonSummary: 'test' },
    conversationWindow: [],
    ambiguityNotes: undefined,
  };
}

describe('ResilientContextAssembler', () => {

  it('passes through successful payload unchanged', async () => {
    const payload = makeValidPayload('task-1');
    const inner = createSucceedingInner(payload);
    const emitter = new StoreEventEmitter();
    const resilient = new ResilientContextAssembler(inner, emitter);

    const result = await resilient.assemble('task-1');

    expect(result).toBe(payload);
  });

  it('returns degraded payload when inner throws task-not-found', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('storage_unavailable', 'Task not found: task-xxx'),
    );
    const emitter = new StoreEventEmitter();
    const resilient = new ResilientContextAssembler(inner, emitter);

    const result = await resilient.assemble('task-xxx');

    expect(result.taskId).toBe('task-xxx');
    expect(result.conversationWindow).toEqual([]);
    expect(result.workspaceDir).toBe('<unknown>');
    expect(result.sourceRefs).toEqual(['task-xxx']);
    expect(result.ambiguityNotes?.length).toBeGreaterThanOrEqual(2);
    expect(result.ambiguityNotes?.some((n) => n.includes('Task not found'))).toBe(true);
  });

  it('returns degraded payload when inner throws wrong-task-kind', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('input_invalid', 'Task task-y is not a diagnostician task'),
    );
    const emitter = new StoreEventEmitter();
    const resilient = new ResilientContextAssembler(inner, emitter);

    const result = await resilient.assemble('task-y');

    expect(result.taskId).toBe('task-y');
    expect(result.ambiguityNotes?.some((n) => n.includes('not a diagnostician'))).toBe(true);
  });

  it('returns degraded payload when inner throws schema validation failure', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('storage_unavailable', 'Context payload schema validation failed'),
    );
    const emitter = new StoreEventEmitter();
    const resilient = new ResilientContextAssembler(inner, emitter);

    const result = await resilient.assemble('task-schema');

    expect(result.taskId).toBe('task-schema');
    expect(result.ambiguityNotes?.some((n) => n.includes('schema validation failed'))).toBe(true);
  });

  it('degraded payload validates against DiagnosticianContextPayloadSchema', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('storage_unavailable', 'Task not found: task-val'),
    );
    const emitter = new StoreEventEmitter();
    const resilient = new ResilientContextAssembler(inner, emitter);

    const result = await resilient.assemble('task-val');

    expect(Value.Check(DiagnosticianContextPayloadSchema, result)).toBe(true);
  });

  it('degraded payload has deterministic contextHash', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('storage_unavailable', 'Error'),
    );
    const emitter = new StoreEventEmitter();
    const resilient = new ResilientContextAssembler(inner, emitter);

    const result = await resilient.assemble('task-hash');

    const expectedHash = createHash('sha256').update('degraded').digest('hex');
    expect(result.contextHash).toBe(expectedHash);
  });

  it('emits degradation_triggered telemetry on error', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('storage_unavailable', 'Task not found: task-telem'),
    );
    const emitter = new StoreEventEmitter();
    const handler = vi.fn();
    emitter.onEventType('degradation_triggered', handler);
    const resilient = new ResilientContextAssembler(inner, emitter);

    await resilient.assemble('task-telem');

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0]!;
    expect(event.eventType).toBe('degradation_triggered');
    expect(event.payload.component).toBe('ContextAssembler');
    expect(event.payload.fallback).toBe('degraded_payload');
  });

  it('telemetry severity is error for storage_unavailable', async () => {
    const inner = createFailingInner(
      new PDRuntimeError('storage_unavailable', 'DB error'),
    );
    const emitter = new StoreEventEmitter();
    const handler = vi.fn();
    emitter.onEventType('degradation_triggered', handler);
    const resilient = new ResilientContextAssembler(inner, emitter);

    await resilient.assemble('task-sev');

    const event = handler.mock.calls[0]![0]!;
    expect(event.payload.severity).toBe('error');
  });
});
