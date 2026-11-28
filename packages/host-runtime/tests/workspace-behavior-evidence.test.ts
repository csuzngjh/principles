import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyTrajectorySchemaBase, buildToolSemanticRegistry, computeBehaviorFacts, validateBehaviorExamplePack } from '@principles/core/runtime';
import type { HostEvent } from '@principles/core/host';
import { createWorkspaceBehaviorEvidencePort, readWorkspaceRuleContextRowsBefore } from '../src/workspace-behavior-evidence.js';
import { saveHostToolDeclaration } from '../src/host-tool-declaration.js';
import { recordVerifiedToolOutcomes } from '../src/production-pain-evidence.js';
import { createProductionHostRuntime } from '../src/index.js';
import { assembleBehaviorHistory } from '../src/behavior-history.js';
import { createCodexRuleContextProvider } from '../src/codex-rule-context-provider.js';
const dirs: string[] = [];
const mappings = [{ rawToolName: 'Bash', canonicalKind: 'execute' }, { rawToolName: 'apply_patch', canonicalKind: 'write' }];
const built = buildToolSemanticRegistry(mappings);
if (!built.ok) throw new Error('test registry invalid');
const semantics = built.registry;
const selection = { sourcePainId: 'original-pain', sourceNegativeToolCallId: 3, positiveToolCallIds: [2], ownerDesiredOutcome: 'Owner-labelled test: block negative and allow positive' };
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bep-real-')); dirs.push(root);
  fs.mkdirSync(path.join(root, '.state'));
  const db = new Database(path.join(root, '.state', 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run('s1', 'now', 'now');
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run('s2', 'now', 'now');
  for (const [id, sessionId, name, params] of [[1, 's1', 'apply_patch', { path: '/project/a' }], [2, 's1', 'Bash', { command: 'git status' }], [3, 's1', 'Bash', { command: 'git commit' }], [4, 's2', 'Bash', { command: 'other' }]]) {
    // Deliberately invert id and created_at order for rows 1/2: the example
    // pack expectation [1,2] below pins that this evidence-port path orders by
    // insertion row id, unlike the RuleContext reader's created_at ordering.
    const createdAt = id === 1 ? '2026-01-02T00:00:00.000Z' : '2026-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO tool_calls (id,session_id,tool_name,outcome,params_json,created_at) VALUES (?,?,?,?,?,?)').run(id, sessionId, name, 'success', JSON.stringify(params), createdAt);
  }
  db.prepare('INSERT INTO pain_events (session_id,source,score,canonical_pain_id,created_at) VALUES (?,?,?,?,?)').run('s1', 'manual', 5, 'original-pain', 'now');
  db.close(); return root;
}

