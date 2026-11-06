import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore, SqlitePIArtifactStore, trimToBudget } from '@principles/core/runtime';
import type { ActivationStatusRecord } from '@principles/core/runtime';
import Database from 'better-sqlite3';
import { PromptActivationReader, RUNTIME_PRINCIPLE_BUDGET } from '../../src/core/runtime-prompt-activation-reader.js';
import * as yaml from 'js-yaml';
import { getDefaultPdConfig } from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';

const TEST_PRINCIPLE_TEXT = 'UNIQUE_RUNTIME_TEST_PRINCIPLE_7x9k2';

const CONFIG_IDENTITY_FIELDS = [
  'host',
  'hostVersion',
  'runtimeMode',
  'pluginVersion',
  'effectiveHookSetFingerprint',
  'evidenceCoverage',
] as const;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

beforeEach(async () => {
  vi.clearAllMocks();
  const { resetAdaptiveConfigIdentityStateForTest } = await import('../../src/core/adaptive-config-identity.js');
  resetAdaptiveConfigIdentityStateForTest();
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';

  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-prompt-v2-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });

  const pdDir = path.join(tempWorkspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });

  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try {
    sqliteConn?.close();
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort on Windows
  }
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = '';
});

vi.mock('../../src/core/diagnostician-task-store.js', async () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordHeartbeatDiagnosis: vi.fn(),
      recordRuntimeActivationsInjected: vi.fn(),
      recordAdaptiveDelivery: vi.fn(),
    }),
  },
}));

// Spy mode keeps the real identity collector while letting individual tests
// prove where the snapshot is produced and what happens when collection fails.
vi.mock('../../src/core/adaptive-config-identity.js', { spy: true });

/**
 * Legacy reducer surface. Kept as a live fixture so tests can prove that
 * reducer-reported principles are NOT injected (Runtime activations are the
 * single injection authority).
 */
const { legacyTestState } = vi.hoisted(() => ({
  legacyTestState: {
    active: [] as Array<{ id: string; text: string; priority?: 'P0' | 'P1' | 'P2'; createdAt: string }>,
    probation: [] as Array<{ id: string; text: string; priority?: 'P0' | 'P1' | 'P2'; createdAt: string }>,
  },
}));

vi.mock('../../src/core/workspace-context.js', async () => {
  const { EventLogService } = await import('../../src/core/event-log.js');
  const mockEventLog = EventLogService.get('/mock');
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn().mockImplementation(() => ({
        workspaceDir: tempWorkspaceDir,
        stateDir: tempStateDir,
        resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
        trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
        config: { get: vi.fn() },
        eventLog: mockEventLog,
        evolutionReducer: {
          getActivePrinciples: vi.fn(() => legacyTestState.active),
          getProbationPrinciples: vi.fn(() => legacyTestState.probation),
        },
      })),
      fromHookContextExplicit: vi.fn().mockImplementation(() => ({
        workspaceDir: tempWorkspaceDir,
        stateDir: tempStateDir,
        resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
        trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
        config: { get: vi.fn() },
        eventLog: mockEventLog,
        evolutionReducer: {
          getActivePrinciples: vi.fn(() => legacyTestState.active),
          getProbationPrinciples: vi.fn(() => legacyTestState.probation),
        },
      })),
    },
  };
});

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue({ currentGfi: 20 }),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: { getExtensionRoot: vi.fn().mockReturnValue('/fake/extension') },
}));

vi.mock('../../src/core/empathy-keyword-matcher.js', () => ({
  matchEmpathyKeywords: vi.fn().mockReturnValue({ score: 0, matched: null, severity: 'none', matchedTerms: [] }),
  loadKeywordStore: vi.fn().mockReturnValue({ terms: {}, stats: { totalHits: 0 } }),
  saveKeywordStore: vi.fn(),
  shouldTriggerOptimization: vi.fn().mockReturnValue(false),
  getKeywordStoreSummary: vi.fn().mockReturnValue({ totalTerms: 0, highFalsePositiveTerms: [] }),
}));

vi.mock('../../src/core/empathy-types.js', () => ({
  severityToPenalty: vi.fn().mockReturnValue(5),
  DEFAULT_EMPATHY_KEYWORD_CONFIG: {},
}));

vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: {
    get: vi.fn().mockReturnValue({
      recordTruePositive: vi.fn(),
      flush: vi.fn(),
    }),
  },
}));

vi.mock('../../src/core/focus-history.js', () => ({
  extractSummary: vi.fn().mockReturnValue(''),
  getHistoryVersions: vi.fn().mockResolvedValue([]),
  parseWorkingMemorySection: vi.fn().mockReturnValue(null),
  workingMemoryToInjection: vi.fn().mockReturnValue(''),
  autoCompressFocus: vi.fn().mockReturnValue({ compressed: false, reason: 'not_needed' }),
  safeReadCurrentFocus: vi.fn().mockReturnValue({ content: '', recovered: false, validationErrors: [] }),
}));

function makeMinimalEvent(overrides: {
  trigger?: string;
  sessionId?: string;
} = {}) {
  const { trigger = 'user', sessionId = 'test-session-v2' } = overrides;
  return {
    prompt: 'hello world',
    messages: [],
    trigger,
    sessionId,
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0];
}

