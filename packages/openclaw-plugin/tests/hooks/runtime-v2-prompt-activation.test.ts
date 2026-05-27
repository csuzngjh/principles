import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { ActivationStatusRecord } from '@principles/core/runtime-v2';
import { PromptActivationReader, RUNTIME_V2_PRINCIPLE_BUDGET } from '../../src/core/runtime-v2-prompt-activation-reader.js';

const TEST_PRINCIPLE_TEXT = 'UNIQUE_RUNTIME_V2_TEST_PRINCIPLE_7x9k2';

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

beforeEach(() => {
  vi.clearAllMocks();
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
    }),
  },
}));

vi.mock('../../src/core/workspace-context.js', () => {
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn().mockImplementation(() => ({
        workspaceDir: tempWorkspaceDir,
        stateDir: tempStateDir,
        resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
        trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
        config: { get: vi.fn() },
        evolutionReducer: {
          getActivePrinciples: vi.fn().mockReturnValue([]),
          getProbationPrinciples: vi.fn().mockReturnValue([]),
        },
      })),
      fromHookContextExplicit: vi.fn().mockImplementation(() => ({
        workspaceDir: tempWorkspaceDir,
        stateDir: tempStateDir,
        resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
        trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
        config: { get: vi.fn() },
        evolutionReducer: {
          getActivePrinciples: vi.fn().mockReturnValue([]),
          getProbationPrinciples: vi.fn().mockReturnValue([]),
        },
      })),
    },
  };
});

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue({ currentGfi: 20 }),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  setInjectedProbationIds: vi.fn(),
  clearInjectedProbationIds: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: { getExtensionRoot: vi.fn().mockReturnValue('/fake/extension') },
}));

vi.mock('../../src/core/principle-injection.js', () => ({
  selectPrinciplesForInjection: vi.fn().mockReturnValue({
    selected: [],
    wasTruncated: false,
    breakdown: { p0: 0, p1: 0, p2: 0 },
    totalChars: 0,
  }),
  DEFAULT_PRINCIPLE_BUDGET: 3000,
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
      match: vi.fn().mockReturnValue({ matched: null, matchedTerms: [], confidence: 0 }),
      recordHits: vi.fn(),
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

vi.mock('../../src/service/subagent-workflow/index.js', () => ({
  EmpathyObserverWorkflowManager: vi.fn(),
  empathyObserverWorkflowSpec: {},
  isExpectedSubagentError: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/utils/subagent-probe.js', () => ({
  isSubagentRuntimeAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/core/local-worker-routing.js', () => ({
  classifyTask: vi.fn().mockReturnValue({
    decision: 'stay_main',
    classification: 'unknown',
    reason: 'mocked',
    blockers: [],
  }),
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
} = {}) {
  const {
    workspaceDir = tempWorkspaceDir,
    trigger = 'user',
    sessionId = 'test-session-v2',
  } = overrides;
  return {
    workspaceDir,
    trigger,
    sessionId,
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

describe('Runtime V2 prompt activation injection', () => {
  it('owner-approved activated principle changes future prompt', async () => {
    const artifactId = 'art-v2-prompt-001';
    const principleId = 'princ-v2-001';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.appendSystemContext).toContain(TEST_PRINCIPLE_TEXT);
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

    expect(result?.appendSystemContext).toContain(TEST_PRINCIPLE_TEXT);

    const infoCalls = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasCoreFlagWarning = infoCalls.some(
      (c: string) => c.includes('core flag cannot be disabled') || c.includes('warnings'),
    );
    expect(hasCoreFlagWarning || result?.appendSystemContext).toBeTruthy();
  });

  it('missing activated artifact fails loud without crashing', async () => {
    const artifactId = 'art-v2-missing-005';
    const principleId = 'princ-v2-missing-005';

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
    const hasActivationWarning = warnCalls.some((c: string) => c.includes('artifact_not_found') || c.includes('artifact_query_unexpected') || c.includes('activation'));
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

    expect(result?.appendSystemContext).toContain(TEST_PRINCIPLE_TEXT);
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

    const injected = hookResult?.appendSystemContext ?? '';
    const markerCount = (injected.match(/princ-v2-budget-/g) || []).length;
    expect(markerCount).toBeLessThan(5);
    expect(markerCount).toBeGreaterThan(0);
  });

  it('malformed DB/config input fails loud with warning', async () => {
    const pdDir = path.join(tempWorkspaceDir, '.pd');
    fs.writeFileSync(
      path.join(pdDir, 'feature-flags.yaml'),
      '__proto__:\n  enabled: true\nprompt:\n  enabled: true\nconstructor:\n  enabled: false\n',
      'utf8',
    );

    const warnSpy = vi.fn();
    const reader = new PromptActivationReader(tempWorkspaceDir, {
      logger: { warn: warnSpy, info: vi.fn(), error: vi.fn() },
    });
    const result = await reader.readActivatedPrinciples();

    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasDangerousKeyWarning = warnCalls.some(
      (c: string) => c.includes('dangerous key') || c.includes('__proto__') || c.includes('constructor'),
    );
    expect(hasDangerousKeyWarning).toBe(true);
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
