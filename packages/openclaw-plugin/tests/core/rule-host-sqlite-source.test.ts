/**
 * PRI-436: SQLite is the sole RuleHost source — TDD vertical slices
 *
 * Tests verify through public interfaces:
 *   - Real SQLite store (SqliteConnection + SqliteActivationStateStore)
 *   - Real RuleHost.evaluate()
 *   - No mocking of private internals
 *
 * ERR risk mitigation:
 *   - ERR-024/ERR-048: tests exercise the production RuleHost.evaluate() → SQLite read chain
 *   - ERR-073: tests verify call-site behavior equivalence, not just reader happy path
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';
import type { RuleHostLogger } from '../../src/core/rule-host.js';

// ── Test helpers ───────────────────────────────────────────────────────────

const RULE_ID = 'R_TEST_SQLITE_001';
const ARTIFACT_ID = 'art-rule-sqlite-001';
const ACTIVATION_ID = `act_code_${RULE_ID}`;

const BLOCKING_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'Blocked: system directory' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'test-sqlite-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

// CodeRabbit PR2 Comment 2: track every RuleHost created in a test so we can
// dispose() (close its lazily-opened SqliteConnection) in afterEach. Without
// this, each `new RuleHost(...)` leaked a SQLite file handle that survived
// sqliteConn.close() in the existing teardown — on Windows the open handle
// also blocked fs.rmSync(tempWorkspaceDir) and made subsequent tests flaky.
let createdRuleHosts: RuleHost[] = [];

/**
 * Create a RuleHost for the current test and register it for disposal.
 * Use this instead of `new RuleHost(...)` so teardown can close the host's
 * internal SqliteConnection (the test's own `sqliteConn` is a separate
 * connection used only for fixture inserts).
 */
function makeRuleHost(logger: RuleHostLogger = console): RuleHost {
  const host = new RuleHost(tempStateDir, logger, { workspaceDir: tempWorkspaceDir });
  createdRuleHosts.push(host);
  return host;
}

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-rulehost-sqlite-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
}

function insertRuleArtifact(overrides?: {
  artifactId?: string;
  ruleId?: string;
  contentJson?: string;
  validationStatus?: string;
  sourceTaskId?: string;
}): void {
  const artifactId = overrides?.artifactId ?? ARTIFACT_ID;
  const ruleId = overrides?.ruleId ?? RULE_ID;
  const validationStatus = overrides?.validationStatus ?? 'validated';
  const sourceTaskId = overrides?.sourceTaskId ?? 'task-test-001';
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();

  const contentJson = overrides?.contentJson ?? JSON.stringify({
    principleId: 'P_TEST_001',
    ruleId,
    implementationCode: BLOCKING_CODE,
    goldenTrace: {
      traceId: 'trace-test-001',
      cases: [
        { caseId: 'case-neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'case-pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/safe/file.txt' }, expectedDecision: 'allow' },
      ],
      createdAt: now,
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: prevent writing to system directories',
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    'rule',
    sourceTaskId,
    'P_TEST_001',
    ruleId,
    '[]',
    validationStatus,
    contentJson,
    now,
    now,
  );
}

async function insertCodeToolHookActivation(overrides?: {
  activationId?: string;
  artifactId?: string;
  ruleId?: string;
  deactivatedAt?: string | null;
  action?: string;
}): Promise<void> {
  const activationId = overrides?.activationId ?? ACTIVATION_ID;
  const artifactId = overrides?.artifactId ?? ARTIFACT_ID;
  const ruleId = overrides?.ruleId ?? RULE_ID;
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();

  await store.recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: overrides?.action ?? 'code_tool_hook_live_activate',
    targetRef: `impl://${ruleId}`,
    activatedAt: now,
    deactivatedAt: overrides?.deactivatedAt ?? null,
  });
}

function makeInput(normalizedPath: string): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: {
      isRiskPath: false,
      planStatus: 'NONE',
      hasPlanFile: false,
    },
    session: {
      sessionId: 'test-session',
      currentGfi: 0,
      recentThinking: false,
    },
    evolution: {
      epTier: 1,
    },
    derived: {
      estimatedLineChanges: 1,
      bashRisk: 'safe' as const,
    },
  };
}