function makeCtx(overrides: {
  workspaceDir?: string;
  trigger?: string;
  sessionId?: string;
  runId?: string;
  contextTokenBudget?: number;
  contextWindowSource?: string;
  modelProviderId?: string;
  modelId?: string;
} = {}) {
  const {
    workspaceDir = tempWorkspaceDir,
    trigger = 'user',
    sessionId = 'test-session-v2',
    runId,
    contextTokenBudget,
    contextWindowSource,
    modelProviderId,
    modelId,
  } = overrides;
  return {
    workspaceDir,
    trigger,
    sessionId,
    ...(runId !== undefined ? { runId } : {}),
    ...(contextTokenBudget !== undefined ? { contextTokenBudget } : {}),
    ...(contextWindowSource !== undefined ? { contextWindowSource } : {}),
    ...(modelProviderId !== undefined ? { modelProviderId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {},
      config: {},
    },
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
}
async function insertPromptActivation(overrides: {
  artifactId: string;
  principleId: string;
  channel?: string;
  action?: string;
  targetRef?: string;
}) {
  const {
    artifactId,
    principleId,
    channel = 'prompt',
    action = 'prompt_activate',
    targetRef = `ledger://${principleId}`,
  } = overrides;

  const activationStore = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  const idempotencyKey = `${artifactId}::${channel}`;

  await activationStore.recordActivation({
    activationId: `act_prompt_${principleId}`,
    idempotencyKey,
    artifactId,
    channel: channel as ActivationStatusRecord['channel'],
    action,
    targetRef,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function insertValidatedPrincipleArtifact(overrides: {
  artifactId: string;
  principleId: string;
  text?: string;
  validationStatus?: string;
  contentJson?: string;
}) {
  const {
    artifactId,
    principleId,
    text = TEST_PRINCIPLE_TEXT,
    validationStatus = 'validated',
    contentJson,
  } = overrides;

  const db = sqliteConn.getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    'principle',
    `task_${principleId}`,
    principleId,
    null,
    '[]',
    validationStatus,
    contentJson ?? JSON.stringify({ principleId, text }),
    now,
    now,
  );
}

describe('Adaptive activation — actual local prompt entry', () => {
  async function seed() {
    // More qualified principles than Native can pack: the intervention must
    // change the real final prompt, not merely report a successful selection.
    for (let i = 0; i < 20; i++) {
      const principleId = `AA-${String(i).padStart(2, '0')}`;
      insertValidatedPrincipleArtifact({ artifactId: `art-${principleId}`, principleId, text: `${principleId}-body-${'Z'.repeat(300)}` });
      await insertPromptActivation({ artifactId: `art-${principleId}`, principleId });
    }
  }

  function configured(principleId: string) {
    const ctx = makeCtx();
    if (!ctx.api) throw new Error('test requires plugin API');
    ctx.api.pluginConfig = { adaptiveActivation: {
      enabled: true, workspaceDir: tempWorkspaceDir, artifactId: `art-${principleId}`,
      activationId: `act_prompt_${principleId}`, expiresAt: new Date(Date.now() + 60000).toISOString(), softTimeoutMs: 15000,
    } };
    return ctx;
  }

  const admitted = () => ({ ...makeMinimalEvent(), currentUserMessage: '[PD-AA:delivery-review:v1]\nReview delivery', currentUserMessageId: 'host-admission-1' });

  it('prioritizes an omitted authorized target and records only final selected IDs', async () => {
    await seed();
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const native = await handleBeforePromptBuild(admitted(), makeCtx());
    const target = Array.from({ length: 20 }, (_, i) => `AA-${String(i).padStart(2, '0')}`)
      .find(id => !native?.prependSystemContext?.includes(`${id}-body-`));
    expect(target).toBeDefined();
    const { EventLogService } = await import('../../src/core/event-log.js');
    const spy = (EventLogService.get as ReturnType<typeof vi.fn>)().recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();
    const ctx = configured(target!);
    const result = await handleBeforePromptBuild(admitted(), ctx);
    expect(result?.prependSystemContext).toContain(`${target}-body-`);
    expect(result?.prependSystemContext?.split(`${target}-body-`)).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]![0] as { principleIds: string[] };
    expect(payload.principleIds).toContain(target);
    for (const id of payload.principleIds) expect(result?.prependSystemContext).toContain(`${id}-body-`);
    expect(ctx.api?.logger?.info).toHaveBeenCalledWith(expect.stringContaining('"addedTarget":true'));
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    expect(journal).toHaveBeenCalledTimes(2);
    const start = journal.mock.calls[0]![1] as Record<string, unknown>;
    const end = journal.mock.calls[1]![1] as Record<string, unknown>;
    expect(start).toMatchObject({ receiptState: 'open', execution: 'unknown', selectionPending: true, submission: 'unknown' });
    expect(end).toMatchObject({ hookInvocationId: start.hookInvocationId, receiptState: 'closed', execution: 'completed', payload: 'prepared', selection: 'selected', submission: 'unknown' });
    expect(end).not.toHaveProperty('requestId');
    expect(spy.mock.calls[0]![0]).toHaveProperty('hookInvocationId', start.hookInvocationId);
  });

  it('reuses a Native target without duplicating or claiming a new contribution', async () => {
    insertValidatedPrincipleArtifact({ artifactId: 'art-AA-only', principleId: 'AA-only', text: 'AA-only-body' });
    await insertPromptActivation({ artifactId: 'art-AA-only', principleId: 'AA-only' });
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const ctx = configured('AA-only');
    const result = await handleBeforePromptBuild(admitted(), ctx);
    expect(result?.prependSystemContext?.split('AA-only-body')).toHaveLength(2);
    expect(ctx.api?.logger?.info).toHaveBeenCalledWith(expect.stringContaining('"addedTarget":false'));
    expect(ctx.api?.logger?.info).toHaveBeenCalledWith(expect.stringContaining('native_already_contains_target'));
  });

  it('preserves Native when the current native message identity is unavailable', async () => {
    await seed();
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = { ...makeMinimalEvent(), currentUserMessage: '[PD-AA:delivery-review:v1]\nReview' };
    const native = await handleBeforePromptBuild(event, makeCtx());
    const result = await handleBeforePromptBuild(event, configured('AA-19'));
    expect(result).toEqual(native);
    const { EventLogService } = await import('../../src/core/event-log.js');
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    expect(journal.mock.calls[1]![1]).toMatchObject({ selection: 'skipped', payload: 'none', submission: 'unknown' });
  });

  it('does not interpret a quoted scene marker as a current request', async () => {
    await seed();
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = { ...admitted(), currentUserMessage: 'Quoted example:\n[PD-AA:delivery-review:v1]' };
    const native = await handleBeforePromptBuild(event, makeCtx());
    expect(await handleBeforePromptBuild(event, configured('AA-19'))).toEqual(native);
  });

  it('does not inject a configured artifact without an active authorized candidate', async () => {
    insertValidatedPrincipleArtifact({ artifactId: 'art-AA-inactive', principleId: 'AA-inactive', text: 'INACTIVE-MUST-NOT-APPEAR' });
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(admitted(), configured('AA-inactive'));
    expect(JSON.stringify(result)).not.toContain('INACTIVE-MUST-NOT-APPEAR');
  });

  async function sharedPrepared(deadlineAt = Date.now() + 15000) {
    await seed();
    const { buildActivePrinciplePromptContext } = await import('@principles/host-runtime');
    const native = await buildActivePrinciplePromptContext({ workspaceDir: tempWorkspaceDir });
    const target = Array.from({ length: 20 }, (_, i) => `AA-${String(i).padStart(2, '0')}`)
      .find(id => !native.principleIds.includes(id));
    if (!target) throw new Error('fixture requires a target outside the Native pack');
    const packed = await buildActivePrinciplePromptContext({ workspaceDir: tempWorkspaceDir,
      adaptivePriority: { artifactId: `art-${target}`, activationId: `act_prompt_${target}` }, deadlineAt });
    expect(packed.adaptivePacking?.status).toBe('prioritized');
    return { native, target, packed };
  }

  it('carries shared packing through final prompt assembly with exact target bytes', async () => {
    const { target, packed } = await sharedPrepared();
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(admitted(), configured(target), packed);
    expect(result?.prependSystemContext?.split(`${target}-body-`)).toHaveLength(2);
    const { EventLogService } = await import('../../src/core/event-log.js');
    const spy = (EventLogService.get as ReturnType<typeof vi.fn>)().recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    expect(spy.mock.calls[0]![0]).toMatchObject({ principleIds: packed.principleIds, activationIds: packed.activationIds, artifactIds: packed.artifactIds });
  });

  it('removes a shared target whose artifact changes between packing and final assembly', async () => {
    const { target, packed } = await sharedPrepared();
    sqliteConn.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?')
      .run(JSON.stringify({ principleId: target, text: 'changed after pack' }), `art-${target}`);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(admitted(), configured(target), packed);
    expect(result?.prependSystemContext).not.toContain(`${target}-body-`);
    expect(result?.prependSystemContext).not.toContain('changed after pack');
    const { EventLogService } = await import('../../src/core/event-log.js');
    const spy = (EventLogService.get as ReturnType<typeof vi.fn>)().recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    const payload = spy.mock.calls[0]![0] as { principleIds: string[]; activationIds: string[] };
    expect(payload.principleIds).not.toContain(target);
    expect(payload.activationIds).not.toContain(`act_prompt_${target}`);
    for (const id of payload.principleIds) expect(result?.prependSystemContext).toContain(`${id}-body-`);
  });

  it('removes the shared contribution when its deadline has elapsed', async () => {
    const { target, packed } = await sharedPrepared(Date.now() - 1);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(admitted(), configured(target), packed);
    expect(result?.prependSystemContext).not.toContain(`${target}-body-`);
  });

  it('disabling the mapping restores the exact shared Native baseline', async () => {
    const { native, target, packed } = await sharedPrepared();
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const expected = await handleBeforePromptBuild(admitted(), makeCtx(), native);
    const result = await handleBeforePromptBuild(admitted(), makeCtx(), packed);
    expect(result).toEqual(expected);
    expect(result?.prependSystemContext).not.toContain(`${target}-body-`);
  });

  it('a configuration change cannot close the original invocation under a different target', async () => {
    const { target, packed } = await sharedPrepared();
    const original = { artifactId: `art-${target}`, activationId: `act_prompt_${target}` };
    const { beginAdaptivePromptInvocation, handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const hookInvocationId = beginAdaptivePromptInvocation(configured(target), original, 'shared');
    if (!packed.adaptivePacking) throw new Error('requires prepared packing');
    packed.adaptivePacking.hookInvocationId = hookInvocationId;
    const replacement = target === 'AA-00' ? 'AA-01' : 'AA-00';
    await handleBeforePromptBuild(admitted(), configured(replacement), packed);
    const { EventLogService } = await import('../../src/core/event-log.js');
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    expect(journal).toHaveBeenCalledTimes(2);
    expect(journal.mock.calls[1]![1]).toMatchObject({ hookInvocationId, receiptState: 'closed', ...original, payload: 'none' });

    // Both records of one invocation carry the same frozen identity snapshot.
    const start = journal.mock.calls[0]![1] as Record<string, unknown>;
    const end = journal.mock.calls[1]![1] as Record<string, unknown>;
    expect(start).toMatchObject({
      host: 'openclaw',
      hostVersion: 'unknown',
      runtimeMode: 'shared',
      effectiveHookSetFingerprint: 'unknown',
      evidenceCoverage: 'partial',
    });
    expect(start.pluginVersion).toEqual(expect.any(String));
    expect(start.pluginVersion).not.toBe('unknown');
    expect(start.configIdentityCoverage).toBeDefined();
    for (const field of CONFIG_IDENTITY_FIELDS) {
      expect(end[field]).toEqual(start[field]);
    }
  });

  it('binds the terminal record to the snapshot taken when the invocation opened', async () => {
    const { target, packed } = await sharedPrepared();
    const identityModule = await import('../../src/core/adaptive-config-identity.js');
    identityModule.setAdaptiveHookSet([
      { surfaceId: 'hook:before_prompt_build', event: 'before_prompt_build', enabled: true },
      { surfaceId: 'hook:llm_output', event: 'llm_output', enabled: true },
    ]);
    const { EventLogService } = await import('../../src/core/event-log.js');
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    const original = { artifactId: `art-${target}`, activationId: `act_prompt_${target}` };
    const { beginAdaptivePromptInvocation, handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const hookInvocationId = beginAdaptivePromptInvocation(configured(target), original, 'shared');
    const start = journal.mock.calls[0]![1] as Record<string, unknown>;
    expect(start.effectiveHookSetFingerprint).toMatch(/^sha256:/);
    expect(start.evidenceCoverage).toBe('partial');

    // Environment changes while this invocation is in flight.
    identityModule.setAdaptiveHookSet([
      { surfaceId: 'hook:before_tool_call', event: 'before_tool_call', enabled: false },
    ]);
    if (!packed.adaptivePacking) throw new Error('requires prepared packing');
    packed.adaptivePacking.hookInvocationId = hookInvocationId;
    await handleBeforePromptBuild(admitted(), configured(target), packed);

    const end = journal.mock.calls[1]![1] as Record<string, unknown>;
    expect(end.hookInvocationId).toBe(hookInvocationId);
    for (const field of CONFIG_IDENTITY_FIELDS) {
      expect(end[field]).toEqual(start[field]);
    }

    // Only the NEXT invocation picks up the new environment.
    beginAdaptivePromptInvocation(configured(target), original, 'shared');
    const nextStart = journal.mock.calls[2]![1] as Record<string, unknown>;
    expect(nextStart.effectiveHookSetFingerprint).not.toBe(start.effectiveHookSetFingerprint);
  });

  it('identity collection failure leaves prompt assembly on the normal fallback path', async () => {
    insertValidatedPrincipleArtifact({ artifactId: 'art-AA-only', principleId: 'AA-only', text: 'AA-only-body' });
    await insertPromptActivation({ artifactId: 'art-AA-only', principleId: 'AA-only' });
    const identityModule = await import('../../src/core/adaptive-config-identity.js');
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    const baseline = await handleBeforePromptBuild(admitted(), configured('AA-only'));

    vi.mocked(identityModule.buildAdaptiveConfigIdentitySnapshot).mockImplementationOnce(() => {
      throw new Error('collector unavailable');
    });
    const failingCtx = configured('AA-only');
    const degraded = await handleBeforePromptBuild(admitted(), failingCtx);

    expect(degraded).toEqual(baseline);
    expect(failingCtx.api?.logger?.warn).toHaveBeenCalledWith(expect.stringContaining('Config identity unavailable'));
  });

  it('journal storage failure does not remove an otherwise valid intervention', async () => {
    insertValidatedPrincipleArtifact({ artifactId: 'art-AA-only', principleId: 'AA-only', text: 'AA-only-body' });
    await insertPromptActivation({ artifactId: 'art-AA-only', principleId: 'AA-only' });
    const { EventLogService } = await import('../../src/core/event-log.js');
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    journal.mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const ctx = configured('AA-only');
    const result = await handleBeforePromptBuild(admitted(), ctx);
    expect(result?.prependSystemContext).toContain('AA-only-body');
    expect(ctx.api?.logger?.warn).toHaveBeenCalledWith(expect.stringContaining('Invocation journal unavailable'));
  });

  it('runs shared dispatch through real packing and final assembly with one invocation journal', async () => {
    await seed();
    const { buildActivePrinciplePromptContext } = await import('@principles/host-runtime');
    const baseline = await buildActivePrinciplePromptContext({ workspaceDir: tempWorkspaceDir });
    const target = Array.from({ length: 20 }, (_, i) => `AA-${String(i).padStart(2, '0')}`).find(id => !baseline.principleIds.includes(id));
    if (!target) throw new Error('fixture requires a target outside Native');
    const ctx = configured(target);
    const { beginAdaptivePromptInvocation, handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const { createOpenClawHostRuntime } = await import('../../src/host-runtime/openclaw-host-runtime.js');
    const { EventLogService } = await import('../../src/core/event-log.js');
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    const mapping = { artifactId: `art-${target}`, activationId: `act_prompt_${target}` };
    const runtime = createOpenClawHostRuntime({
      adaptivePriorityProvider: () => ({ ...mapping, deadlineAt: Date.now() + 15000,
        hookInvocationId: beginAdaptivePromptInvocation(ctx, mapping, 'shared') }),
      beforePromptBuild: (event, context, prompt) => {
        expect(journal).toHaveBeenCalledTimes(1);
        expect(journal.mock.calls[0]![1]).toMatchObject({ receiptState: 'open' });
        return handleBeforePromptBuild(event, { ...context, api: ctx.api }, prompt);
      },
    });
    const result = await runtime.dispatchBeforePromptBuild(admitted(), ctx);
    expect(result?.prependSystemContext).toContain(`${target}-body-`);
    expect(journal).toHaveBeenCalledTimes(2);
    expect(journal.mock.calls[1]![1]).toMatchObject({ hookInvocationId: journal.mock.calls[0]![1].hookInvocationId,
      receiptState: 'closed', payload: 'prepared', selection: 'selected', submission: 'unknown' });

    // The real entry (not a hand-built record) produced the identity once for
    // the opening record; the closing record reused the same snapshot.
    const { buildAdaptiveConfigIdentitySnapshot } = await import('../../src/core/adaptive-config-identity.js');
    expect(buildAdaptiveConfigIdentitySnapshot).toHaveBeenCalledTimes(1);
    const start = journal.mock.calls[0]![1] as Record<string, unknown>;
    const end = journal.mock.calls[1]![1] as Record<string, unknown>;
    expect(start).toMatchObject({ host: 'openclaw', runtimeMode: 'shared', hostVersion: 'unknown' });
    for (const field of CONFIG_IDENTITY_FIELDS) {
      expect(end[field]).toEqual(start[field]);
    }
  });

  it.each([
    ['ordinary request', 'none_applicable', 'completed'],
    ['[PD-AA:delivery-review:v1]\nReview', 'unavailable', 'degraded'],
  ])('distinguishes a completed scene assessment from missing shared preparation: %s', async (currentUserMessage, selection, execution) => {
    insertValidatedPrincipleArtifact({ artifactId: 'art-AA-only', principleId: 'AA-only', text: 'AA-only-body' });
    await insertPromptActivation({ artifactId: 'art-AA-only', principleId: 'AA-only' });
    const { buildActivePrinciplePromptContext } = await import('@principles/host-runtime');
    const native = await buildActivePrinciplePromptContext({ workspaceDir: tempWorkspaceDir });
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild({ ...admitted(), currentUserMessage }, configured('AA-only'), native);
    expect(result?.prependSystemContext).toContain('AA-only-body');
    const { EventLogService } = await import('../../src/core/event-log.js');
    const journal = (EventLogService.get as ReturnType<typeof vi.fn>)().recordAdaptiveDelivery as ReturnType<typeof vi.fn>;
    expect(journal.mock.calls[1]![1]).toMatchObject({ selection, execution, payload: 'none', submission: 'unknown' });
  });
});

describe('Runtime V2 prompt activation injection', () => {
  it('shared authority reader preserves owner approval and approver identity', async () => {
    const artifactId = 'art-v2-authority-001';
    const principleId = 'princ-v2-authority-001';
    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });
    const now = new Date().toISOString();
    sqliteConn.getDb().prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', ?, ?, ?)
    `).run('approval-v2-authority-001', artifactId, now, now, 'owner-authority-1');

    const result = await new PromptActivationReader(tempWorkspaceDir).readActivatedPrinciples();
    expect(result.principles[0]).toMatchObject({ authority: 'owner', approvedBy: 'owner-authority-1' });
  });

  it('absence of an approved row remains system-policy authority', async () => {
    const artifactId = 'art-v2-authority-002';
    const principleId = 'princ-v2-authority-002';
    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const result = await new PromptActivationReader(tempWorkspaceDir).readActivatedPrinciples();
    expect(result.principles[0]).toMatchObject({ authority: 'system_policy' });
    expect(result.principles[0]?.approvedBy).toBeUndefined();
  });

  it('owner-approved activated principle changes future prompt', async () => {
    const artifactId = 'art-v2-prompt-001';
    const principleId = 'princ-v2-001';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    // Runtime principles are now in prependSystemContext (highest attention)
    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
  });

  it('unactivated principle is not injected', async () => {
    const artifactId = 'art-v2-no-act-002';
    const principleId = 'princ-v2-no-act-002';

    insertValidatedPrincipleArtifact({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.appendSystemContext).not.toContain(TEST_PRINCIPLE_TEXT);
  });

  it('non-prompt activation is not injected', async () => {
    const artifactId = 'art-v2-defer-003';
    const principleId = 'princ-v2-defer-003';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({
      artifactId,
      principleId,
      channel: 'defer_archive',
      action: 'defer_archive',
      targetRef: `ledger://${principleId}#archived`,
    });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.appendSystemContext).not.toContain(TEST_PRINCIPLE_TEXT);
  });

  it('deactivated activation is not injected into prompt', async () => {
    const artifactId = 'art-v2-deactivated-200';
    const principleId = 'princ-v2-deactivated-200';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    // Deactivate the activation
    const store = new SqliteActivationStateStore(sqliteConn);
    const deactivated = await store.deactivateActivation(`act_prompt_${principleId}`, new Date().toISOString());
    expect(deactivated).toBe(true);

    // Close test connection so the reader gets a fresh view
    sqliteConn.close();

    // Verify the deactivation persisted via a fresh connection
    const verifyConn = new SqliteConnection(tempWorkspaceDir);
    const row = verifyConn.getDb().prepare(
      'SELECT deactivated_at FROM activations WHERE activation_id = ?'
    ).get(`act_prompt_${principleId}`) as { deactivated_at: string | null } | undefined;
    expect(row?.deactivated_at).toBeTruthy();
    verifyConn.close();

    const reader = new PromptActivationReader(tempWorkspaceDir);
    const result = await reader.readActivatedPrinciples();

    expect(result.principles).toHaveLength(0);
  });

  it('prompt feature flag check is present — core flag cannot be disabled by config', async () => {
    const artifactId = 'art-v2-flag-004';
    const principleId = 'princ-v2-flag-004';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const pdDir = path.join(tempWorkspaceDir, '.pd');
    if (!fs.existsSync(pdDir)) {
      fs.mkdirSync(pdDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(pdDir, 'feature-flags.yaml'),
      'prompt:\n  enabled: false\n',
      'utf8',
    );

    const infoSpy = vi.fn();
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      trigger: 'user',
      sessionId: 'test-session-v2',
      api: {
        logger: { info: infoSpy, warn: vi.fn(), error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), ctx);

    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);

    const infoCalls = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasCoreFlagWarning = infoCalls.some(
      (c: string) => c.includes('core flag cannot be disabled') || c.includes('warnings'),
    );
    expect(hasCoreFlagWarning || result?.prependSystemContext).toBeTruthy();
  });

  it('missing activated artifact fails loud without crashing', async () => {
    const artifactId = 'art-v2-missing-005';
    const principleId = 'princ-v2-missing-005';

    // P1-3: Insert a dangling activation directly via DB, bypassing the store's
    // FK check (recordActivation rejects non-existent pi_artifact). This test
    // verifies the hook handles a legacy/dangling activation gracefully, so the
    // activation must reference an artifact that does NOT exist in pi_artifacts.
    const now = new Date().toISOString();
    sqliteConn.getDb().prepare(`
      INSERT OR REPLACE INTO activations
        (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `act_prompt_${principleId}`,
      `${artifactId}::prompt`,
      artifactId,
      'prompt',
      'prompt_activate',
      `ledger://${principleId}`,
      now,
      null,
    );

    const infoSpy = vi.fn();
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      trigger: 'user',
      sessionId: 'test-session-v2',
      api: {
        logger: { info: infoSpy, warn: vi.fn(), error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), ctx);

    expect(result).toBeDefined();
    expect(result?.appendSystemContext).not.toContain(TEST_PRINCIPLE_TEXT);
    const infoCalls = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasActivationWarning = infoCalls.some((c: string) => c.includes('artifact_not_found') || c.includes('artifact_query_unexpected') || c.includes('activation'));
    expect(hasActivationWarning).toBe(true);
  });

  it('malformed content_json in artifact fails loud without crashing', async () => {
    const artifactId = 'art-v2-malformed-006';
    const principleId = 'princ-v2-malformed-006';

    insertValidatedPrincipleArtifact({
      artifactId,
      principleId,
      contentJson: '{not valid json<<<',
    });
    await insertPromptActivation({ artifactId, principleId });

    const warnSpy = vi.fn();
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      trigger: 'user',
      sessionId: 'test-session-v2',
      api: {
        logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), ctx);

    expect(result).toBeDefined();
    expect(result?.appendSystemContext).not.toContain(TEST_PRINCIPLE_TEXT);
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasParseWarning = warnCalls.some((c: string) => c.includes('json_parse_error') || c.includes('activation'));
    expect(hasParseWarning).toBe(true);
  });

  it('no legacy promotion is required for Runtime V2 injection', async () => {
    const artifactId = 'art-v2-no-legacy-007';
    const principleId = 'princ-v2-no-legacy-007';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    const mockWctx = (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const promoteSpy = vi.fn();

    if (mockWctx?.evolutionReducer) {
      mockWctx.evolutionReducer.promote = promoteSpy;
    }

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    expect(promoteSpy).not.toHaveBeenCalled();
  });
});

describe('Runtime V2 prompt activation — additional guard tests', () => {
  it('rejected/pending artifact is not injected', async () => {
    const artifactId = 'art-v2-rejected-101';
    const principleId = 'princ-v2-rejected-101';

    insertValidatedPrincipleArtifact({ artifactId, principleId, validationStatus: 'rejected' });
    await insertPromptActivation({ artifactId, principleId });

    const reader = new PromptActivationReader(tempWorkspaceDir);
    const result = await reader.readActivatedPrinciples();

    expect(result.principles).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('artifact_not_validated'))).toBe(true);
  });

  it('prompt channel with wrong action is not injected', async () => {
    const artifactId = 'art-v2-wrong-action-102';
    const principleId = 'princ-v2-wrong-action-102';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({
      artifactId,
      principleId,
      channel: 'prompt',
      action: 'prompt_deactivate',
    });

    const reader = new PromptActivationReader(tempWorkspaceDir);
    const result = await reader.readActivatedPrinciples();

    expect(result.principles).toHaveLength(0);
  });

  it('multiple or oversized Runtime V2 principles are trimmed to budget', async () => {
    const longText = 'A'.repeat(800);
    for (let i = 0; i < 5; i++) {
      const artifactId = `art-v2-budget-${i}`;
      const principleId = `princ-v2-budget-${i}`;
      insertValidatedPrincipleArtifact({ artifactId, principleId, text: longText });
      await insertPromptActivation({ artifactId, principleId });
    }

    const reader = new PromptActivationReader(tempWorkspaceDir);
    const result = await reader.readActivatedPrinciples();

    expect(result.principles.length).toBe(5);

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const hookResult = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    // Runtime principles are now in prependSystemContext
    const injected = hookResult?.prependSystemContext ?? '';
    const markerCount = (injected.match(/princ-v2-budget-/g) || []).length;
    expect(markerCount).toBeLessThan(5);
    expect(markerCount).toBeGreaterThan(0);
  });

  it('malformed DB/config input fails loud with warning', async () => {
    const pdDir = path.join(tempWorkspaceDir, '.pd');
    // PRI-305/PRI-307: Write a malformed .pd/config.yaml with dangerous keys
    // The core validator rejects __proto__ and constructor as dangerous keys
    fs.writeFileSync(
      path.join(pdDir, 'config.yaml'),
      'version: 1\nfeatures:\n  __proto__:\n    category: core\n    enabled: true\n  prompt:\n    category: core\n    enabled: true\n  constructor:\n    category: core\n    enabled: false\nruntimeProfiles:\n  openclaw.default:\n    type: openclaw\n    source: default\ninternalAgents:\n  defaultRuntime: openclaw.default\n  agents:\n    diagnostician:\n      enabled: true\n    dreamer:\n      enabled: true\n    scribe:\n      enabled: true\n    artificer:\n      enabled: true\n    philosopher:\n      enabled: false\n    evaluator:\n      enabled: false\n    rolloutReviewer:\n      enabled: false\n    correctionObserver:\n      enabled: false\n',
      'utf8',
    );

    const warnSpy = vi.fn();
    const reader = new PromptActivationReader(tempWorkspaceDir, {
      logger: { warn: warnSpy, info: vi.fn(), error: vi.fn() },
    });
    const result = await reader.readActivatedPrinciples();

    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // PRI-305/PRI-307: Core validator rejects dangerous keys as errors.
    // The plugin config loader logs config errors as warnings.
    const hasDangerousKeyWarning = warnCalls.some(
      (c: string) => c.includes('dangerous key') || c.includes('__proto__') || c.includes('constructor') || c.includes('Config error'),
    );
    expect(hasDangerousKeyWarning).toBe(true);
    // With malformed config, defaults are used (prompt enabled by default),
    // but no DB data exists, so principles should be empty
    expect(result.principles).toEqual([]);
  });

  it('reader uses normalized workspaceDir correctly', async () => {
    const artifactId = 'art-v2-norm-105';
    const principleId = 'princ-v2-norm-105';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const reader = new PromptActivationReader(tempWorkspaceDir);
    const result = await reader.readActivatedPrinciples();

    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].principleId).toBe(principleId);
  });

  it('pending validation status artifact is not injected', async () => {
    const artifactId = 'art-v2-pending-106';
    const principleId = 'princ-v2-pending-106';

    insertValidatedPrincipleArtifact({ artifactId, principleId, validationStatus: 'pending' });
    await insertPromptActivation({ artifactId, principleId });

    const reader = new PromptActivationReader(tempWorkspaceDir);
    const result = await reader.readActivatedPrinciples();

    expect(result.principles).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('artifact_not_validated'))).toBe(true);
  });

  it('malformed activation row with empty artifact_id is rejected', async () => {
    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('', 'idem-empty-artifact', '', 'prompt', 'prompt_activate', '', now);

    const store = new SqliteActivationStateStore(sqliteConn);
    const activations = await store.listPromptActivations();
    const emptyArtifact = activations.find((a) => a.idempotencyKey === 'idem-empty-artifact');
    expect(emptyArtifact).toBeUndefined();
  });

  it('malformed activation row with empty activation_id is rejected', async () => {
    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('', 'idem-empty-actid', 'some-artifact', 'prompt', 'prompt_activate', '', now);

    const store = new SqliteActivationStateStore(sqliteConn);
    const activations = await store.listPromptActivations();
    const emptyActId = activations.find((a) => a.idempotencyKey === 'idem-empty-actid');
    expect(emptyActId).toBeUndefined();
  });

  it('malformed activation row with empty action is rejected', async () => {
    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('act-malformed-action', 'idem-empty-action', 'some-artifact', 'prompt', '', '', now);

    const store = new SqliteActivationStateStore(sqliteConn);
    const activations = await store.listPromptActivations();
    const emptyAction = activations.find((a) => a.idempotencyKey === 'idem-empty-action');
    expect(emptyAction).toBeUndefined();
  });

  it('malformed activation row with empty activated_at is rejected', async () => {
    const db = sqliteConn.getDb();
    db.prepare(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('act-malformed-at', 'idem-empty-at', 'some-artifact', 'prompt', 'prompt_activate', '', '');

    const store = new SqliteActivationStateStore(sqliteConn);
    const activations = await store.listPromptActivations();
    const emptyAt = activations.find((a) => a.idempotencyKey === 'idem-empty-at');
    expect(emptyAt).toBeUndefined();
  });

  it('malformed activation row with invalid channel is rejected', async () => {
    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('act-bad-channel', 'idem-bad-channel', 'some-artifact', 'invalid_channel', 'prompt_activate', '', now);

    const store = new SqliteActivationStateStore(sqliteConn);
    const activations = await store.listPromptActivations();
    const badChannel = activations.find((a) => a.idempotencyKey === 'idem-bad-channel');
    expect(badChannel).toBeUndefined();
  });
});

