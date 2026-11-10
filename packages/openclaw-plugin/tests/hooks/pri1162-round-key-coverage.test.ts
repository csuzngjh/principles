import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteConnection, SqliteActivationStateStore, type ActivationStatusRecord } from '@principles/core/runtime';
import { TrajectoryRegistry } from '../../src/core/trajectory.js';

/**
 * PRI-1162 (Owner-approved card v0.1 §4.1): gap tests for the round-key chain
 * that PRI-1137 already wired. Production code is NOT changed; these tests
 * pin the coverage behaviors the card froze so a future regression of the
 * WIRING (provider dropped, pre-selection half reordered, claim lost) fails
 * loudly:
 *
 *   T1 consecutive user rounds ADVANCE the rotation through the real chain
 *      (ordinals increase, start index rotates, selection set leaves the
 *      FIFO prefix — the oldest principle is absent on start>0 rounds);
 *   T2 a same-run retry is byte-stable (same ordinal, same selection, ONE write);
 *   T3 a non-user trigger (subagent) records no round and selects FIFO
 *      (heartbeat/empty/failed-write/missing-session siblings already live in
 *      prompt-production-chain.test.ts — referenced, not duplicated);
 *   T4 a session reopen (new sessionId) starts its ordinals from scratch,
 *      never continuing the previous session's counter;
 *   T5 two sessions alternate in one workspace without stealing each other's
 *      rounds (per-session ordinals advance independently).
 *
 * Mock policy mirrors prompt-production-chain.test.ts: only capture points and
 * boot side-effects are mocked; the collector, trajectory writer, ordinal
 * seam, shared selector and packer run for real.
 */

const trajectoryControl = vi.hoisted(() => ({
  /** 'real' = real TrajectoryDatabase; 'fail_write' = recordUserTurn throws. */
  mode: 'real' as 'real' | 'fail_write',
}));

