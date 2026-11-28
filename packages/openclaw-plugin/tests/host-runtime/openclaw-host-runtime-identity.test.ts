/**
 * PRI-1309 characterization — OpenClaw native after_tool_call identity through
 * the REAL adapter + shared production trajectory writer.
 *
 * These tests intentionally pin CURRENT behavior, not the desired end state:
 * OpenClaw native events can carry `runId` and `toolCallId`, while the shared
 * normalized context currently drops both. Durable row counts are therefore
 * measurements of the writer's content/enrichment identity behavior only;
 * unless explicitly stated they are not evidence about physical tool-call count.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTrajectorySchemaBase } from '@principles/core/runtime';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import { isolatePdCanonicalConfig } from '../utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import { createOpenClawHostRuntime, type AfterToolCallDispatch, type OpenClawHostRuntime } from '../../src/host-runtime/openclaw-host-runtime.js';
import { prepareOrdinaryAfterToolCallForSharedRuntime } from '../../src/hooks/pain.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from '../../src/openclaw-sdk.js';

interface ObservedRuntime {
  readonly adapter: OpenClawHostRuntime;
  readonly normalizedEvents: HostEvent[];
  readonly sharedResults: HostEventResult[];
}

interface ToolCallRow {
  readonly id: number;
  readonly session_id: string;
  readonly tool_name: string;
  readonly outcome: string;
  readonly params_json: string;
  readonly result_preview: string | null;
  readonly tool_use_id: string | null;
  readonly project_dir: string | null;
  readonly host_kind: string | null;
}

const workspaceDirs: string[] = [];

function createWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-openclaw-identity-'));
  workspaceDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    applyTrajectorySchemaBase(db);
  } finally {
    db.close();
  }
  return workspaceDir;
}

/**
 * Instrument the public HostRuntime object without replacing any production
 * behavior: the wrapper observes the exact normalized HostEvent entering the
 * shared runtime, then invokes the original dispatch unchanged.
 */
function createObservedRuntime(workspaceDir: string): ObservedRuntime {
  const adapter = createOpenClawHostRuntime({
    beforePromptBuild: async () => undefined,
    painEnrichmentProvider: (event, context) => prepareOrdinaryAfterToolCallForSharedRuntime(event, {
      ...context,
      workspaceDir,
      pluginConfig: {},
    }),
  });
  const normalizedEvents: HostEvent[] = [];
  const sharedResults: HostEventResult[] = [];
  const originalDispatch = adapter.runtime.dispatch.bind(adapter.runtime);
  adapter.runtime.dispatch = async (event) => {
    normalizedEvents.push(event);
    const result = await originalDispatch(event);
    sharedResults.push(result);
    return result;
  };
  return { adapter, normalizedEvents, sharedResults };
}

function nativeContext(workspaceDir: string, sessionId: string): PluginHookToolContext {
  return {
    workspaceDir,
    sessionId,
    agentId: 'main',
    modelProviderId: 'openai',
    modelId: 'gpt-5.1',
    contextTokenBudget: 128_000,
    contextWindowSource: 'model',
  };
}

function nativeAfterToolCall(input: {
  readonly sessionId: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly result?: unknown;
}): PluginHookAfterToolCallEvent {
  return {
    toolName: 'exec',
    params: { command: input.command ?? 'node scripts/verify.js' },
    result: input.result ?? { exitCode: 0, stdout: 'verification ok' },
    sessionId: input.sessionId,
    agentId: 'main',
    durationMs: 12,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
  };
}

function readToolCallRows(workspaceDir: string): ToolCallRow[] {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare(`
      SELECT id, session_id, tool_name, outcome, params_json, result_preview, tool_use_id, project_dir, host_kind
      FROM tool_calls
      ORDER BY id
    `).all() as ToolCallRow[];
  } finally {
    db.close();
  }
}

function metadataOf(result: HostEventResult | undefined): Record<string, unknown> {
  if (!result?.metadata) throw new Error('shared after_tool_call result metadata missing');
  return result.metadata;
}