describe('Runtime V2 prompt activation observability events', () => {
  it('emits injected event with principleIds when valid activations exist', async () => {
    const artifactId = 'art-v2-obs-001';
    const principleId = 'princ-v2-obs-001';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.principleIds).toContain(principleId);
    expect(payload.artifactIds).toContain(artifactId);
    expect(payload.activationIds).toContain(`act_prompt_${principleId}`);
    expect(payload.injectedCount).toBe(1);
    expect(payload.injectedCharCount).toBeGreaterThan(0);
    expect(payload.budget).toBe(RUNTIME_PRINCIPLE_BUDGET);
    expect(payload.sessionId).toBe('test-session-v2');
    expect(payload.workspaceDir).toBe(tempWorkspaceDir);
    expect(payload.skippedWarnings).toEqual([]);
  });

  // PRI-1017: the plugin-local production route (OpenClaw) is the ONLY route
  // whose events carry a trustworthy host window. The Console budget reader
  // consumes exactly these fields, so their presence/shape is a cross-layer
  // contract: 256K host facts must land as budget=8000 + confirmed provenance,
  // and absent facts must land as the honest 4000 fallback with its reason.
  it('records model-aware budget provenance from host model facts (256K → 8000)', async () => {
    const artifactId = 'art-v2-obs-model-001';
    const principleId = 'princ-v2-obs-model-001';
    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelProviderId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    }));

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.budget).toBe(8000);
    expect(payload.budgetCapacitySource).toBe('host_effective_window');
    expect(payload.budgetCapacityStatus).toBe('confirmed');
    expect(payload.budgetContextWindowTokens).toBe(256_000);
    expect(payload.budgetPolicyVersion).toBe('model_aware_v2');
    expect(payload.budgetFallbackReason).toBeUndefined();
  });

  // PRI-1020: the Owner's declared window (promptBudget config section) is
  // tier 0 — it outranks the host's own trusted window on the plugin-local
  // route too, and the event carries operator_declared provenance.
  it('records operator_declared provenance when the workspace declares a window (outranks host facts)', async () => {
    const artifactId = 'art-v2-obs-declared-001';
    const principleId = 'princ-v2-obs-declared-001';
    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const config = getDefaultPdConfig();
    config.promptBudget = { declaredContextWindowTokens: 262144, hosts: { openclaw: 400000 } };
    fs.writeFileSync(path.join(tempWorkspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    // The host ALSO reports a trusted window — the per-host declaration wins.
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelProviderId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    }));

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.budget).toBe(12500); // 400000 tokens → floor(4000 × 400000 / 128000)
    expect(payload.budgetCapacitySource).toBe('operator_declared');
    expect(payload.budgetCapacityStatus).toBe('confirmed');
    expect(payload.budgetContextWindowTokens).toBe(400_000);
    expect(payload.budgetPolicyVersion).toBe('model_aware_v2');
    expect(payload.budgetFallbackReason).toBeUndefined();
  });

  it('records the honest fixed fallback + reason when the host supplies no capacity facts', async () => {
    const artifactId = 'art-v2-obs-fallback-001';
    const principleId = 'princ-v2-obs-fallback-001';
    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.budget).toBe(RUNTIME_PRINCIPLE_BUDGET);
    expect(payload.budgetCapacitySource).toBe('legacy_fallback');
    expect(payload.budgetCapacityStatus).toBe('unknown');
    expect(payload.budgetContextWindowTokens).toBeUndefined();
    expect(payload.budgetPolicyVersion).toBe('model_aware_v2');
    expect(payload.budgetFallbackReason).toBe('host_capacity_absent');
  });

  it('emits skipReason when no validated activations exist', async () => {
    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.injectedCount).toBe(0);
    expect(payload.principleIds).toEqual([]);
    expect(payload.skipReason).toBe('no_validated_activations');
    expect(payload.nextAction).toContain('activations table');
  });

  it('legacy reducer principles never suppress or duplicate the v2 injection', async () => {
    const artifactId = 'art-v2-obs-dup-001';
    const principleId = 'princ-v2-obs-dup-001';
    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });
    legacyTestState.active.push({
      id: principleId,
      text: 'legacy duplicate of the same principle',
      priority: 'P1',
      createdAt: new Date().toISOString(),
    });

    try {
      const { EventLogService } = await import('../../src/core/event-log.js');
      const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
      const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
      spy.mockClear();

      const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
      const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

      expect(spy).toHaveBeenCalled();
      const payload = spy.mock.calls[0][0];
      // The v2 activation is injected exactly once; the reducer's legacy copy is
      // not rendered anywhere, so no cross-block duplication exists.
      expect(payload.principleIds).toEqual([principleId]);
      expect(payload.injectedCount).toBe(1);
      expect(payload.skipReason).toBeUndefined();
      expect(payload.crossBlockDuplicateIds).toBeUndefined();
      expect(payload.legacySelectedCount).toBeUndefined();
      expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
      expect(result?.appendSystemContext ?? '').not.toContain('legacy duplicate of the same principle');
    } finally {
      legacyTestState.active.length = 0;
      legacyTestState.probation.length = 0;
    }
  });

  it('confirm-first marker appears in principleIds evidence', async () => {
    const artifactId = 'art-mvp-acceptance-001';
    const principleId = 'princ-mvp-acceptance-confirm-first';
    const text = 'Before starting any coding task, the agent must first confirm requirements and present a plan for owner approval.';

    insertValidatedPrincipleArtifact({ artifactId, principleId, text });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.principleIds).toContain('princ-mvp-acceptance-confirm-first');
    expect(payload.injectedCount).toBeGreaterThanOrEqual(1);
  });

  it('warnings are preserved in skippedWarnings', async () => {
    const artifactId = 'art-v2-obs-warn-003';
    const principleId = 'princ-v2-obs-warn-003';

    insertValidatedPrincipleArtifact({ artifactId, principleId, validationStatus: 'rejected' });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.skippedWarnings.length).toBeGreaterThan(0);
    expect(payload.skippedWarnings.some((w: string) => w.includes('artifact_not_validated'))).toBe(true);
    expect(payload.injectedCount).toBe(0);
  });

  it('no raw secrets or full giant prompt in telemetry payload', async () => {
    const artifactId = 'art-v2-obs-safe-004';
    const principleId = 'princ-v2-obs-safe-004';
    const secretText = 'sk-proj-SECRET_KEY_12345_should_not_appear';

    insertValidatedPrincipleArtifact({ artifactId, principleId, text: secretText });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    const serialized = JSON.stringify(payload);
    // Should not contain the full principle text — only IDs and char count
    expect(serialized).not.toContain(secretText);
    // Should not contain the full prompt
    expect(serialized).not.toContain('hello world');
  });
});