function setupOrderingWorkspace(): { root: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ordering-char-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.state'));
  const db = new Database(path.join(root, '.state', 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.close();
  return { root, projectDir: path.resolve(root) };
}

function insertOrderingCall(db: Database.Database, input: {
  id: number;
  sessionId?: string;
  createdAt: string;
  projectDir?: string | null;
  toolUseId?: string;
  outcome?: string;
}): void {
  db.prepare(`INSERT INTO tool_calls (
    id, session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message,
    params_json, result_preview, created_at, project_dir, host_kind, tool_use_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    input.sessionId ?? 's-order',
    'Bash',
    input.outcome ?? 'success',
    null,
    input.outcome === 'failure' ? 1 : input.outcome === 'success' || input.outcome === undefined ? 0 : null,
    null,
    null,
    JSON.stringify({ command: `probe-${input.id}` }),
    null,
    input.createdAt,
    input.projectDir === undefined ? null : input.projectDir,
    'codex',
    input.toolUseId ?? `call-${input.id}`,
  );
}

function toolCallEvent(workspaceDir: string, toolOutput: unknown, overrides: Partial<HostEvent['context']> = {}): HostEvent {
  return {
    kind: 'after_tool_call',
    context: {
      workspaceDir,
      sessionId: 's-order',
      turnId: 'turn-order',
      toolName: 'Bash',
      toolInput: { command: 'probe live write' },
      toolOutput,
      ...overrides,
    },
    rawPayload: { host: 'ordering-characterization-fixture' },
    source: 'codex:post_tool_use',
  };
}

function readToolCalls(root: string, sql = 'SELECT * FROM tool_calls ORDER BY id'): Record<string, unknown>[] {
  const db = new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('PRI-992 real trajectory evidence port', () => {
  it('uses explicit labels, historical prefix and real Codex semantics without inferring labels from success', async () => {
    const root = setup(); const pack = await createWorkspaceBehaviorEvidencePort(root, semantics).assemble(selection);
    expect(validateBehaviorExamplePack(pack).valid).toBe(true);
    expect(pack.sourceNegativeCase.expectedDecision).toBe('block');
    expect(pack.positiveCounterexamples[0]?.expectedDecision).toBe('allow');
    expect(pack.sourceNegativeCase.ruleContext?.history.calls.map((r) => r.canonicalKind)).toEqual(['write', 'execute']);
    expect(pack.sourceNegativeCase.ruleContext?.history.calls.map((r) => r.sequenceId)).toEqual([1, 2]);
    expect(pack.evidenceRefs).toEqual(['pain:1', 'tool_call:3', 'tool_call:2']);
  });
  it('CLI resolves persisted Codex declarations through the same port', async () => {
    const root = setup();
    expect(saveHostToolDeclaration(root, { version: 1, hostKind: 'codex', mappings: [{ rawToolName: 'Bash', canonicalKind: 'execute' }, { rawToolName: 'apply_patch', canonicalKind: 'write' }], declaredAt: new Date().toISOString() }).ok).toBe(true);
    const pack = await createWorkspaceBehaviorEvidencePort(root).assemble(selection);
    expect(pack.sourceNegativeCase.ruleContext?.history.calls[1]?.canonicalKind).toBe('execute');
  });
  it('unknown host is an observable source fault rather than an OpenClaw guess', () => {
    const root = setup();
    expect(() => createWorkspaceBehaviorEvidencePort(root).assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
  });
  it.each([
    [{ ...selection, sourcePainId: 'stale-pain' }, 'pain_not_found'],
    [{ ...selection, positiveToolCallIds: [99] }, 'tool_call_not_found'],
    [{ ...selection, positiveToolCallIds: [4] }, 'session_mismatch'],
  ])('rejects stale/cross-session labels without a fabricated pack', (input, kind) => {
    const root = setup();
    expect(() => createWorkspaceBehaviorEvidencePort(root, semantics).assemble(input)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: kind }));
  });
  it.each(['{', 'null', '[]', '{"__proto__":{}}', '{"constructor":{}}', '{"prototype":{}}'])('malformed persisted selected params is a source fault: %s', (paramsJson) => {
    const root = setup();
    const db = new Database(path.join(root, '.state', 'trajectory.db'));
    db.prepare('UPDATE tool_calls SET params_json = ? WHERE id = ?').run(paramsJson, 3);
    db.close();
    expect(() => createWorkspaceBehaviorEvidencePort(root, semantics).assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
  });
  it('missing storage remains absent and corrupt storage is a source fault', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bep-missing-')); dirs.push(root);
    const port = createWorkspaceBehaviorEvidencePort(root, semantics);
    expect(() => port.assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
    expect(fs.existsSync(path.join(root, '.state'))).toBe(false);
    fs.mkdirSync(path.join(root, '.state')); fs.writeFileSync(path.join(root, '.state', 'trajectory.db'), 'corrupt');
    expect(() => port.assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
  });
});

describe('PRI-1308 ordering and verified-backfill characterization', () => {
  it('orders the reader-level visible window by created_at with id as tie-breaker, while separately detecting unscoped null rows', () => {
    const { root, projectDir } = setupOrderingWorkspace();
    const db = new Database(path.join(root, '.state', 'trajectory.db'));
    for (const row of [
      { id: 10, createdAt: '2026-03-01T10:03:00.000Z', projectDir },
      { id: 11, createdAt: '2026-03-01T10:01:00.000Z', projectDir },
      { id: 12, createdAt: '2026-03-01T10:02:00.000Z', projectDir },
      { id: 13, createdAt: '2026-03-01T10:02:00.000Z', projectDir },
      { id: 14, createdAt: '2026-03-01T10:04:00.000Z', projectDir },
      { id: 15, createdAt: '2026-03-01T10:00:00.000Z', projectDir: path.join(projectDir, 'other-project') },
      { id: 16, createdAt: '2026-03-01T10:00:00.000Z' },
    ]) {
      insertOrderingCall(db, row);
    }
    db.close();

    const result = readWorkspaceRuleContextRowsBefore(root, {
      sessionId: 's-order',
      projectDir,
      beforeCreatedAt: '2026-03-01T10:04:00.000Z',
      excludeToolUseId: 'current-call',
      limit: 100,
    });

    // SQL reads newest-first by created_at/id and the adapter reverses that
    // visible window. The tie at 10:02 therefore comes back in ascending id
    // order. This is database visibility ordering only, not causal ordering.
    expect(result.rows.map((row) => row.id)).toEqual([11, 12, 13, 10]);
    expect(result.rows.map((row) => row.id)).not.toContain(14);
    expect(result.rows.map((row) => row.id)).not.toContain(15);
    expect(result.rows.map((row) => row.id)).not.toContain(16);
    expect(result.unscopedPriorRows).toBe(true);
    // The NULL-scope row intentionally makes this reader-level ordering result
    // unusable by the production Codex provider, which fails closed with
    // trajectory_project_scope_incomplete. Visibility here is therefore not
    // the same thing as provider-usable history.
  });

  it('freezes late verified INSERT inversion and its project-scope invisibility', async () => {
    vi.useFakeTimers();
    const { root, projectDir } = setupOrderingWorkspace();
    // Fixture oracle only: in the scenario being characterized, action A is
    // the earlier real action. Its live hook never fired, so production first
    // writes B and only later transcript verification inserts A. No production
    // column records that oracle order.
    const scenarioOracleActionOrder = ['call-A', 'call-B'];
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir });

    vi.setSystemTime(new Date('2026-03-02T10:00:00.000Z'));
    await runtime.dispatch(toolCallEvent(root, { result: { exitCode: 0 } }, { toolCallId: 'call-B' }));
    vi.setSystemTime(new Date('2026-03-02T10:10:00.000Z'));
    const inserted = recordVerifiedToolOutcomes({
      workspaceDir: root,
      sessionId: 's-order',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'call-A', toolName: 'Bash', params: { command: 'probe verified A' }, exitCode: 1 }],
    });

    const rows = readToolCalls(root);
    const rowA = rows.find((row) => row.tool_use_id === 'call-A');
    const rowB = rows.find((row) => row.tool_use_id === 'call-B');
    expect(inserted).toEqual([{ status: 'inserted', id: rowA?.id }]);
    expect(rowA).toEqual(expect.objectContaining({
      outcome: 'failure',
      created_at: '2026-03-02T10:10:00.000Z',
      project_dir: null,
      host_kind: 'codex',
    }));
    expect(rowB).toEqual(expect.objectContaining({
      outcome: 'success',
      created_at: '2026-03-02T10:00:00.000Z',
      project_dir: projectDir,
    }));
    expect(Number(rowA?.id)).toBeGreaterThan(Number(rowB?.id));

    const visible = readWorkspaceRuleContextRowsBefore(root, {
      sessionId: 's-order',
      projectDir,
      beforeCreatedAt: '2026-03-02T10:20:00.000Z',
      excludeToolUseId: 'current-call',
      limit: 100,
    });
    const visibleIds = visible.rows.map((row) => row.id);

    expect(rows.map((row) => row.tool_use_id)).toEqual(['call-B', 'call-A']);
    expect(scenarioOracleActionOrder).toEqual(['call-A', 'call-B']);
    expect(visibleIds).toEqual([rowB?.id]);
    expect(visible.unscopedPriorRows).toBe(true);

    const provider = createCodexRuleContextProvider({
      workspaceDir: root,
      projectDir,
      enabled: true,
      cutoffAt: new Date('2026-03-02T10:20:00.000Z'),
      currentToolUseId: 'current-call',
      toolSemantics: semantics,
    });
    const context = provider({
      workspaceDir: root,
      sessionId: 's-order',
      targetPath: 'target.txt',
      toolName: 'Bash',
      rawPayload: { toolInput: { toolName: 'Bash', params: { command: 'echo next' } } },
    }) as { history: { status: string; unavailableReason?: string }; facts: { priorReadOfTarget: string; readCount: number | null } };
    expect(context.history).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'trajectory_project_scope_incomplete',
    });
    expect(context.facts).toMatchObject({ priorReadOfTarget: 'unknown', readCount: null });
    expect(readToolCalls(root, 'SELECT COUNT(*) AS n FROM tool_calls')[0]?.n).toBe(2);
  });

  it('freezes verified UPDATE in place and exposes later knowledge behind an earlier decision cutoff', async () => {
    vi.useFakeTimers();
    const { root, projectDir } = setupOrderingWorkspace();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir });

    vi.setSystemTime(new Date('2026-03-03T10:00:00.000Z'));
    await runtime.dispatch(toolCallEvent(root, 'probe raw A output', { toolCallId: 'call-A' }));
    vi.setSystemTime(new Date('2026-03-03T10:02:00.000Z'));
    await runtime.dispatch(toolCallEvent(root, { result: { exitCode: 0 } }, { toolCallId: 'call-B', toolInput: { command: 'probe live B' } }));

    const cutoffBeforeVerification = '2026-03-03T10:05:00.000Z';
    const readerInput = {
      sessionId: 's-order',
      projectDir,
      beforeCreatedAt: cutoffBeforeVerification,
      excludeToolUseId: 'current-call',
      limit: 100,
    };
    const beforeUpgradeRows = readWorkspaceRuleContextRowsBefore(root, readerInput);
    const beforeUpgradeHistory = assembleBehaviorHistory(beforeUpgradeRows.rows, beforeUpgradeRows.truncated, {
      projectDir,
      toolSemantics: semantics,
    });
    expect(beforeUpgradeHistory.status).toBe('unavailable');
    expect(beforeUpgradeHistory.unavailableReason).toContain('outcome "unknown" is not a valid RuleToolOutcome');

    const persistedBefore = readToolCalls(root, "SELECT * FROM tool_calls WHERE tool_use_id = 'call-A'")[0];
    vi.setSystemTime(new Date('2026-03-03T10:10:00.000Z'));
    const upgraded = recordVerifiedToolOutcomes({
      workspaceDir: root,
      sessionId: 's-order',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'call-A', toolName: 'Bash', exitCode: 1, outputPreview: 'verified A failure' }],
    });

    const persistedAfter = readToolCalls(root, "SELECT * FROM tool_calls WHERE tool_use_id = 'call-A'")[0];
    expect(upgraded).toEqual([{ status: 'updated', id: persistedBefore?.id }]);
    expect(persistedAfter).toEqual(expect.objectContaining({
      id: persistedBefore?.id,
      outcome: 'failure',
      exit_code: 1,
      created_at: persistedBefore?.created_at,
      project_dir: projectDir,
    }));
    expect(persistedAfter?.created_at).toBe('2026-03-03T10:00:00.000Z');
    expect(readToolCalls(root, "SELECT COUNT(*) AS n FROM tool_calls WHERE outcome = 'unknown'")[0]?.n).toBe(0);

    const afterUpgradeRows = readWorkspaceRuleContextRowsBefore(root, readerInput);
    const afterUpgradeHistory = assembleBehaviorHistory(afterUpgradeRows.rows, afterUpgradeRows.truncated, {
      projectDir,
      toolSemantics: semantics,
    });

    expect(afterUpgradeRows.rows.map((row) => row.id)).toEqual(beforeUpgradeRows.rows.map((row) => row.id));
    expect(afterUpgradeHistory.status).toBe('available');
    expect(afterUpgradeHistory.calls.map((call) => call.outcome)).toEqual(['failure', 'success']);
    // Hindsight-leakage characterization: the cutoff is before the 10:10
    // verification write, but the reader still returns the post-upgrade
    // failure because the UPDATE is in-place and created_at is unchanged.
    // Nothing in the final database state preserves the decision-time unknown.
    expect(afterUpgradeHistory.calls[0]?.outcome).toBe('failure');
  });

  it('freezes the legacy verified-writer project_dir migration gap that makes the scoped reader fail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ordering-legacy-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.state'));
    const db = new Database(path.join(root, '.state', 'trajectory.db'));
    db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
    db.close();

    const results = recordVerifiedToolOutcomes({
      workspaceDir: root,
      sessionId: 's-order',
      hostKind: 'codex',
      outcomes: [{ toolUseId: 'call-legacy-verified', toolName: 'Bash', exitCode: 1 }],
    });
    expect(results).toEqual([{ status: 'inserted', id: expect.any(Number) }]);

    const inspection = new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
    const columns = (inspection.prepare('PRAGMA table_info(tool_calls)').all() as Record<string, unknown>[]).map((column) => column.name);
    inspection.close();
    expect(columns).toContain('tool_use_id');
    expect(columns).toContain('host_kind');
    expect(columns).not.toContain('project_dir');

    expect(() => readWorkspaceRuleContextRowsBefore(root, {
      sessionId: 's-order',
      projectDir: path.resolve(root),
      beforeCreatedAt: '2026-03-05T10:05:00.000Z',
      excludeToolUseId: 'current-call',
      limit: 100,
    })).toThrow(/project_dir/);
  });

  it('does not manufacture causal-order or repeated-failure facts from row id and created_at', () => {
    const { root, projectDir } = setupOrderingWorkspace();
    const db = new Database(path.join(root, '.state', 'trajectory.db'));
    insertOrderingCall(db, { id: 20, createdAt: '2026-03-04T10:02:00.000Z', projectDir, outcome: 'failure' });
    insertOrderingCall(db, { id: 21, createdAt: '2026-03-04T10:01:00.000Z', projectDir, outcome: 'failure' });
    db.close();

    const visible = readWorkspaceRuleContextRowsBefore(root, {
      sessionId: 's-order',
      projectDir,
      beforeCreatedAt: '2026-03-04T10:05:00.000Z',
      excludeToolUseId: 'current-call',
      limit: 100,
    });
    const history = assembleBehaviorHistory(visible.rows, visible.truncated, {
      projectDir,
      toolSemantics: semantics,
    });

    expect(visible.rows.map((row) => row.id)).toEqual([21, 20]);
    expect(history.status).toBe('available');
    expect(history.calls.map((call) => call.sequenceId)).toEqual([21, 20]);
    expect(Object.keys(history.calls[0] ?? {}).sort()).toEqual([
      'canonicalKind',
      'normalizedPath',
      'outcome',
      'paramsSummary',
      'sequenceId',
      'toolName',
    ]);

    const facts = computeBehaviorFacts(history, null, null);
    const reversedFacts = computeBehaviorFacts({ ...history, calls: [...history.calls].reverse() }, null, null);
    expect(reversedFacts).toEqual(facts);
    expect(facts).toEqual({
      priorReadOfTarget: 'unknown',
      readCount: 0,
      writeCount: 0,
      uniqueWritePathCount: 0,
      sameActionBlockCount: null,
    });
    expect(Object.keys(facts)).not.toContain('repeatedFailure');
    expect(Object.keys(facts)).not.toContain('causalOrder');
  });
});
