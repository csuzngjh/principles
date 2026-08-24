import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPITaskDiagnosticJson,
  deriveOwnerGovernanceView,
  SqliteConnection,
} from '@principles/core/runtime-v2';
import { GovernanceProjectionCollector } from '../../src/server/models/GovernanceProjectionCollector.js';
import { GovernanceExperienceCollector, hashWorkspacePath } from '../../src/server/models/GovernanceExperienceCollector.js';

const AS_OF = '2026-08-24T10:00:00.000Z';
const OWNER_CONFIG = { authenticationMode: 'no_auth' as const, ownerIdentityConfiguration: 'missing' as const };

let tempDir: string;
let workspaceDir: string;

function writeLedger(principles: Record<string, { status: string; broken?: boolean }>): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const tree: Record<string, unknown> = { rules: {}, implementations: {}, metrics: {}, lastUpdated: AS_OF };
  const entries: Record<string, unknown> = {};
  for (const [id, spec] of Object.entries(principles)) {
    entries[id] = spec.broken === true
      ? { id, status: 'not-a-state', createdAt: '2026-08-20T08:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z' }
      : { id, status: spec.status, createdAt: '2026-08-20T08:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z' };
  }
  tree.principles = entries;
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({ _tree: tree }));
}

function openStateDb(): SqliteConnection {
  const connection = new SqliteConnection({ workspaceDir, readonly: false });
  connection.getDb();
  return connection;
}