describe('Runtime V2 owner-approved behavior directives section', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renders owner-approved directives in prependSystemContext when activations exist', async () => {
    const artifactId = 'art-v2-directive-201';
    const principleId = 'princ-v2-directive-201';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.prependSystemContext).toContain('ACTIVE BEHAVIOR DIRECTIVES');
    expect(result?.prependSystemContext).toContain('<directive');
    expect(result?.prependSystemContext).toContain('</directive>');
  });

  it('prependSystemContext contains MANDATORY framing', async () => {
    const artifactId = 'art-v2-directive-202';
    const principleId = 'princ-v2-directive-202';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const ctx = result?.prependSystemContext ?? '';
    expect(ctx).toContain('MANDATORY');
    // P0-G: 中性标题 + authority 标注 (不再无条件声称 Owner-approved)
    expect(ctx).toContain('ACTIVE BEHAVIOR DIRECTIVES');
    expect(ctx).toContain('authority=');
    expect(ctx).toContain('active behavior constraint');
    expect(ctx).toContain('Do not treat this as background context');
  });

  it('prependSystemContext includes safety boundary disclaimer', async () => {
    const artifactId = 'art-v2-directive-203';
    const principleId = 'princ-v2-directive-203';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const ctx = result?.prependSystemContext ?? '';
    expect(ctx).toContain('do not override safety');
    expect(ctx).toContain('do not override safety, security, or core system policy');
  });

  it('directives appear in prependSystemContext (before gateway system prompt)', async () => {
    const artifactId = 'art-v2-directive-204';
    const principleId = 'princ-v2-directive-204';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    // Directives should be in prependSystemContext, NOT in appendSystemContext
    const prependCtx = result?.prependSystemContext ?? '';
    const appendCtx = result?.appendSystemContext ?? '';
    const directiveMarker = 'ACTIVE BEHAVIOR DIRECTIVES';
    expect(prependCtx).toContain(directiveMarker);
    // Should NOT be duplicated in appendSystemContext
    expect(appendCtx).not.toContain(directiveMarker);
  });

  it('directives appear after PD GOVERNANCE CONTEXT in prependSystemContext', async () => {
    const artifactId = 'art-v2-directive-205';
    const principleId = 'princ-v2-directive-205';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const ctx = result?.prependSystemContext ?? '';
    // main (PRI-547) renamed AGENT IDENTITY → PD GOVERNANCE CONTEXT; this
    // branch (P0-G) renamed OWNER-APPROVED → ACTIVE BEHAVIOR DIRECTIVES with
    // authority= annotation. The merged runtime emits BOTH new names — the
    // assertion must match the surviving pair, not main's pre-P0-G wording.
    const identityIdx = ctx.indexOf('PD GOVERNANCE CONTEXT');
    const directiveIdx = ctx.indexOf('ACTIVE BEHAVIOR DIRECTIVES');
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(directiveIdx).toBeGreaterThan(identityIdx);
  });

  it('confirm-first principle rendered as directive with id attribute', async () => {
    const artifactId = 'art-mvp-acceptance-001';
    const principleId = 'princ-mvp-acceptance-confirm-first';
    const text = 'Before starting any coding task, the agent must first confirm requirements and present a plan for owner approval.';

    insertValidatedPrincipleArtifact({ artifactId, principleId, text });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const ctx = result?.prependSystemContext ?? '';
    expect(ctx).toContain('<directive id="princ-mvp-acceptance-confirm-first" source="runtime_v2_activation"');
    expect(ctx).toContain('MANDATORY: Before starting any coding task');
  });

  it('no directive section when no activations exist', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const prependCtx = result?.prependSystemContext ?? '';
    expect(prependCtx).not.toContain('ACTIVE BEHAVIOR DIRECTIVES');
  });

  it('legacy evolution_principles block is no longer rendered', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result).toBeDefined();
    expect(result?.appendSystemContext ?? '').not.toContain('<evolution_principles>');
  });

  it('feature flag disabled path still skips Runtime V2 directives with structured reason', async () => {
    const artifactId = 'art-v2-flag-206';
    const principleId = 'princ-v2-flag-206';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const pdDir = path.join(tempWorkspaceDir, '.pd');
    fs.writeFileSync(
      path.join(pdDir, 'feature-flags.yaml'),
      'prompt:\n  enabled: false\n',
      'utf8',
    );

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result).toBeDefined();
  });
});