function parseResultPreview(value: string | null): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) throw new Error('tool_calls.result_preview missing');
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('tool_calls.result_preview did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

function duplicateStatuses(results: readonly HostEventResult[]): unknown[] {
  return results.map((result) => metadataOf(result).duplicate);
}

/**
 * The host-visible adapter result is currently narrower than the shared
 * writer metadata: duplicate/eventId are internal observations in this suite,
 * not fields surfaced to OpenClaw's after_tool_call caller.
 */
function expectAdapterResultExposesNoIdentityMetadata(result: AfterToolCallDispatch): void {
  expect(Object.keys(result).sort()).toEqual(['outcome', 'warnings']);
  expect(Reflect.get(result, 'duplicate')).toBeUndefined();
  expect(Reflect.get(result, 'eventId')).toBeUndefined();
  expect(Reflect.get(result, 'metadata')).toBeUndefined();
}

afterEach(() => {
  for (const workspaceDir of workspaceDirs.splice(0)) {
    try {
      WorkspaceContext.fromHookContext({ workspaceDir }).eventLog.dispose();
    } finally {
      WorkspaceContext.dispose(workspaceDir);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
});

describe('PRI-1309 OpenClaw shared after_tool_call identity characterization', () => {
  it('A: direct normalized-event capture — native event/ctx toolCallId and runId are absent from context and tool_use_id persists NULL', async () => {
    const workspaceDir = createWorkspace();
    const harness = createObservedRuntime(workspaceDir);
    const sessionId = 'oc-identity-session-a';
    const event = nativeAfterToolCall({
      sessionId,
      runId: 'run-native-a',
      toolCallId: 'call-native-a',
    });
    const toolContext = {
      ...nativeContext(workspaceDir, sessionId),
      // Older relay shapes can carry the physical call id on ctx rather than
      // the event. Use a distinct value so any synthetic forwarding is
      // attributable to its source instead of ambiguous.
      toolCallId: 'ctx-native-a',
    };

    const dispatched = await harness.adapter.dispatchAfterToolCall(event, toolContext);

    expect(dispatched.warnings).toEqual([]);
    expectAdapterResultExposesNoIdentityMetadata(dispatched);
    expect(event.runId).toBe('run-native-a');
    expect(event.toolCallId).toBe('call-native-a');
    expect(toolContext.toolCallId).toBe('ctx-native-a');
    expect(harness.normalizedEvents).toHaveLength(1);
    const normalized = harness.normalizedEvents[0];
    if (!normalized) throw new Error('normalized after_tool_call event was not captured');
    expect(normalized.context.workspaceDir).toBe(workspaceDir);
    expect(normalized.context.sessionId).toBe(sessionId);
    expect(normalized.context.toolName).toBe('exec');
    expect(normalized.context.toolInput).toEqual({ command: 'node scripts/verify.js' });
    expect(normalized.context.toolOutput).toMatchObject({
      result: { exitCode: 0, stdout: 'verification ok' },
      durationMs: 12,
    });
    expect(normalized.context.modelContext).toMatchObject({
      modelProviderId: 'openai',
      modelId: 'gpt-5.1',
      contextTokenBudget: 128_000,
      contextWindowSource: 'model',
    });
    // Negative control for synthetic identity: neither native id is copied or
    // reinterpreted as another lineage field on the shared normalized event.
    expect(normalized.context.toolCallId).toBeUndefined();
    expect(normalized.context.turnId).toBeUndefined();
    expect(Reflect.get(normalized.context, 'runId')).toBeUndefined();

    expect(harness.sharedResults).toHaveLength(1);
    const metadata = metadataOf(harness.sharedResults[0]);
    expect(metadata.outcome).toBe('success');
    expect(metadata.duplicate).toBe(false);
    expect(typeof metadata.eventId).toBe('string');

    const rows = readToolCallRows(workspaceDir);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('shared writer did not persist the positive-control row');
    expect(row).toMatchObject({
      session_id: sessionId,
      tool_name: 'exec',
      outcome: 'success',
      tool_use_id: null,
      host_kind: 'openclaw',
      project_dir: path.resolve(workspaceDir),
    });
    expect(JSON.parse(row.params_json)).toEqual({ command: 'node scripts/verify.js' });
    const preview = parseResultPreview(row.result_preview);
    expect(preview.eventId).toBe(metadata.eventId);
  });

  it('B: distinct native toolCallIds yield two rows through indirect enrichment identity; SQLite row count is INCONCLUSIVE about physical calls', async () => {
    const workspaceDir = createWorkspace();
    const harness = createObservedRuntime(workspaceDir);
    const sessionId = 'oc-identity-session-distinct';
    const context = nativeContext(workspaceDir, sessionId);

    const firstAdapterResult = await harness.adapter.dispatchAfterToolCall(nativeAfterToolCall({
      sessionId,
      runId: 'run-native-distinct',
      toolCallId: 'call-native-distinct-1',
    }), context);
    const secondAdapterResult = await harness.adapter.dispatchAfterToolCall(nativeAfterToolCall({
      sessionId,
      runId: 'run-native-distinct',
      toolCallId: 'call-native-distinct-2',
    }), context);

    expectAdapterResultExposesNoIdentityMetadata(firstAdapterResult);
    expectAdapterResultExposesNoIdentityMetadata(secondAdapterResult);
    expect(harness.normalizedEvents).toHaveLength(2);
    for (const normalized of harness.normalizedEvents) {
      expect(normalized.context.toolCallId).toBeUndefined();
      expect(normalized.context.turnId).toBeUndefined();
      expect(Reflect.get(normalized.context, 'runId')).toBeUndefined();
    }
    expect(duplicateStatuses(harness.sharedResults)).toEqual([false, false]);

    const rows = readToolCallRows(workspaceDir);
    // Measurement only: two rows happened to be written for this two-dispatch
    // fixture. Because tool_use_id is NULL on both, the rows cannot prove that
    // two physical host calls occurred rather than redelivery/enrichment noise.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tool_use_id)).toEqual([null, null]);
    expect(rows.map((row) => row.host_kind)).toEqual(['openclaw', 'openclaw']);
    expect(rows[0]?.params_json).toBe(rows[1]?.params_json);
    expect(rows[0]?.result_preview).not.toBe(rows[1]?.result_preview);
    const firstPreview = parseResultPreview(rows[0]?.result_preview ?? null);
    const secondPreview = parseResultPreview(rows[1]?.result_preview ?? null);
    expect(firstPreview.eventId).not.toBe(secondPreview.eventId);
  });

  it('B-control: without a native toolCallId an exact repeat collapses to one row; row count is not physical-call evidence', async () => {
    const workspaceDir = createWorkspace();
    const harness = createObservedRuntime(workspaceDir);
    const sessionId = 'oc-identity-session-no-native-id';
    const context = nativeContext(workspaceDir, sessionId);
    const repeated = nativeAfterToolCall({
      sessionId,
      runId: 'run-native-no-call-id',
    });

    const firstAdapterResult = await harness.adapter.dispatchAfterToolCall(repeated, context);
    const secondAdapterResult = await harness.adapter.dispatchAfterToolCall(nativeAfterToolCall({
      sessionId,
      runId: 'run-native-no-call-id',
    }), context);

    expectAdapterResultExposesNoIdentityMetadata(firstAdapterResult);
    expectAdapterResultExposesNoIdentityMetadata(secondAdapterResult);
    expect(harness.normalizedEvents).toHaveLength(2);
    for (const normalized of harness.normalizedEvents) {
      expect(normalized.context.toolCallId).toBeUndefined();
      expect(normalized.context.turnId).toBeUndefined();
      expect(Reflect.get(normalized.context, 'runId')).toBeUndefined();
    }
    expect(duplicateStatuses(harness.sharedResults)).toEqual([false, true]);

    const rows = readToolCallRows(workspaceDir);
    // This one row is the measured content-shape collapse path. It cannot say
    // whether the input represented one redelivery or two physical calls.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool_use_id).toBeNull();
    expect(rows[0]?.host_kind).toBe('openclaw');
  });

  it('C: same native toolCallId folds identical content but changed content splits — enrichment/content identity is not true host identity', async () => {
    const workspaceDir = createWorkspace();
    const harness = createObservedRuntime(workspaceDir);
    const sessionId = 'oc-identity-session-redelivery';
    const context = nativeContext(workspaceDir, sessionId);
    const identity = {
      sessionId,
      runId: 'run-native-redelivery',
      toolCallId: 'call-native-redelivery',
    } as const;

    const firstAdapterResult = await harness.adapter.dispatchAfterToolCall(nativeAfterToolCall(identity), context);
    const redeliveryAdapterResult = await harness.adapter.dispatchAfterToolCall(nativeAfterToolCall(identity), context);
    const changedAdapterResult = await harness.adapter.dispatchAfterToolCall(nativeAfterToolCall({
      ...identity,
      result: { exitCode: 0, stdout: 'changed output for the same native id' },
    }), context);

    expectAdapterResultExposesNoIdentityMetadata(firstAdapterResult);
    expectAdapterResultExposesNoIdentityMetadata(redeliveryAdapterResult);
    expectAdapterResultExposesNoIdentityMetadata(changedAdapterResult);
    expect(duplicateStatuses(harness.sharedResults)).toEqual([false, true, false]);
    const rows = readToolCallRows(workspaceDir);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tool_use_id)).toEqual([null, null]);
    expect(rows.map((row) => row.host_kind)).toEqual(['openclaw', 'openclaw']);
    expect(rows[0]?.result_preview).not.toBe(rows[1]?.result_preview);
    const firstPreview = parseResultPreview(rows[0]?.result_preview ?? null);
    const changedPreview = parseResultPreview(rows[1]?.result_preview ?? null);
    // Measured nuance: although both dispatches supply the same native id to
    // the enrichment provider, the shared writer's derived eventId still
    // changes with the result content. The persisted preview is therefore
    // content/enrichment identity, not stable physical host-call identity.
    expect(firstPreview.eventId).not.toBe(changedPreview.eventId);
    expect(firstPreview.result).not.toEqual(changedPreview.result);
    for (const normalized of harness.normalizedEvents) {
      expect(normalized.context.toolCallId).toBeUndefined();
      expect(normalized.context.turnId).toBeUndefined();
      expect(Reflect.get(normalized.context, 'runId')).toBeUndefined();
    }
  });
});
