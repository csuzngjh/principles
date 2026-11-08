import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteConnection, SqliteActivationStateStore, type ActivationStatusRecord } from '@principles/core/runtime';
import { TrajectoryRegistry } from '../../src/core/trajectory.js';

/**
 * PRI-1137 final review P2: the ONE true production-chain integration test.
 *
 * Everything before this file proved the two production steps in isolation
 * (`prepareOpenClawPromptRound` helper → `buildActivePrinciplePromptContext`
 * helper → `handleBeforePromptBuild` helper). This suite drives the REAL
 * registration surface instead:
 *
 *   plugin.register(api)
 *   → captured `before_prompt_build` hook (the production entry)
 *   → createOpenClawHostRuntime adapter (native payload tokens)
 *   → shared Host Runtime `beforePromptBuild`
 *   → roundKeyProvider = prepareOpenClawPromptRound
 *     (SignalCollectorHost.detectSync — the ONE user_turns write)
 *   → nextSessionTurnOrdinal over the REAL trajectory.db
 *   → buildActivePrinciplePromptContext (packSharedDirectives selection)
 *   → post-selection handleBeforePromptBuild (WeakSet dedup, no re-collection)
 *   → runtime_v2_prompt_activations_injected event
 *
 * Mock policy: only capture points (event log) and environmentally dangerous
 * boot services are mocked. The signal collector, the trajectory writer, the
 * ordinal seam, the shared selector and the packer all run for real against a
 * real temporary workspace.
 */

const trajectoryControl = vi.hoisted(() => ({
  /** 'real' = real TrajectoryDatabase; 'fail_write' = recordUserTurn throws. */
  mode: 'real' as 'real' | 'fail_write',
}));

vi.mock('../../src/core/event-log.js', () => {
  // ONE shared capture instance — every EventLogService.get() returns the same
  // object so tests can assert on exactly what the production chain emitted.
  const sharedEventLog = {
    recordHeartbeatDiagnosis: vi.fn(),
    recordRuntimeActivationsInjected: vi.fn(),
    recordAdaptiveDelivery: vi.fn(),
    recordHookExecution: vi.fn(),
    recordTrajectoryObservabilityFailure: vi.fn(),
    // P1-4: the after-tool enrichment path emits receipt/tool events too.
    recordToolCall: vi.fn(),
  };
  return {
    EventLogService: {
      get: vi.fn(() => sharedEventLog),
    },
  };
});

vi.mock('../../src/hooks/pain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hooks/pain.js')>();
  return {
    ...actual,
    emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
  };
});

// The workspace context seam is mocked so the prompt chain runs against the
// REAL TrajectoryDatabase (the user_turns authority) while the event log stays
// a capture point. The trajectory is resolved lazily per property through a
// Proxy so a closed/disposed connection is re-opened exactly like production.
vi.mock('../../src/core/workspace-context.js', async () => {
  const { TrajectoryRegistry } = await import('../../src/core/trajectory.js');
  const buildContext = () => ({
    workspaceDir: tempWorkspaceDir,
    stateDir: tempStateDir,
    resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
    config: { get: vi.fn(() => undefined) },
    eventLog: EventLogService.get(tempWorkspaceDir),
    evolutionReducer: {
      getActivePrinciples: vi.fn(() => []),
      getProbationPrinciples: vi.fn(() => []),
    },
    trajectory: new Proxy({}, {
      get: (_target, prop) => {
        if (trajectoryControl.mode === 'fail_write' && prop === 'recordUserTurn') {
          return () => { throw new Error('user_turns write blocked by test'); };
        }
        const db = TrajectoryRegistry.get(tempWorkspaceDir);
        const value = Reflect.get(db as object, prop);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    }),
  });
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn(() => buildContext()),
      // P1-4: the after-tool enrichment provider resolves its context through
      // the explicit-workspace entry — same fixture workspace.
      fromHookContextExplicit: vi.fn(() => buildContext()),
    },
  };
});