describe('Runtime V2 authority derivation + artifact recycling (Safety Net v1.2, PRI-828)', () => {
  function insertApproval(overrides: {
    artifactId: string;
    channel?: string;
    decidedBy?: string;
    status?: string;
  }) {
    const {
      artifactId,
      channel = 'prompt',
      decidedBy = 'owner-safety-net-test',
      status = 'approved',
    } = overrides;
    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `apr_${channel}_${artifactId}`,
      artifactId,
      channel,
      'high',
      status,
      0.9,
      now,
      status === 'approved' ? now : null,
      status === 'approved' ? decidedBy : null,
    );
  }

  it('approved approvals row renders authority="owner" at the prompt boundary', async () => {
    const artifactId = 'art-v2-auth-owner-301';
    const principleId = 'princ-v2-auth-owner-301';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });
    insertApproval({ artifactId, decidedBy: 'owner-safety-net-test' });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    // The directive TAG carries the derived authority; the boilerplate
    // explanation line mentions both values, so assert the tag form
    // (`authority="...">` only appears on directive tags).
    expect(result?.prependSystemContext).toContain(`<directive id="${principleId}" source="runtime_v2_activation" authority="owner">`);
    expect(result?.prependSystemContext).not.toContain('authority="system_policy">');
  });

  it('low-risk auto-activation without an approvals row renders authority="system_policy" and never claims owner (I3)', async () => {
    const artifactId = 'art-v2-auth-syspolicy-302';
    const principleId = 'princ-v2-auth-syspolicy-302';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });
    // deliberately NO approvals row — prompt channel low-risk auto-activation

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    // Directive tag must carry system_policy and must NEVER carry owner —
    // a low-risk auto-activation must not be represented as Owner-approved.
    expect(result?.prependSystemContext).toContain(`<directive id="${principleId}" source="runtime_v2_activation" authority="system_policy">`);
    expect(result?.prependSystemContext).not.toContain('authority="owner">');
  });

  it('artifact slot recycled by production upsert leaves old activation dangling — new content is NOT injected under old authorization (C5)', async () => {
    const artifactIdOld = 'art-v2-recycle-303-old';
    const artifactIdNew = 'art-v2-recycle-303-new';
    const principleId = 'princ-v2-recycle-303';
    const taskSlot = `task_${principleId}`;
    const newText = 'UNIQUE_RUNTIME_RECYCLED_CONTENT_5w8q1';

    const artifactStore = new SqlitePIArtifactStore(sqliteConn);
    const now = new Date().toISOString();
    await artifactStore.upsertArtifact({
      artifactId: artifactIdOld,
      artifactKind: 'principle',
      sourceTaskId: taskSlot,
      sourcePrincipleId: principleId,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({ principleId, text: TEST_PRINCIPLE_TEXT }),
      createdAt: now,
      updatedAt: now,
    });
    await insertPromptActivation({ artifactId: artifactIdOld, principleId });
    insertApproval({ artifactId: artifactIdOld });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const before = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());
    expect(before?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);

    expect(before?.prependSystemContext).toContain(`<directive id="${principleId}" source="runtime_v2_activation" authority="owner">`);

    await artifactStore.upsertArtifact({
      artifactId: artifactIdNew,
      artifactKind: 'principle',
      sourceTaskId: taskSlot,
      sourcePrincipleId: principleId,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({ principleId, text: newText }),
      createdAt: now,
      updatedAt: now,
    });
    expect(await artifactStore.getArtifactById(artifactIdOld)).toBeNull();
    expect(await artifactStore.listBySourceTaskId(taskSlot)).toEqual([
      expect.objectContaining({ artifactId: artifactIdNew, contentJson: JSON.stringify({ principleId, text: newText }) }),
    ]);
    const activationStore = new SqliteActivationStateStore(sqliteConn);
    expect(await activationStore.listAllActivations()).toEqual([
      expect.objectContaining({ artifactId: artifactIdOld, deactivatedAt: null }),
    ]);

    // 3) The old activation now dangles: the replaced content must NOT be
    //    injected under the old activation's authorization, and the old text
    //    must be gone too. Fail-safe skip + observable warning, no crash.
    const infoSpy = vi.fn();
    const warnSpy = vi.fn();
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      trigger: 'user',
      sessionId: 'test-session-v2',
      api: {
        logger: { info: infoSpy, warn: warnSpy, error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];

    const after = await handleBeforePromptBuild(makeMinimalEvent(), ctx);
    expect(after).toBeDefined();
    expect(after?.prependSystemContext).not.toContain(newText);
    expect(after?.prependSystemContext).not.toContain(TEST_PRINCIPLE_TEXT);
    expect(after?.prependSystemContext).not.toContain(`<directive id="${principleId}"`);
    expect(after?.appendSystemContext).not.toContain(newText);
    expect(after?.appendSystemContext).not.toContain(TEST_PRINCIPLE_TEXT);
    const infoCalls = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasDanglingWarning = [...infoCalls, ...warnCalls].some(
      (message) => message.includes('artifact_not_found') && message.includes(artifactIdOld),
    );
    expect(hasDanglingWarning).toBe(true);
  });
});