function makeV2Input(normalizedPath: string): RuleHostInput {
  return {
    ...makeInput(normalizedPath),
    context: {
      version: 2,
      history: { status: 'available', truncated: false, calls: [] },
      facts: {
        priorReadOfTarget: 'no',
        readCount: 0,
        writeCount: 0,
        uniqueWritePathCount: 0,
        sameActionBlockCount: null,
      },
    },
  };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  setupTempDirs();
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
  createdRuleHosts = [];
});

afterEach(() => {
  // Dispose every RuleHost created in this test before closing the fixture
  // connection and removing the temp dir. RuleHost lazily opens its own
  // SqliteConnection on first evaluate(); without dispose() the handle leaks
  // and on Windows blocks fs.rmSync below.
  for (const host of createdRuleHosts) {
    try { host.dispose(); } catch { /* best-effort */ }
  }
  createdRuleHosts = [];
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

// ── Slice 1: SQLite-only RuleHost executes exactly once ────────────────────

describe('PRI-436 Slice 1: SQLite-only RuleHost executes exactly once', () => {
  it('single SQLite activation produces block for matching path', async () => {
    insertRuleArtifact();
    await insertCodeToolHookActivation();

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeDefined();
    expect(result?.decision).toBe('block');
    expect(result?.matched).toBe(true);
    expect(result?.ruleId).toBe(RULE_ID);
  });

  it('single SQLite activation allows non-matching path', async () => {
    insertRuleArtifact();
    await insertCodeToolHookActivation();

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/safe/project/file.txt'));

    // No match → undefined (no opinion) or allow
    expect(result?.decision ?? 'allow').toBe('allow');
  });

  it('no SQLite activation → no opinion (undefined)', async () => {
    // Artifact exists but no activation
    insertRuleArtifact();

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
  });

  it('deactivated SQLite activation → no opinion (undefined)', async () => {
    insertRuleArtifact();
    await insertCodeToolHookActivation({ deactivatedAt: new Date().toISOString() });

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
  });
});

describe('RuleContext v2 activation compatibility', () => {
  it('does not load a v2 activation when the host input has no v2 context', async () => {
    insertRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: BLOCKING_CODE,
        requiresContextVersion: 2,
      }),
    });
    await insertCodeToolHookActivation({ action: 'code_tool_hook_live_activate' });
    const ruleHost = makeRuleHost();

    expect(ruleHost.evaluate(makeInput('/etc/passwd'))).toBeUndefined();
  });

  it('loads a v2 activation when the host input carries v2 context', async () => {
    insertRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: BLOCKING_CODE,
        requiresContextVersion: 2,
      }),
    });
    await insertCodeToolHookActivation({ action: 'code_tool_hook_live_activate' });
    const ruleHost = makeRuleHost();

    expect(ruleHost.evaluate(makeV2Input('/etc/passwd'))?.decision).toBe('block');
  });
});

describe('RuleHost shadow and live activation modes', () => {
  it('evaluates a shadow activation without returning an enforcement decision', async () => {
    insertRuleArtifact();
    await insertCodeToolHookActivation({ action: 'code_tool_hook_shadow_activate' });
    const ruleHost = makeRuleHost();

    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision).toBeUndefined();
    expect(report.shadowDecisions).toEqual([
      expect.objectContaining({
        decision: 'block',
        ruleId: RULE_ID,
        activationId: ACTIVATION_ID,
      }),
    ]);
    expect(ruleHost.evaluate(makeInput('/etc/passwd'))).toBeUndefined();
  });
});

// ── Slice 2: Legacy filesystem file exists but is never read/compiled ──────

const LEGACY_RULE_ID = 'R_TEST_DUAL_001';
const LEGACY_IMPL_ID = 'impl_legacy_001';
const SQLITE_RULE_ID = 'R_TEST_DUAL_001';
const SQLITE_ARTIFACT_ID = 'art-rule-dual-001';
const SQLITE_ACTIVATION_ID = 'act_code_R_TEST_DUAL_001';

const LEGACY_BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'LEGACY_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'legacy-rule', version: '1', ruleId: '${LEGACY_RULE_ID}', coversCondition: 'all' };
`;

const SQLITE_BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'SQLITE_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'sqlite-rule', version: '2', ruleId: '${SQLITE_RULE_ID}', coversCondition: 'all' };
`;