vi.mock('../../src/core/diagnostician-task-store.js', () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue({ currentGfi: 20 }),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
  // P1-4: the after-tool enrichment/receipt path also touches these —
  // best-effort no-ops keep the evidence kernel on its real write path.
  setInjectedPrincipleIds: vi.fn(),
  trackSessionControlActivity: vi.fn(),
}));

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: {
    getExtensionRoot: vi.fn().mockReturnValue('/fake/extension'),
    setExtensionRoot: vi.fn(),
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

// Boot services (workspace onboarding side-effects) — not part of the prompt
// chain under test; mocked so registration cannot reach the real machine.
vi.mock('../../src/core/migration.js', () => ({ migrateDirectoryStructure: vi.fn() }));
vi.mock('../../src/core/init.js', () => ({ ensureWorkspaceTemplates: vi.fn() }));
vi.mock('../../src/core/system-logger.js', () => ({ SystemLogger: { log: vi.fn() } }));
vi.mock('../../src/service/correction-observer-service.js', () => ({
  CorrectionObserverService: { start: vi.fn() },
}));
vi.mock('../../src/service/internalization-auto-consumer-service.js', () => ({
  InternalizationAutoConsumerService: { start: vi.fn() },
  persistOpenClawToolDeclaration: vi.fn(),
}));
vi.mock('../../src/core/product-telemetry-trigger.js', () => ({
  scheduleTelemetryExportForWorkspace: vi.fn(),
}));

const { EventLogService } = await import('../../src/core/event-log.js');
const { emitPainDetectedEvent } = await import('../../src/hooks/pain.js');
const { default: plugin } = await import('../../src/index.js');

const TEST_PRINCIPLE_TEXT = 'UNIQUE_PROD_CHAIN_PRINCIPLE_4k8z1';

let tempWorkspaceDir = '';
let tempStateDir = '';
let sqliteConn: SqliteConnection;
let hook: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
let afterToolCallHook: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
let fakeLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;

beforeEach(async () => {
  vi.clearAllMocks();
  trajectoryControl.mode = 'real';
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
  const { resetAdaptiveConfigIdentityStateForTest } = await import('../../src/core/adaptive-config-identity.js');
  resetAdaptiveConfigIdentityStateForTest();

  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prod-chain-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
  fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();

  // Priority-1 workspace pin (the production resolver's explicit source).
  process.env.PD_WORKSPACE_DIR = tempWorkspaceDir;

  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  fakeLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = {
    id: 'principles-disciple',
    rootDir: '/plugin',
    pluginConfig: { language: 'en' },
    config: { plugins: { entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } } } },
    logger: fakeLogger,
    registerCommand: vi.fn(), registerService: vi.fn(), registerTool: vi.fn(), registerHttpRoute: vi.fn(),
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { hooks.set(name, handler); },
  } as never;
  plugin.register(api);
  const captured = hooks.get('before_prompt_build');
  expect(captured).toBeDefined();
  hook = captured;
  const capturedAfter = hooks.get('after_tool_call');
  expect(capturedAfter).toBeDefined();
  afterToolCallHook = capturedAfter as (event: unknown, ctx: unknown) => Promise<void>;
});