describe('Runtime V2 prompt injection — PRI-904 fair rotation (plugin-local production route)', () => {
  // Audited live entry lengths (see docs/audit/pri-904-activation-injection-root-cause.md §5):
  // under the old FIFO prefix policy these produce selected=9 / 1893 chars / truncated.
  const LIVE_ENTRY_LENGTHS = [208, 150, 223, 226, 143, 147, 290, 216, 249, 210, 256, 186, 219, 202, 286, 259];

  async function seedPri904Fixture(): Promise<void> {
    for (let i = 0; i < LIVE_ENTRY_LENGTHS.length; i++) {
      const principleId = `PRI904-H-${String(i + 1).padStart(2, '0')}`;
      const prefix = `- [${principleId}] `;
      const text = 'F'.repeat(LIVE_ENTRY_LENGTHS[i]! - prefix.length);
      insertValidatedPrincipleArtifact({ artifactId: `art-${principleId}`, principleId, text });
      await insertPromptActivation({ artifactId: `art-${principleId}`, principleId });
    }
  }

  function fixturePrinciples() {
    return LIVE_ENTRY_LENGTHS.map((len, i) => {
      const principleId = `PRI904-H-${String(i + 1).padStart(2, '0')}`;
      const prefix = `- [${principleId}] `;
      return {
        principleId,
        text: 'F'.repeat(len - prefix.length),
        artifactId: `art-${principleId}`,
        activationId: `act_prompt_${principleId}`,
      };
    });
  }

  async function captureInjectionPayload(ctxOverrides: { runId?: string }) {
    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx(ctxOverrides));
    expect(spy).toHaveBeenCalledTimes(1);
    return { payload: spy.mock.calls[0]![0] as Record<string, unknown>, result };
  }

  /**
   * Real production round fact: the same trajectory.db table, path and index
   * the production writer (TrajectoryDatabase.recordUserTurn) uses. Rows are
   * inserted exactly as a recorded user turn, so the hook reads a real
   * advancing ordinal — not a synthetic key search.
   */
  function recordUserTurnRow(sessionId: string, turnIndex: number): void {
    const stateDir = path.join(tempWorkspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'trajectory.db');
    if (!fs.existsSync(dbPath)) {
      const bootstrap = new Database(dbPath);
      bootstrap.exec(`
        CREATE TABLE IF NOT EXISTS user_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          raw_text TEXT,
          correction_detected INTEGER DEFAULT 0,
          created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_turns_session_id ON user_turns(session_id);
      `);
      bootstrap.close();
    }
    const db = new Database(dbPath);
    try {
      db.prepare(
        'INSERT INTO user_turns (session_id, turn_index, raw_text, correction_detected, created_at) VALUES (?, ?, ?, 0, ?)',
      ).run(sessionId, turnIndex, `user message ${turnIndex}`, new Date().toISOString());
    } finally {
      db.close();
    }
  }

  it('T-PROD-01: 16 real user turns give bounded coverage — every fixture principle reaches the prompt', async () => {
    await seedPri904Fixture();
    const { EventLogService } = await import('../../src/core/event-log.js');
    const spy = (EventLogService.get as ReturnType<typeof vi.fn>)().recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    const sessionId = 'pri904-prod-session';
    const union = new Set<string>();
    const starts: number[] = [];
    const ordinals: number[] = [];

    for (let round = 0; round < 16; round++) {
      // The turn this build is about to record advances the round fact.
      recordUserTurnRow(sessionId, round + 1);
      spy.mockClear();
      await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({ sessionId }));
      const payload = spy.mock.calls[0]![0] as {
        principleIds: string[]; selectionPolicy: string; rotationStartIndex: number;
        selectionRoundOrdinal: number; selectionRoundSource: string; injectedCharCount: number;
      };
      expect(payload.selectionPolicy).toBe('fair_rotation_v1');
      expect(payload.selectionRoundSource).toBe('session_user_turn_ordinal');
      expect(payload.injectedCharCount).toBeLessThanOrEqual(RUNTIME_PRINCIPLE_BUDGET);
      starts.push(payload.rotationStartIndex);
      ordinals.push(payload.selectionRoundOrdinal);
      for (const id of payload.principleIds) union.add(id);
    }

    // Bounded fairness: 16 consecutive rounds visit all 16 ring positions.
    expect(new Set(starts).size).toBe(16);
    expect(starts.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    // Deterministic advancement: the round fact advances by exactly one.
    expect(ordinals[1]! - ordinals[0]!).toBe(1);
    expect(union.size).toBe(16);
  });

  it('T-PROD-02: the PRI-904 target and the oldest principle both get a real opportunity window', async () => {
    await seedPri904Fixture();
    const { EventLogService } = await import('../../src/core/event-log.js');
    const spy = (EventLogService.get as ReturnType<typeof vi.fn>)().recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const sessionId = 'pri904-target-session';
    const target = 'PRI904-H-14';
    const oldest = 'PRI904-H-01';
    let targetRounds = 0;
    let oldestRounds = 0;
    for (let round = 0; round < 16; round++) {
      recordUserTurnRow(sessionId, round + 1);
      spy.mockClear();
      await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({ sessionId }));
      const ids = (spy.mock.calls[0]![0] as { principleIds: string[] }).principleIds;
      if (ids.includes(target)) targetRounds++;
      if (ids.includes(oldest)) oldestRounds++;
    }
    expect(targetRounds).toBeGreaterThanOrEqual(1);
    expect(oldestRounds).toBeGreaterThanOrEqual(1);
  });

  it('no session id: degrades to legacy_fifo_prefix_v1 and packs entries under the same budget authority', async () => {
    await seedPri904Fixture();
    const { payload } = await captureInjectionPayload({ sessionId: undefined as unknown as string });

    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.rotationStartIndex).toBeUndefined();
    expect(payload.selectionRoundOrdinal).toBeUndefined();
    // Expected values derive from the pure selector at the SAME budget the
    // production path resolved — no second hard-coded capacity number.
    const expected = trimToBudget(fixturePrinciples(), RUNTIME_PRINCIPLE_BUDGET, escapeXml);
    expect(payload.injectedCount).toBe(expected.injectedIds.size);
    expect(payload.injectedCharCount).toBe(expected.lines.join('\n').length);
    expect(payload.v2Truncated).toBe(expected.truncated);
    expect(payload.principleIds).toEqual(Array.from(expected.injectedIds));
    expect(payload.droppedActivationIds ?? []).toEqual(expected.droppedActivationIds);
  });

  it('unreadable trajectory db: degrades observably to legacy instead of failing the prompt build', async () => {
    await seedPri904Fixture();
    // No trajectory.db at all → the seam throws → legacy policy, build still succeeds.
    const { payload, result } = await captureInjectionPayload({ sessionId: 'pri904-no-db-session' });
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.injectedCount).toBeGreaterThan(0);
    expect(result?.prependSystemContext).toContain('ACTIVE BEHAVIOR DIRECTIVES');
  });

  it('the fair payload matches the pure selector exactly for the same round ordinal', async () => {
    await seedPri904Fixture();
    const { EventLogService } = await import('../../src/core/event-log.js');
    const spy = (EventLogService.get as ReturnType<typeof vi.fn>)().recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const sessionId = 'pri904-selector-parity';
    recordUserTurnRow(sessionId, 1);
    recordUserTurnRow(sessionId, 2);
    recordUserTurnRow(sessionId, 3);
    recordUserTurnRow(sessionId, 4);
    recordUserTurnRow(sessionId, 5);
    recordUserTurnRow(sessionId, 6);
    recordUserTurnRow(sessionId, 7); // next ordinal = 8
    spy.mockClear();
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({ sessionId }));
    const payload = spy.mock.calls[0]![0] as { selectionRoundOrdinal: number };

    const expected = trimToBudget(fixturePrinciples(), RUNTIME_PRINCIPLE_BUDGET, escapeXml, 8);
    expect(payload.selectionRoundOrdinal).toBe(8);
    expect(expected.rotationStartIndex).toBe(8 % 16);
  });
});