/**
 * Write a filesystem ledger (principle_training_state.json) with an active
 * code implementation. Also writes the implementation source file to disk.
 */
function writeLegacyFilesystemLedger(stateDir: string): void {
  const ledgerPath = path.join(stateDir, 'principle_training_state.json');
  const implSourcePath = path.join(stateDir, 'principles', 'implementations', LEGACY_IMPL_ID, 'entry.js');

  // Write the implementation source file
  fs.mkdirSync(path.dirname(implSourcePath), { recursive: true });
  fs.writeFileSync(implSourcePath, LEGACY_BLOCK_CODE, 'utf-8');

  // Write the manifest
  const manifestPath = path.join(stateDir, 'principles', 'implementations', LEGACY_IMPL_ID, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    implId: LEGACY_IMPL_ID,
    entryFile: 'entry.js',
    version: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }), 'utf-8');

  // Write the ledger
  const now = new Date().toISOString();
  const ledger = {
    _tree: {
      principles: {},
      rules: {},
      implementations: {
        [LEGACY_IMPL_ID]: {
          id: LEGACY_IMPL_ID,
          ruleId: LEGACY_RULE_ID,
          type: 'code',
          path: implSourcePath,
          version: '1',
          coversCondition: 'all',
          coveragePercentage: 100,
          lifecycleState: 'active',
          createdAt: now,
          updatedAt: now,
        },
      },
      metrics: {},
      lastUpdated: now,
    },
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8');
}