vi.mock('../../src/core/event-log.js', () => {
  const sharedEventLog = {
    recordHeartbeatDiagnosis: vi.fn(),
    recordRuntimeActivationsInjected: vi.fn(),
    recordAdaptiveDelivery: vi.fn(),
    recordHookExecution: vi.fn(),
    recordTrajectoryObservabilityFailure: vi.fn(),
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
  getKeywordStoreSummary: vi.fn().mockReturnValue({ totalTerms: 0, highFalsePositiveTerms: [], termCount: 0 }),
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

const COVERAGE_COUNT = 6;
/** Each body is long enough that ~3 blocks fill the no-model-facts default
 * 2000-char budget, so the rotation ring visibly changes the selected set. */
const COVERAGE_FILL_CHARS = 480;
const principleText = (i: number): string => `PRI1162_COVERAGE_PRINCIPLE_${i}_${'x'.repeat(COVERAGE_FILL_CHARS)}`;

let tempWorkspaceDir = '';
let tempStateDir = '';
let sqliteConn: SqliteConnection;
let hook: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
let fakeLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;

beforeEach(async () => {
  vi.clearAllMocks();
  trajectoryControl.mode = 'real';
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
  const { resetAdaptiveConfigIdentityStateForTest } = await import('../../src/core/adaptive-config-identity.js');
  resetAdaptiveConfigIdentityStateForTest();

  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1162-cov-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
  fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();

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

interface InjectionPayload {
  selectionPolicy?: string;
  selectionRoundOrdinal?: number;
  selectionRoundSource?: string;
  rotationStartIndex?: number;
  principleIds?: string[];
  injectedCharCount?: number;
  eligibleCount?: number;
  sessionId?: string;
}

async function seedCoveragePrinciples(): Promise<void> {
  const db = sqliteConn.getDb();
  const store = new SqliteActivationStateStore(sqliteConn);
  for (let i = 1; i <= COVERAGE_COUNT; i += 1) {
    const principleId = `PRI1162-COV-${String(i).padStart(2, '0')}`;
    const artifactId = `art-pri1162-cov-${i}`;
    const now = new Date(Date.parse('2026-11-10T00:00:00.000Z') + i).toISOString();
    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(artifactId, 'principle', `task-pri1162-${i}`, principleId, null, '[]', 'validated', JSON.stringify({ principleId, text: principleText(i) }), now, now);
    await store.recordActivation({
      activationId: `act-pri1162-cov-${i}`,
      idempotencyKey: `${artifactId}::prompt`,
      artifactId,
      channel: 'prompt' as ActivationStatusRecord['channel'],
      action: 'prompt_activate',
      targetRef: `ledger://${principleId}`,
      activatedAt: now,
      deactivatedAt: null,
    });
  }
}

function makeEvent(sessionId: string, runId: string, trigger = 'user'): Record<string, unknown> {
  return { prompt: `user turn for ${runId}`, messages: [], trigger, sessionId };
}

function makeHookCtx(sessionId: string, runId: string, trigger = 'user'): Record<string, unknown> {
  return { workspaceDir: tempWorkspaceDir, trigger, sessionId, runId, agentId: 'agent-1' };
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

/** Drive one real user round through the production hook; return its event payload. */
async function oneUserRound(sessionId: string, runId: string): Promise<InjectionPayload> {
  const spy = await injectionSpy();
  const before = spy.mock.calls.length;
  await hook?.(makeEvent(sessionId, runId), makeHookCtx(sessionId, runId));
  expect(spy.mock.calls.length).toBe(before + 1);
  return (spy.mock.calls[before] as unknown as InjectionPayload[])[0]!;
}

describe('PRI-1162: round-key coverage through the real production chain (card v0.1 §4.1)', () => {
  it('T1: consecutive user rounds advance the rotation — ordinals climb, start rotates, the FIFO prefix is left behind', async () => {
    await seedCoveragePrinciples();
    const sessionId = 'pri1162-t1-rotation';

    const oldestId = 'PRI1162-COV-01';
    const rounds: InjectionPayload[] = [];
    for (let k = 1; k <= COVERAGE_COUNT; k += 1) {
      rounds.push(await oneUserRound(sessionId, `run-t1-${k}`));
    }

    // 1. Every round ran fair rotation on the persisted ordinal (written turn k,
    //    read max+1 = k+1 — the current-round binding, never a stale read).
    expect(rounds.map((p) => p.selectionPolicy)).toEqual(Array(COVERAGE_COUNT).fill('fair_rotation_v1'));
    expect(rounds.map((p) => p.selectionRoundOrdinal)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(rounds.every((p) => p.selectionRoundSource === 'session_user_turn_ordinal')).toBe(true);

    // 2. The start index genuinely rotates through the whole ring (6 rounds,
    //    6 candidates → every ring position leads exactly once).
    expect(rounds.map((p) => p.rotationStartIndex)).toEqual([2, 3, 4, 5, 0, 1]);

    // 3. The selected set LEAVES the FIFO prefix: distinct sets across the window,
    //    and the oldest principle — which a FIFO prefix would inject EVERY round —
    //    is absent on the start>0 rounds whose budget runs out before wrapping.
    const sets = new Set(rounds.map((p) => (p.principleIds ?? []).join(',')));
    expect(sets.size).toBeGreaterThanOrEqual(3);
    const roundsWithOldest = rounds.filter((p) => (p.principleIds ?? []).includes(oldestId));
    const roundsWithoutOldest = rounds.filter((p) => !(p.principleIds ?? []).includes(oldestId));
    expect(roundsWithOldest.length).toBeGreaterThanOrEqual(1);
    expect(roundsWithoutOldest.length).toBeGreaterThanOrEqual(1);
    // A round that misses the oldest candidate must have a rotated (non-zero)
    // start — under FIFO the oldest candidate is ALWAYS in the prefix.
    for (const miss of roundsWithoutOldest) {
      expect(miss.rotationStartIndex).toBeGreaterThan(0);
    }

    // 4. Every round wrote exactly one user turn for this session.
    expect(userTurnRows(sessionId)).toEqual({ count: COVERAGE_COUNT, maxTurnIndex: COVERAGE_COUNT });
  });

  it('T2: a same-run retry is byte-stable — same ordinal, same selection, still ONE write', async () => {
    await seedCoveragePrinciples();
    const spy = await injectionSpy();
    const sessionId = 'pri1162-t2-retry';

    const first = await oneUserRound(sessionId, 'run-t2-retry');
    const callsAfterFirst = spy.mock.calls.length;
    await hook?.(makeEvent(sessionId, 'run-t2-retry'), makeHookCtx(sessionId, 'run-t2-retry'));

    // The replay claims ITS OWN ordinal and reproduces the same selection.
    expect(spy.mock.calls.length).toBe(callsAfterFirst + 1);
    const replay = (spy.mock.calls[callsAfterFirst] as unknown as InjectionPayload[])[0]!;
    expect(replay.selectionRoundOrdinal).toBe(first.selectionRoundOrdinal);
    expect(replay.selectionPolicy).toBe(first.selectionPolicy);
    expect(replay.principleIds).toEqual(first.principleIds);
    expect(replay.injectedCharCount).toBe(first.injectedCharCount);
    expect(userTurnRows(sessionId).count).toBe(1);
  });

  it('T3: a subagent trigger records no round and selects FIFO (write-free invocation)', async () => {
    await seedCoveragePrinciples();
    const spy = await injectionSpy();
    const sessionId = 'pri1162-t3-subagent';

    await hook?.(
      { prompt: 'subagent probe', messages: [], trigger: 'subagent', sessionId } as never,
      makeHookCtx(sessionId, 'run-t3-sub', 'subagent'),
    );

    expect(userTurnRows(sessionId).count).toBe(0);
    const payload = (spy.mock.calls[0] as unknown as InjectionPayload[])[0]!;
    expect(payload.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(payload.selectionRoundOrdinal).toBeUndefined();
    expect(payload.selectionRoundSource).toBeUndefined();
    // Sibling degradations (heartbeat, empty message, failed write, missing
    // sessionId) are pinned in prompt-production-chain.test.ts P1-3 cases.
  });

  it('T4: a session reopen (new sessionId) starts from scratch — no counter carry-over from the previous session', async () => {
    await seedCoveragePrinciples();
    const firstSession = 'pri1162-t4-session-a';
    const reopenedSession = 'pri1162-t4-session-b';

    const a1 = await oneUserRound(firstSession, 'run-t4-a1');
    const a2 = await oneUserRound(firstSession, 'run-t4-a2');
    expect([a1.selectionRoundOrdinal, a2.selectionRoundOrdinal]).toEqual([2, 3]);

    const b1 = await oneUserRound(reopenedSession, 'run-t4-b1');
    // The reopened session's FIRST round keys on ITS OWN persisted turn (1+1),
    // not on the previous session's counter.
    expect(b1.selectionRoundOrdinal).toBe(2);
    expect(b1.selectionPolicy).toBe('fair_rotation_v1');
    expect(userTurnRows(reopenedSession)).toEqual({ count: 1, maxTurnIndex: 1 });
    expect(userTurnRows(firstSession)).toEqual({ count: 2, maxTurnIndex: 2 });
  });

  it('T5: two sessions alternate in one workspace — per-session ordinals advance independently', async () => {
    await seedCoveragePrinciples();
    const sessionA = 'pri1162-t5-session-a';
    const sessionB = 'pri1162-t5-session-b';

    const a1 = await oneUserRound(sessionA, 'run-t5-a1');
    const b1 = await oneUserRound(sessionB, 'run-t5-b1');
    const a2 = await oneUserRound(sessionA, 'run-t5-a2');
    const b2 = await oneUserRound(sessionB, 'run-t5-b2');

    expect([a1.selectionRoundOrdinal, a2.selectionRoundOrdinal]).toEqual([2, 3]);
    expect([b1.selectionRoundOrdinal, b2.selectionRoundOrdinal]).toEqual([2, 3]);
    // Each event names its own session — a stolen round would misattribute.
    expect([a1.sessionId, a2.sessionId]).toEqual([sessionA, sessionA]);
    expect([b1.sessionId, b2.sessionId]).toEqual([sessionB, sessionB]);
    // Both rotations started at the same ring position (same ordinal, same N).
    expect(a1.rotationStartIndex).toBe(b1.rotationStartIndex);
    // Query-level session isolation of the underlying fact is additionally
    // covered by tests/core/trajectory.test.ts 'isolates by sessionId'.
  });
});
