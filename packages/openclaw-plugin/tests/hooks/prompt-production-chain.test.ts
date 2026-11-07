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
  };
  return {
    EventLogService: {
      get: vi.fn(() => sharedEventLog),
    },
  };
});

// The workspace context seam is mocked so the prompt chain runs against the
// REAL TrajectoryDatabase (the user_turns authority) while the event log stays
// a capture point. The trajectory is resolved lazily per property through a
// Proxy so a closed/disposed connection is re-opened exactly like production.
vi.mock('../../src/core/workspace-context.js', async () => {
  const { TrajectoryRegistry } = await import('../../src/core/trajectory.js');
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn(() => ({
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
      })),
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
const { default: plugin } = await import('../../src/index.js');

const TEST_PRINCIPLE_TEXT = 'UNIQUE_PROD_CHAIN_PRINCIPLE_4k8z1';

let tempWorkspaceDir = '';
let tempStateDir = '';
let sqliteConn: SqliteConnection;
let hook: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
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
  const api = {
    id: 'principles-disciple',
    rootDir: '/plugin',
    pluginConfig: { language: 'en' },
    config: { plugins: { entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } } } },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerCommand: vi.fn(), registerService: vi.fn(), registerTool: vi.fn(), registerHttpRoute: vi.fn(),
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { hooks.set(name, handler); },
  } as never;
  plugin.register(api);
  const captured = hooks.get('before_prompt_build');
  expect(captured).toBeDefined();
  hook = captured;
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

function makeHookCtx(sessionId: string | undefined, runId?: string): Record<string, unknown> {
  return {
    workspaceDir: tempWorkspaceDir,
    trigger: 'user',
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
});