describe('PRI-436 Slice 2: Legacy filesystem file is never read/compiled', () => {
  it('conflicting legacy ledger exists → SQLite version wins (filesystem never read)', async () => {
    // Create conflicting filesystem ledger with LEGACY_BLOCK code
    writeLegacyFilesystemLedger(tempStateDir);

    // Create SQLite activation with SQLITE_BLOCK code
    insertRuleArtifact({
      artifactId: SQLITE_ARTIFACT_ID,
      ruleId: SQLITE_RULE_ID,
      contentJson: JSON.stringify({
        principleId: 'P_TEST_DUAL_001',
        ruleId: SQLITE_RULE_ID,
        implementationCode: SQLITE_BLOCK_CODE,
        goldenTrace: {
          traceId: 'trace-dual-001',
          cases: [
            { caseId: 'case-neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
            { caseId: 'case-pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/safe/file.txt' }, expectedDecision: 'allow' },
          ],
          createdAt: new Date().toISOString(),
          version: 1,
        },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: prevent writing to system directories',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: SQLITE_ACTIVATION_ID,
      artifactId: SQLITE_ARTIFACT_ID,
      ruleId: SQLITE_RULE_ID,
    });

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeDefined();
    expect(result?.decision).toBe('block');
    expect(result?.matched).toBe(true);
    // SQLite version must win — filesystem legacy code must NOT be read
    expect(result?.reason).toBe('SQLITE_BLOCK');
    expect(result?.reason).not.toBe('LEGACY_BLOCK');
  });

  it('legacy ledger exists but no SQLite activation → no opinion (undefined)', async () => {
    // Filesystem ledger exists but RuleHost should not read it
    writeLegacyFilesystemLedger(tempStateDir);

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // No SQLite activation → no opinion, even though filesystem ledger has an active impl
    expect(result).toBeUndefined();
  });
});

// ── Slice 3: Duplicate active DB rows execute zero times + structured unhealthy evidence ───

const DUP_RULE_ID = 'R_TEST_DUP_001';
const DUP_ARTIFACT_ID_A = 'art-dup-a-001';
const DUP_ARTIFACT_ID_B = 'art-dup-b-001';
const DUP_ACTIVATION_ID_A = 'act_code_dup_a_001';
const DUP_ACTIVATION_ID_B = 'act_code_dup_b_001';

const DUP_BLOCK_CODE_A = `
function evaluate(input, helpers) {
  return { decision: 'block', matched: true, reason: 'DUP_BLOCK_A' };
}
var meta = { name: 'dup-rule-a', version: '1', ruleId: '${DUP_RULE_ID}', coversCondition: 'all' };
`;

const DUP_BLOCK_CODE_B = `
function evaluate(input, helpers) {
  return { decision: 'block', matched: true, reason: 'DUP_BLOCK_B' };
}
var meta = { name: 'dup-rule-b', version: '2', ruleId: '${DUP_RULE_ID}', coversCondition: 'all' };
`;

describe('PRI-436 Slice 3: Duplicate active DB rows execute zero times + structured unhealthy evidence', () => {
  it('two active activations for the same rule → zero executions (undefined) + structured warn', async () => {
    // Insert two artifacts for the same rule (different artifactIds, different code)
    insertRuleArtifact({
      artifactId: DUP_ARTIFACT_ID_A,
      ruleId: DUP_RULE_ID,
      sourceTaskId: 'task-dup-a-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_DUP_001',
        ruleId: DUP_RULE_ID,
        implementationCode: DUP_BLOCK_CODE_A,
        goldenTrace: { traceId: 'trace-dup-a', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: duplicate A',
      }),
    });
    insertRuleArtifact({
      artifactId: DUP_ARTIFACT_ID_B,
      ruleId: DUP_RULE_ID,
      sourceTaskId: 'task-dup-b-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_DUP_001',
        ruleId: DUP_RULE_ID,
        implementationCode: DUP_BLOCK_CODE_B,
        goldenTrace: { traceId: 'trace-dup-b', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: duplicate B',
      }),
    });

    // Insert two active activations targeting the same rule (same target_ref)
    await insertCodeToolHookActivation({
      activationId: DUP_ACTIVATION_ID_A,
      artifactId: DUP_ARTIFACT_ID_A,
      ruleId: DUP_RULE_ID,
    });
    await insertCodeToolHookActivation({
      activationId: DUP_ACTIVATION_ID_B,
      artifactId: DUP_ARTIFACT_ID_B,
      ruleId: DUP_RULE_ID,
    });

    // Spy logger to capture structured warn evidence
    const warnCalls: string[] = [];
    const spyLogger: { warn: (_message: string) => void } = {
      warn: (message: string) => { warnCalls.push(message); },
    };

    const ruleHost = makeRuleHost(spyLogger);
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // Zero executions for the duplicate rule → no opinion (undefined)
    expect(result).toBeUndefined();

    // Structured unhealthy evidence emitted via logger.warn
    expect(warnCalls.length).toBeGreaterThan(0);
    const dupWarn = warnCalls.find(m => m.toLowerCase().includes('duplicate'));
    expect(dupWarn).toBeDefined();
    // Evidence must identify the conflicting rule and activations
    expect(dupWarn).toContain(DUP_RULE_ID);
    expect(dupWarn).toContain(DUP_ACTIVATION_ID_A);
    expect(dupWarn).toContain(DUP_ACTIVATION_ID_B);
  });

  it('non-duplicate rule still executes when another rule has duplicates', async () => {
    // Rule with duplicate activations (should be skipped)
    insertRuleArtifact({
      artifactId: DUP_ARTIFACT_ID_A,
      ruleId: DUP_RULE_ID,
      sourceTaskId: 'task-dup-a-002',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_DUP_001',
        ruleId: DUP_RULE_ID,
        implementationCode: DUP_BLOCK_CODE_A,
        goldenTrace: { traceId: 'trace-dup-a', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: duplicate A',
      }),
    });
    insertRuleArtifact({
      artifactId: DUP_ARTIFACT_ID_B,
      ruleId: DUP_RULE_ID,
      sourceTaskId: 'task-dup-b-002',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_DUP_001',
        ruleId: DUP_RULE_ID,
        implementationCode: DUP_BLOCK_CODE_B,
        goldenTrace: { traceId: 'trace-dup-b', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: duplicate B',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: DUP_ACTIVATION_ID_A,
      artifactId: DUP_ARTIFACT_ID_A,
      ruleId: DUP_RULE_ID,
    });
    await insertCodeToolHookActivation({
      activationId: DUP_ACTIVATION_ID_B,
      artifactId: DUP_ARTIFACT_ID_B,
      ruleId: DUP_RULE_ID,
    });

    // Non-duplicate rule (should execute normally)
    const OTHER_RULE_ID = 'R_TEST_OTHER_001';
    const OTHER_ARTIFACT_ID = 'art-other-001';
    const OTHER_ACTIVATION_ID = 'act_code_other_001';
    const OTHER_BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'OTHER_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'other-rule', version: '1', ruleId: '${OTHER_RULE_ID}', coversCondition: 'all' };
`;
    insertRuleArtifact({
      artifactId: OTHER_ARTIFACT_ID,
      ruleId: OTHER_RULE_ID,
      sourceTaskId: 'task-other-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_OTHER_001',
        ruleId: OTHER_RULE_ID,
        implementationCode: OTHER_BLOCK_CODE,
        goldenTrace: { traceId: 'trace-other', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: other rule',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: OTHER_ACTIVATION_ID,
      artifactId: OTHER_ARTIFACT_ID,
      ruleId: OTHER_RULE_ID,
    });

    const warnCalls: string[] = [];
    const spyLogger: { warn: (_message: string) => void } = {
      warn: (message: string) => { warnCalls.push(message); },
    };

    const ruleHost = makeRuleHost(spyLogger);
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // Non-duplicate rule still executes and blocks
    expect(result).toBeDefined();
    expect(result?.decision).toBe('block');
    expect(result?.matched).toBe(true);
    expect(result?.reason).toBe('OTHER_BLOCK');
    expect(result?.ruleId).toBe(OTHER_RULE_ID);

    // Duplicate rule evidence still emitted
    const dupWarn = warnCalls.find(m => m.toLowerCase().includes('duplicate'));
    expect(dupWarn).toBeDefined();
    expect(dupWarn).toContain(DUP_RULE_ID);
  });
});

// ── Slice 4: edit/reactivate selects only new version; deactivate removes effect immediately ─

const EDIT_RULE_ID = 'R_TEST_EDIT_001';
const EDIT_ARTIFACT_ID_V1 = 'art-edit-v1-001';
const EDIT_ARTIFACT_ID_V2 = 'art-edit-v2-001';
const EDIT_ACTIVATION_ID_V1 = 'act_code_edit_v1_001';
const EDIT_ACTIVATION_ID_V2 = 'act_code_edit_v2_001';

const EDIT_BLOCK_CODE_V1 = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'EDIT_V1_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'edit-rule-v1', version: '1', ruleId: '${EDIT_RULE_ID}', coversCondition: 'all' };
`;

const EDIT_BLOCK_CODE_V2 = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'EDIT_V2_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'edit-rule-v2', version: '2', ruleId: '${EDIT_RULE_ID}', coversCondition: 'all' };
`;

describe('PRI-436 Slice 4: edit/reactivate selects only new version; deactivate removes effect immediately', () => {
  it('edit: old version deactivated + new version active → only new version executes', async () => {
    // v1: insert artifact + activate
    insertRuleArtifact({
      artifactId: EDIT_ARTIFACT_ID_V1,
      ruleId: EDIT_RULE_ID,
      sourceTaskId: 'task-edit-v1-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_EDIT_001',
        ruleId: EDIT_RULE_ID,
        implementationCode: EDIT_BLOCK_CODE_V1,
        goldenTrace: { traceId: 'trace-edit-v1', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: edit v1',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: EDIT_ACTIVATION_ID_V1,
      artifactId: EDIT_ARTIFACT_ID_V1,
      ruleId: EDIT_RULE_ID,
    });

    const ruleHost = makeRuleHost();

    // v1 is active → v1 executes
    const resultV1 = ruleHost.evaluate(makeInput('/etc/passwd'));
    expect(resultV1?.decision).toBe('block');
    expect(resultV1?.reason).toBe('EDIT_V1_BLOCK');

    // Edit: deactivate v1, insert v2, activate v2
    const store = new SqliteActivationStateStore(sqliteConn);
    await store.deactivateActivation(EDIT_ACTIVATION_ID_V1, new Date().toISOString());

    insertRuleArtifact({
      artifactId: EDIT_ARTIFACT_ID_V2,
      ruleId: EDIT_RULE_ID,
      sourceTaskId: 'task-edit-v2-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_EDIT_001',
        ruleId: EDIT_RULE_ID,
        implementationCode: EDIT_BLOCK_CODE_V2,
        goldenTrace: { traceId: 'trace-edit-v2', cases: [], createdAt: new Date().toISOString(), version: 2 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: edit v2',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: EDIT_ACTIVATION_ID_V2,
      artifactId: EDIT_ARTIFACT_ID_V2,
      ruleId: EDIT_RULE_ID,
    });

    // Only v2 should execute (v1 is deactivated)
    const resultV2 = ruleHost.evaluate(makeInput('/etc/passwd'));
    expect(resultV2?.decision).toBe('block');
    expect(resultV2?.reason).toBe('EDIT_V2_BLOCK');
    expect(resultV2?.reason).not.toBe('EDIT_V1_BLOCK');
  });

  it('deactivate removes effect immediately (same RuleHost instance, no restart)', async () => {
    insertRuleArtifact({
      artifactId: EDIT_ARTIFACT_ID_V1,
      ruleId: EDIT_RULE_ID,
      sourceTaskId: 'task-deact-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_EDIT_001',
        ruleId: EDIT_RULE_ID,
        implementationCode: EDIT_BLOCK_CODE_V1,
        goldenTrace: { traceId: 'trace-deact', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: deactivate',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: EDIT_ACTIVATION_ID_V1,
      artifactId: EDIT_ARTIFACT_ID_V1,
      ruleId: EDIT_RULE_ID,
    });

    const ruleHost = makeRuleHost();

    // Rule is active → blocks
    const resultBefore = ruleHost.evaluate(makeInput('/etc/passwd'));
    expect(resultBefore?.decision).toBe('block');
    expect(resultBefore?.reason).toBe('EDIT_V1_BLOCK');

    // Deactivate
    const store = new SqliteActivationStateStore(sqliteConn);
    await store.deactivateActivation(EDIT_ACTIVATION_ID_V1, new Date().toISOString());

    // Same RuleHost instance → no effect immediately (no restart needed)
    const resultAfter = ruleHost.evaluate(makeInput('/etc/passwd'));
    expect(resultAfter).toBeUndefined();
  });
});

// ── Slice 5: Restart preserves the one active version ──────────────────────

const RESTART_RULE_ID = 'R_TEST_RESTART_001';
const RESTART_ARTIFACT_ID = 'art-restart-001';
const RESTART_ACTIVATION_ID = 'act_code_restart_001';

const RESTART_BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'RESTART_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'restart-rule', version: '1', ruleId: '${RESTART_RULE_ID}', coversCondition: 'all' };
`;

describe('PRI-436 Slice 5: Restart preserves the one active version', () => {
  it('new RuleHost instance (simulated restart) loads the same active version from SQLite', async () => {
    insertRuleArtifact({
      artifactId: RESTART_ARTIFACT_ID,
      ruleId: RESTART_RULE_ID,
      sourceTaskId: 'task-restart-001',
      contentJson: JSON.stringify({
        principleId: 'P_TEST_RESTART_001',
        ruleId: RESTART_RULE_ID,
        implementationCode: RESTART_BLOCK_CODE,
        goldenTrace: { traceId: 'trace-restart', cases: [], createdAt: new Date().toISOString(), version: 1 },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write_file'],
        painReasonSummary: 'Test: restart persistence',
      }),
    });
    await insertCodeToolHookActivation({
      activationId: RESTART_ACTIVATION_ID,
      artifactId: RESTART_ARTIFACT_ID,
      ruleId: RESTART_RULE_ID,
    });

    // Instance 1 (original process)
    const ruleHost1 = makeRuleHost();
    const result1 = ruleHost1.evaluate(makeInput('/etc/passwd'));
    expect(result1?.decision).toBe('block');
    expect(result1?.reason).toBe('RESTART_BLOCK');
    expect(result1?.ruleId).toBe(RESTART_RULE_ID);

    // Instance 2 (simulated restart — new RuleHost, same SQLite state)
    const ruleHost2 = makeRuleHost();
    const result2 = ruleHost2.evaluate(makeInput('/etc/passwd'));
    expect(result2?.decision).toBe('block');
    expect(result2?.reason).toBe('RESTART_BLOCK');
    expect(result2?.ruleId).toBe(RESTART_RULE_ID);

    // Deactivate, then instance 3 (restart after deactivation)
    const store = new SqliteActivationStateStore(sqliteConn);
    await store.deactivateActivation(RESTART_ACTIVATION_ID, new Date().toISOString());

    const ruleHost3 = makeRuleHost();
    const result3 = ruleHost3.evaluate(makeInput('/etc/passwd'));
    expect(result3).toBeUndefined();
  });
});