function insertTask(db: ReturnType<SqliteConnection['getDb']>, taskId: string, opts: { status?: string; kind?: string; deps?: string[]; leaseExpiresAt?: string } = {}): void {
  const diagnosticJson = createPITaskDiagnosticJson({
    dependencyTaskIds: opts.deps ?? [], channel: 'prompt', timeoutMs: 30_000,
    inputArtifactRefs: [], outputArtifactRefs: [],
  });
  db.prepare(`INSERT INTO tasks
    (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, lease_expires_at, diagnostic_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, opts.kind ?? 'artificer', opts.status ?? 'pending', '2026-08-20T08:30:00.000Z', '2026-08-20T08:45:00.000Z', 1, 3, opts.leaseExpiresAt ?? null, diagnosticJson);
}

function insertArtifact(db: ReturnType<SqliteConnection['getDb']>, artifactId: string, taskId: string, principleId: string): void {
  db.prepare(`INSERT INTO pi_artifacts
    (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(artifactId, 'principle_candidate_output', taskId, principleId, '[]', 'validated', '{}', '2026-08-20T08:50:00.000Z', '2026-08-20T08:50:00.000Z');
}

function insertApproval(db: ReturnType<SqliteConnection['getDb']>, approvalId: string, artifactId: string, status: string): void {
  db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(approvalId, artifactId, 'prompt', 'low', status, '2026-08-20T09:00:00.000Z');
}

function insertActivation(db: ReturnType<SqliteConnection['getDb']>, activationId: string, artifactId: string, action: string, deactivated: boolean): void {
  db.prepare(`INSERT INTO activations
    (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(activationId, `idem-${activationId}`, artifactId, 'code_tool_hook', action, 'global', '2026-08-21T09:00:00.000Z', null, deactivated ? '2026-08-22T09:00:00.000Z' : null);
}

/** Seeds a 3-principle workspace covering every activity category + unlinked records. */
function seedRichWorkspace(): void {
  writeLedger({
    'principle-1': { status: 'candidate' },
    'principle-2': { status: 'candidate' },
    'principle-3': { status: 'active' },
    'principle-broken': { status: 'candidate', broken: true },
  });
  const connection = openStateDb();
  try {
    const db = connection.getDb();
  // principle-1: leased task with a live lease → processing (active execution)
  insertTask(db, 'task-1', { status: 'leased', leaseExpiresAt: '2099-01-01T00:00:00.000Z' });
  insertArtifact(db, 'artifact-1', 'task-1', 'principle-1');
  // principle-2: succeeded task + pending approval → needs_decision (+ active activation)
  insertTask(db, 'task-2', { status: 'succeeded' });
  insertArtifact(db, 'artifact-2', 'task-2', 'principle-2');
  insertApproval(db, 'approval-2', 'artifact-2', 'pending');
  insertActivation(db, 'act-live-2', 'artifact-2', 'code_tool_hook_live_activate', false);
  // principle-3: failed task → needs_recovery
  insertTask(db, 'task-3', { status: 'failed' });
  insertArtifact(db, 'artifact-3', 'task-3', 'principle-3');
  // unlinked records: artifact for a principle absent from the ledger, orphan
  // approval, task whose artifact belongs to no principle
  insertArtifact(db, 'artifact-ghost', 'task-ghost', 'principle-ghost');
  insertTask(db, 'task-ghost', { status: 'pending' });
  insertApproval(db, 'approval-orphan', 'artifact-missing-404', 'pending');
  // rulecode shadow activation awaiting owner decision
  insertActivation(db, 'act-shadow', 'artifact-2', 'code_tool_hook_shadow_activate', false);
  // rulecode shadow activation whose artifact does not exist (unlinked) — must
  // degrade to data quality, never inflate needs_decision (SPEC §9)
  insertActivation(db, 'act-shadow-orphan', 'artifact-missing-404', 'code_tool_hook_shadow_activate', false);
  // a malformed (wrong metadata shape, valid JSON — the column has a JSON check) task row
  db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('task-malformed', 'artificer', 'pending', '2026-08-20T08:30:00.000Z', '2026-08-20T08:45:00.000Z', 1, 3, '{"unrelated":"shape"}');
  } finally {
    connection.close();
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-experience-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('PRI-585 GovernanceExperienceCollector — projection equivalence (SPEC §16.2)', () => {
  it('batch views are identical to per-principle collect() + deriveOwnerGovernanceView()', async () => {
    seedRichWorkspace();
    const collector = new GovernanceExperienceCollector(workspaceDir);
    const inputs = collector.buildInputs({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });

    expect(inputs.governanceViews).toHaveLength(3); // principle-broken degrades, never blocks
    const single = new GovernanceProjectionCollector(workspaceDir);
    for (const principleId of ['principle-1', 'principle-2', 'principle-3']) {
      const facts = await single.collect(principleId, AS_OF);
      const view = deriveOwnerGovernanceView(facts);
      const batchEntry = inputs.governanceViews.find(entry => entry.view.principleId === principleId);
      expect(batchEntry, `batch view for ${principleId}`).toBeDefined();
      expect(batchEntry?.view).toEqual(view);
      expect(batchEntry?.lineageConfidence).toBe(facts.lineage.confidence);
    }
  });

  it('classifies the seeded workspace: decision + recovery + processing categories with bounded items', () => {
    seedRichWorkspace();
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    const categories = snapshot.activity.categories.map(category => category.category);
    expect(categories).toEqual(['needs_recovery', 'needs_decision', 'processing']);
    expect(snapshot.activity.primaryAttention).toBe('owner_decision_required');
    const decision = snapshot.activity.categories.find(category => category.category === 'needs_decision');
    // rulecode marker (workspace-level, no principleId) + principle-2 approval
    expect(decision?.count).toBe(2);
    expect(decision?.items[0]).toMatchObject({ reasonCode: 'governance.exp.reason.rulecode_owner_decision' });
    expect(decision?.items[0]?.principleId).toBeUndefined();
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.approval_pending');
  });

  it('surfaces unlinked records as data quality only — never as activity items (SPEC §16.4)', () => {
    seedRichWorkspace();
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    const unlinkedSources = snapshot.dataQuality.issueGroups
      .filter(group => group.reasonCode === 'unlinked_record')
      .map(group => group.source);
    expect(unlinkedSources).toContain('approval');
    expect(unlinkedSources).toContain('artifact');
    // task-ghost + task-malformed are claimed by no principle
    expect(unlinkedSources).toContain('task');
    // the orphan shadow activation degrades to data quality, not a decision
    expect(unlinkedSources).toContain('activation');
    const broken = snapshot.dataQuality.issueGroups.find(group => group.reasonCode === 'principle_ledger_entry_invalid');
    expect(broken?.count).toBe(1);
    // unlinked records never become decision/recovery/processing items
    for (const category of snapshot.activity.categories) {
      for (const item of category.items) {
        expect(item.reasonCode).not.toBe('unlinked_record');
      }
    }
  });
});

describe('PRI-585 query budget (SPEC §16.1) — no Principles × Source Scan', () => {
  it('readTables issues exactly 4 SQL statements per workspace read', () => {
    seedRichWorkspace();
    const connection = new SqliteConnection({ workspaceDir, readonly: true });
    const db = connection.getDb();
    const originalPrepare = db.prepare;
    let prepareCount = 0;
    // Test double (rc-2 exemption for test infrastructure): shadow the
    // prototype prepare with a counting own property.
    Object.defineProperty(db, 'prepare', {
      value: (sql: string) => {
        prepareCount += 1;
        return originalPrepare.call(db, sql);
      },
    });
    try {
      const tables = GovernanceProjectionCollector.readTables(workspaceDir, { getDb: () => db });
      expect(tables.artifactRows.length).toBeGreaterThan(0);
      expect(prepareCount).toBe(4);
    } finally {
      connection.close();
    }
  });

  it('a workspace snapshot reads the tables exactly once regardless of principle count', () => {
    seedRichWorkspace();
    const spy = vi.spyOn(GovernanceProjectionCollector, 'readTables');
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    expect(snapshot.readiness.governanceActions).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('state_db unavailable (no .pd/state.db) → degraded, never blocked, views carry source_unavailable', () => {
    writeLedger({ 'principle-1': { status: 'candidate' } });
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    expect(snapshot.activity.primaryAttention).toBe('degraded');
    expect(snapshot.activity.categories.map(category => category.category)).toEqual([]);
    expect(snapshot.trustContext.environmentContext.environment).toBe('unknown');
    const unavailable = snapshot.dataQuality.issueGroups.some(group => group.reasonCode === 'source_unavailable');
    expect(unavailable).toBe(true);
  });

  it('ledger unreadable + active tasks with established task↔artifact linkage → blocked (SPEC §8.1)', () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), '{not-json');
    const connection = openStateDb();
    const db = connection.getDb();
    insertTask(db, 'task-1', { status: 'pending' });
    // Frontier evidence requires the task↔artifact relationship; an artifact
    // row exists but the ledger is unreadable, so its owner cannot be verified.
    insertArtifact(db, 'artifact-1', 'task-1', 'principle-1');
    connection.close();
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    expect(snapshot.activity.categories.map(category => category.category)).toEqual(['blocked']);
    expect(snapshot.activity.primaryAttention).toBe('recovery_required');
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.source_unavailable');
  });

  it('ledger unreadable + tasks WITHOUT artifact linkage → degraded, never blocked (no relationship evidence)', () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), '{not-json');
    const connection = openStateDb();
    const db = connection.getDb();
    insertTask(db, 'task-orphan', { status: 'pending' });
    connection.close();
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    expect(snapshot.activity.categories.map(category => category.category)).toEqual([]);
    expect(snapshot.activity.primaryAttention).toBe('degraded');
  });
});

describe('PRI-585/587 workspace hash and environment', () => {
  it('hashWorkspacePath normalizes Windows separators, drive case, and trailing slashes without exposing the path', () => {
    const a = hashWorkspacePath('D:\\Code\\Work\\space');
    const b = hashWorkspacePath('D:/Code/Work/space');
    const c = hashWorkspacePath('D:/Code/Work/space/');
    const d = hashWorkspacePath('d:\\Code\\Work\\space');
    expect(new Set([a, b, c, d]).size).toBe(1);
    expect(a).not.toContain('\\');
    expect(a).not.toContain('/');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('environment flows from workspace config through the unified validator (PRI-587)', () => {
    seedRichWorkspace();
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    fs.writeFileSync(configPath, [
      'version: 1',
      'workspace:',
      '  default: "D:\\\\openclaw\\\\workspace"',
      '  environment: demo',
      'runtimeProfiles:',
      "  'openclaw.default': { type: openclaw, source: default }",
      'internalAgents:',
      "  defaultRuntime: 'openclaw.default'",
      '  agents:',
      '    diagnostician: { enabled: true, runtimeProfile: openclaw.default }',
      '    dreamer: { enabled: true }',
      '    scribe: { enabled: true }',
      'ui:',
      '  diagnostics: { mode: simple }',
      'features:',
      '  prompt: { category: core, enabled: true }',
      '  code_tool_hook: { category: core, enabled: true }',
      '  defer_archive: { category: core, enabled: true }',
      '',
    ].join('\n'), 'utf8');
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    expect(snapshot.trustContext.environmentContext).toEqual({ environment: 'demo', source: 'workspace_config' });
  });

  it('invalid config surfaces configIssue without bypassing the validator', () => {
    seedRichWorkspace();
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    fs.writeFileSync(configPath, 'version: 1\nworkspace:\n  default: "D:\\\\w"\n  environment: staging\n', 'utf8');
    const snapshot = new GovernanceExperienceCollector(workspaceDir).collectSnapshot({ ownerConfig: OWNER_CONFIG, asOf: AS_OF });
    expect(snapshot.trustContext.environmentContext.configIssue).toBe('config_invalid');
    expect(snapshot.dataQuality.issueGroups).toContainEqual(expect.objectContaining({ source: 'workspace', reasonCode: 'config_invalid' }));
  });
});