afterEach(() => {
  if (priorPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
  else process.env.PD_WORKSPACE_DIR = priorPdWorkspaceDir;
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { TrajectoryRegistry.dispose(tempWorkspaceDir); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* best-effort */ }
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = '';
});

async function injectionSpy() {
  const mock = (EventLogService.get as ReturnType<typeof vi.fn>)();
  return mock.recordRuntimeActivationsInjected as ReturnType<typeof vi.fn>;
}

async function seedOnePrinciple(text = TEST_PRINCIPLE_TEXT): Promise<string> {
  const principleId = 'PRODCHAIN-01';
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('art-prodchain-01', 'principle', 'task-1', principleId, null, '[]', 'validated', JSON.stringify({ principleId, text }), now, now);
  await new SqliteActivationStateStore(sqliteConn).recordActivation({
    activationId: 'act-prodchain-01',
    idempotencyKey: 'art-prodchain-01::prompt',
    artifactId: 'art-prodchain-01',
    channel: 'prompt' as ActivationStatusRecord['channel'],
    action: 'prompt_activate',
    targetRef: `ledger://${principleId}`,
    activatedAt: now,
    deactivatedAt: null,
  });
  return text;
}

function makeEvent(sessionId: string | undefined, runId?: string): Record<string, unknown> {
  return {
    prompt: 'hello production chain',
    messages: [],
    trigger: 'user',
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}

function makeHookCtx(sessionId: string | undefined, runId?: string, trigger: string = 'user'): Record<string, unknown> {
  return {
    workspaceDir: tempWorkspaceDir,
    trigger,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    agentId: 'agent-1',
  };
}

function userTurnRows(sessionId: string): { count: number; maxTurnIndex: number } {
  const dbPath = path.join(tempWorkspaceDir, '.state', 'trajectory.db');
  expect(fs.existsSync(dbPath)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count, MAX(turn_index) AS max_turn FROM user_turns WHERE session_id = ?').get(sessionId) as { count: number; max_turn: number | null };
    return { count: row.count, maxTurnIndex: row.max_turn ?? 0 };
  } finally {
    db.close();
  }
}

describe('PRI-1137 P2: the real registration → shared-runtime prompt production chain', () => {
  it('one invocation: ONE user_turns write, round from the persisted ordinal, event matches the actual selection', async () => {
    const text = await seedOnePrinciple();
    const spy = await injectionSpy();
    const sessionId = 'prod-chain-session-1';

    const result = await hook?.(makeEvent(sessionId, 'run-1'), makeHookCtx(sessionId, 'run-1')) as
      { prependSystemContext?: string; appendSystemContext?: string } | undefined;

    // The REAL selection reached the payload (shared directive render).
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).toContain('ACTIVE BEHAVIOR DIRECTIVES');
    expect(JSON.stringify(result)).toContain(text);

    // 1. Exactly ONE effective user_turns write for this invocation.
    const rows = userTurnRows(sessionId);
    expect(rows.count).toBe(1);

    // 2. The round comes from the REAL persisted ordinal (max(turn_index)+1).
    const spyCalls = spy.mock.calls as [{ selectionRoundOrdinal?: number; selectionPolicy?: string; selectionRoundSource?: string; principleIds?: string[]; hostKind?: string }[]];
    expect(spyCalls).toHaveLength(1);
    const payload = spyCalls[0]![0]!;
    expect(payload.hostKind).toBe('openclaw');
    expect(payload.selectionRoundOrdinal).toBe(rows.maxTurnIndex + 1);

    // 3./4. Policy and round agree with the actual injection.
    expect(payload.selectionPolicy).toBe('fair_rotation_v1');
    expect(payload.selectionRoundSource).toBe('session_user_turn_ordinal');
    expect(payload.principleIds).toContain('PRODCHAIN-01');
  });

  it('repeated callbacks for the same run do not re-collect (one write, one round)', async () => {
    await seedOnePrinciple();
    await injectionSpy();
    const sessionId = 'prod-chain-session-dedup';

    await hook?.(makeEvent(sessionId, 'run-dedup'), makeHookCtx(sessionId, 'run-dedup'));
    await hook?.(makeEvent(sessionId, 'run-dedup'), makeHookCtx(sessionId, 'run-dedup'));

    // The run claim deduplicates: still exactly ONE user_turns row.
    expect(userTurnRows(sessionId).count).toBe(1);
  });

  it('a failed user_turns write still degrades to FIFO (no fabricated round key, injection continues)', async () => {
    const text = await seedOnePrinciple();
    const spy = await injectionSpy();
    const sessionId = 'prod-chain-session-fail';
    trajectoryControl.mode = 'fail_write';

    const result = await hook?.(makeEvent(sessionId, 'run-fail'), makeHookCtx(sessionId, 'run-fail')) as
      { prependSystemContext?: string } | undefined;

    expect(userTurnRows(sessionId).count).toBe(0);
    const payload = (spy.mock.calls as [{ selectionPolicy?: string; selectionRoundOrdinal?: number }[]])[0]![0]!;
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.selectionRoundOrdinal).toBeUndefined();
    // FIFO degradation still injects — the prompt build never fails on the round authority.
    expect(result?.prependSystemContext).toContain(text);
  });

  it('same-run retry after a user_turn write failure persists once and routes STRONG only once', async () => {
    await seedOnePrinciple();
    const sessionId = 'prod-chain-session-signal-retry';
    trajectoryControl.mode = 'fail_write';

    const firstEvent = { ...makeEvent(sessionId, 'run-signal-retry'), prompt: '这是错的' };
    const first = await hook?.(firstEvent, makeHookCtx(sessionId, 'run-signal-retry')) as
      { prependSystemContext?: string } | undefined;
    expect(first?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    expect(userTurnRows(sessionId).count).toBe(0);

    // The same host run retries its failed durable write. Stage-1 classification
    // and STRONG routing are reused; only user_turn persistence is retried.
    trajectoryControl.mode = 'real';
    const retryEvent = { ...makeEvent(sessionId, 'run-signal-retry'), prompt: '这是错的' };
    const retry = await hook?.(retryEvent, makeHookCtx(sessionId, 'run-signal-retry')) as
      { prependSystemContext?: string } | undefined;
    expect(retry?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    expect(userTurnRows(sessionId).count).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('missing sessionId: no round key is fabricated and nothing is written', async () => {
    await seedOnePrinciple();
    const spy = await injectionSpy();

    const result = await hook?.(makeEvent(undefined), makeHookCtx(undefined)) as
      { prependSystemContext?: string } | undefined;

    const payload = (spy.mock.calls as [{ selectionPolicy?: string; selectionRoundOrdinal?: number }[]])[0]![0]!;
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.selectionRoundOrdinal).toBeUndefined();
    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    // No trajectory.db rows were fabricated for a session that does not exist.
    const dbPath = path.join(tempWorkspaceDir, '.state', 'trajectory.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare('SELECT COUNT(*) AS count FROM user_turns').get() as { count: number };
        expect(row.count).toBe(0);
      } finally {
        db.close();
      }
    }
  });

  // ── PRI-1137 final review P1-3: write-free invocations must not claim a
  // fair-rotation round they never recorded; run retries must replay THEIR OWN
  // ordinal even when a concurrent run advanced the global counter. ──────────

  it('P1-3: heartbeat records no user turn → FIFO selection, no fabricated round', async () => {
    await seedOnePrinciple();
    const spy = await injectionSpy();
    const sessionId = 'prod-chain-session-heartbeat';

    // A PRIOR real user turn exists — the old code would have read its ordinal
    // and claimed fair rotation on an already-consumed round.
    const prior = hook === undefined ? undefined : await hook?.(
      { prompt: 'real user turn', messages: [], trigger: 'user', sessionId } as never,
      makeHookCtx(sessionId, 'run-prior'),
    );
    expect(prior).toBeDefined();
    spy.mockClear();

    await hook?.(
      { prompt: 'heartbeat probe', messages: [], trigger: 'heartbeat', sessionId } as never,
      makeHookCtx(sessionId, 'run-hb', 'heartbeat'),
    );

    expect(userTurnRows(sessionId).count).toBe(1);
    const payload = (spy.mock.calls as [{ selectionPolicy?: string; selectionRoundOrdinal?: number }[]])[0]![0]!;
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.selectionRoundOrdinal).toBeUndefined();
  });

  it('P1-3: an empty user message yields no round key (FIFO), never a fabricated round 1', async () => {
    await seedOnePrinciple();
    const spy = await injectionSpy();
    const sessionId = 'prod-chain-session-empty';

    await hook?.({ prompt: '', messages: [], trigger: 'user', sessionId } as never, makeHookCtx(sessionId, 'run-empty'));

    expect(userTurnRows(sessionId).count).toBe(0);
    const payload = (spy.mock.calls as [{ selectionPolicy?: string; selectionRoundOrdinal?: number }[]])[0]![0]!;
    // nextSessionTurnOrdinal on an empty session returns 1 — the fix must not
    // surface that as a real fair-rotation round.
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.selectionRoundOrdinal).toBeUndefined();
  });

  it('P1-3: a user-message resolution failure degrades to FIFO instead of failing the build', async () => {
    await seedOnePrinciple();
    const spy = await injectionSpy();
    const sessionId = 'prod-chain-session-throw';
    const throwingEvent = {
      messages: [],
      trigger: 'user',
      sessionId,
      get prompt(): string {
        throw new Error('malformed host payload');
      },
    };

    const result = await hook?.(throwingEvent as never, makeHookCtx(sessionId, 'run-throw')) as
      { prependSystemContext?: string } | undefined;

    // The whole hook still delivers the shared injection — fail-open like the
    // other observability side channels.
    expect(result?.prependSystemContext).toContain(TEST_PRINCIPLE_TEXT);
    const payload = (spy.mock.calls as [{ selectionPolicy?: string; selectionRoundOrdinal?: number }[]])[0]![0]!;
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.selectionRoundOrdinal).toBeUndefined();
  });

  it('P1-3: a retried run replays ITS OWN ordinal even after a concurrent run advanced the counter', async () => {
    await seedOnePrinciple();
    const spy = await injectionSpy();
    const sessionId = 'prod-chain-session-interleave';

    const ordinals: number[] = [];
    const capture = async (runId: string, prompt: string): Promise<void> => {
      spy.mockClear();
      await hook?.({ prompt, messages: [], trigger: 'user', sessionId } as never, makeHookCtx(sessionId, runId));
      const payload = (spy.mock.calls as [{ selectionPolicy?: string; selectionRoundOrdinal?: number }[]])[0]![0]!;
      expect(payload.selectionPolicy).toBe('fair_rotation_v1');
      ordinals.push(payload.selectionRoundOrdinal as number);
    };

    await capture('run-a', 'first user turn');
    await capture('run-b', 'second user turn');
    // Retry of run A: the global counter now reads 3 because run B wrote a
    // turn — run A must still select on the round ITS OWN write produced.
    await capture('run-a', 'first user turn');

    expect(userTurnRows(sessionId).count).toBe(2);
    expect(ordinals).toEqual([2, 3, 2]);
  });

  // ── PRI-1137 final review P1-4: the after_tool_call production chain —
  // toolArgs fidelity (params_json) and honest degradation observability. ────

  /**
   * Bootstrap the REAL production trajectory.db (canonical schema via
   * TrajectoryRegistry's own migrations) by running one prompt invocation —
   * the same store the shared after-tool kernel writes into. No hand-rolled
   * schema: a subset schema once made the production insert fail while the
   * test still passed (see the PRI-1137 round-key regression note).
   */
  async function bootstrapTrajectoryViaPrompt(): Promise<void> {
    const sessionId = 'bootstrap-session';
    await hook?.({ prompt: 'bootstrap turn', messages: [], trigger: 'user', sessionId } as never, makeHookCtx(sessionId, 'run-bootstrap'));
    expect(fs.existsSync(path.join(tempWorkspaceDir, '.state', 'trajectory.db'))).toBe(true);
  }

  function toolCallsRows(): { paramsJson: string; toolName: string }[] {
    const dbPath = path.join(tempWorkspaceDir, '.state', 'trajectory.db');
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT params_json, tool_name FROM tool_calls').all() as unknown as { params_json: string; tool_name: string }[];
      return rows.map((row) => ({ paramsJson: row.params_json, toolName: row.tool_name }));
    } finally {
      db.close();
    }
  }

  function hookExecutionRecords(): { hook?: string; error?: string }[] {
    const mock = (EventLogService.get as ReturnType<typeof vi.fn>)();
    return (mock.recordHookExecution as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as { hook?: string; error?: string });
  }

  async function invokeAfterToolCall(event: Record<string, unknown>): Promise<void> {
    expect(afterToolCallHook).toBeDefined();
    await afterToolCallHook?.(event, {
      workspaceDir: tempWorkspaceDir,
      sessionId: 'after-chain-session',
      agentId: 'agent-1',
      trigger: 'user',
    });
  }

  it('P1-4: toolArgs reach the shared evidence kernel — params_json keeps the real arguments', async () => {
    await bootstrapTrajectoryViaPrompt();
    await invokeAfterToolCall({
      toolName: 'write_file',
      toolArgs: { path: 'src/important.ts', content: 'x'.repeat(40) },
      result: 'ok',
      durationMs: 12,
    });

    const rows = toolCallsRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((entry) => entry.toolName === 'write_file');
    expect(row).toBeDefined();
    // The pre-fix adapter read `event.params` (absent on after events) and
    // persisted '{}' — the real arguments must now survive (P1-4).
    expect(row!.paramsJson).toContain('src/important.ts');
    // Healthy path records a clean hook execution.
    const afterRecords = hookExecutionRecords().filter((record) => record.hook === 'after_tool_call');
    expect(afterRecords).toHaveLength(1);
    expect(afterRecords[0]!.error).toBeUndefined();
  });

  it('P1-4: a missing trajectory DB is OBSERVABLE — warned, recorded as degraded, never a silent success', async () => {
    // No .state/trajectory.db in this fresh workspace.
    await invokeAfterToolCall({ toolName: 'write_file', toolArgs: { path: 'x' }, result: 'ok', durationMs: 5 });

    expect(toolCallsRows()).toEqual([]);
    const warnCalls = (fakeLogger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.includes('after_tool_call'));
    expect(warnCalls.join('\n')).toContain('trajectory');
    const afterRecords = hookExecutionRecords().filter((record) => record.hook === 'after_tool_call');
    expect(afterRecords).toHaveLength(1);
    expect(afterRecords[0]!.error).toContain('evidence degraded');
  });

  it('P1-4: an event without toolArgs still records evidence honestly (no crash, empty args)', async () => {
    await bootstrapTrajectoryViaPrompt();
    await invokeAfterToolCall({ toolName: 'bash', result: 'done', durationMs: 3 });

    const rows = toolCallsRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const afterRecords = hookExecutionRecords().filter((record) => record.hook === 'after_tool_call');
    expect(afterRecords).toHaveLength(1);
    expect(afterRecords[0]!.error).toBeUndefined();
  });
});
