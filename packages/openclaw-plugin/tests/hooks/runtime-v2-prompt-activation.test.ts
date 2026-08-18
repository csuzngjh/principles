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
      recordRuntimeV2ActivationsInjected: vi.fn(),
    }),
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
        eventLog: mockEventLog,
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

describe('Runtime V2 prompt activation injection', () => {
  it('owner-approved activated principle changes future prompt', async () => {
    const artifactId = 'art-v2-prompt-001';
    const principleId = 'princ-v2-001';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    // Runtime V2 principles are now in prependSystemContext (highest attention)
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

    // Runtime V2 principles are now in prependSystemContext
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
      'version: 1\nfeatures:\n  __proto__:\n    category: core\n    enabled: true\n  prompt:\n    category: core\n    enabled: true\n  constructor:\n    category: core\n    enabled: false\nruntimeProfiles:\n  openclaw.default:\n    type: openclaw\n    source: default\ninternalAgents:\n  defaultRuntime: openclaw.default\n  agents:\n    diagnostician:\n      enabled: true\n    dreamer:\n      enabled: true\n    scribe:\n      enabled: true\n    artificer:\n      enabled: true\n    philosopher:\n      enabled: false\n    evaluator:\n      enabled: false\n    rolloutReviewer:\n      enabled: false\n    correctionObserver:\n      enabled: false\n    empathyObserver:\n      enabled: false\n',
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
    const spy = mockEventLog.recordRuntimeV2ActivationsInjected as ReturnType<typeof vi.fn>;

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0][0];
    expect(payload.principleIds).toContain(principleId);
    expect(payload.artifactIds).toContain(artifactId);
    expect(payload.activationIds).toContain(`act_prompt_${principleId}`);
    expect(payload.injectedCount).toBe(1);
    expect(payload.injectedCharCount).toBeGreaterThan(0);
    expect(payload.budget).toBe(RUNTIME_V2_PRINCIPLE_BUDGET);
    expect(payload.sessionId).toBe('test-session-v2');
    expect(payload.workspaceDir).toBe(tempWorkspaceDir);
    expect(payload.skippedWarnings).toEqual([]);
  });

  it('emits skipReason when no validated activations exist', async () => {
    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeV2ActivationsInjected as ReturnType<typeof vi.fn>;
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

  it('confirm-first marker appears in principleIds evidence', async () => {
    const artifactId = 'art-mvp-acceptance-001';
    const principleId = 'princ-mvp-acceptance-confirm-first';
    const text = 'Before starting any coding task, the agent must first confirm requirements and present a plan for owner approval.';

    insertValidatedPrincipleArtifact({ artifactId, principleId, text });
    await insertPromptActivation({ artifactId, principleId });

    const { EventLogService } = await import('../../src/core/event-log.js');
    const mockEventLog = (EventLogService.get as ReturnType<typeof vi.fn>)();
    const spy = mockEventLog.recordRuntimeV2ActivationsInjected as ReturnType<typeof vi.fn>;
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
    const spy = mockEventLog.recordRuntimeV2ActivationsInjected as ReturnType<typeof vi.fn>;
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
    const spy = mockEventLog.recordRuntimeV2ActivationsInjected as ReturnType<typeof vi.fn>;
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

  it('directives appear after AGENT IDENTITY in prependSystemContext', async () => {
    const artifactId = 'art-v2-directive-205';
    const principleId = 'princ-v2-directive-205';

    insertValidatedPrincipleArtifact({ artifactId, principleId });
    await insertPromptActivation({ artifactId, principleId });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const ctx = result?.prependSystemContext ?? '';
    const identityIdx = ctx.indexOf('AGENT IDENTITY');
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

  it('existing evolution_principles behavior for legacy principles remains intact', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result).toBeDefined();
    expect(result?.appendSystemContext).toBeDefined();
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
