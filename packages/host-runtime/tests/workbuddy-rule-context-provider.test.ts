/**
 * SPEC-RULECODE-HOST-PROMOTION-001 C — the WorkBuddy rule-context provider
 * over its OWN observable trajectory. Each fault class asserts the precise
 * unavailable reason (H08: distinguishable, never one opaque 'unavailable'),
 * and the provider never supplies a designGate fact (WorkBuddy has no
 * design-gate attestation entry point).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createWorkbuddyRuleContextProvider } from '../src/workbuddy-rule-context-provider.js';
import type { ProductionRuleContextRequest } from '../src/production-rulehost-gate.js';
import { WORKBUDDY_TOOL_SEMANTICS } from '../../workbuddy-adapter/src/tool-semantics.js';

let ws: string;
let project: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-wb-provider-'));
  project = mkdtempSync(path.join(tmpdir(), 'pd-wb-project-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const semantics = WORKBUDDY_TOOL_SEMANTICS;

function request(overrides: Partial<ProductionRuleContextRequest> = {}): ProductionRuleContextRequest {
  return {
    workspaceDir: ws,
    sessionId: 'wb-session-1',
    // The gate's action.normalizedPath is project-relative — mirror the real
    // ProductionRuleContextRequest shape so fact matching sees the same form
    // the history assembler produces.
    targetPath: 'a.ts',
    toolName: 'Write',
    rawPayload: { toolInput: { toolName: 'Write', params: { file_path: path.join(project, 'a.ts'), content: 'x' } } },
    ...overrides,
  };
}

function provider(overrides: Partial<Parameters<typeof createWorkbuddyRuleContextProvider>[0]> = {}) {
  return createWorkbuddyRuleContextProvider({
    workspaceDir: ws,
    projectDir: project,
    enabled: true,
    cutoffAt: new Date('2026-10-28T12:00:00.000Z'),
    currentToolCallId: 'call-99',
    toolSemantics: semantics,
    ...overrides,
  });
}

function trajectoryDb(options: { hostKindColumn?: boolean } = {}): Database.Database {
  mkdirSync(path.join(ws, '.state'), { recursive: true });
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  db.exec(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT${options.hostKindColumn === false ? '' : ', host_kind TEXT'})`);
  return db;
}

function insertToolCall(db: Database.Database, input: {
  sessionId?: string;
  toolName: string;
  outcome?: string;
  params: unknown;
  createdAt: string;
  toolUseId: string | null;
  projectDir: string | null;
  hostKind?: string | null;
}): number {
  const columns: unknown = db.prepare('PRAGMA table_info(tool_calls)').all();
  const hasHostKind = Array.isArray(columns) && columns.some((column) => typeof column === 'object' && column !== null && (column as { name?: unknown }).name === 'host_kind');
  const values = [
    input.sessionId ?? 'wb-session-1',
    input.toolName,
    input.outcome ?? 'success',
    JSON.stringify(input.params),
    input.createdAt,
    input.toolUseId,
    input.projectDir,
  ];
  const inserted = hasHostKind
    ? db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir, host_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...values, input.hostKind ?? null)
    : db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(...values);
  return Number(inserted.lastInsertRowid);
}

/** Seed trajectory rows attributed to `hostKind` (null = legacy unattributed row). */
function seedTrajectory(attribution: 'workbuddy' | 'codex' | null = 'workbuddy'): number[] {
  const db = trajectoryDb();
  const readId = insertToolCall(db, { toolName: 'Read', params: { file_path: path.join(project, 'a.ts') }, createdAt: '2026-10-28T11:00:00.000Z', toolUseId: 'call-1', projectDir: project, hostKind: attribution });
  const writeId = insertToolCall(db, { toolName: 'Write', params: { file_path: path.join(project, 'b.ts') }, createdAt: '2026-10-28T11:30:00.000Z', toolUseId: 'call-2', projectDir: project, hostKind: attribution });
  db.close();
  return [readId, writeId];
}

describe('createWorkbuddyRuleContextProvider (SPEC C/H08)', () => {
  it('returns the precise disabled reason when the rulecode_context_v2 flag is off', () => {
    const context = provider({ enabled: false })(request());
    expect(context).toMatchObject({ version: 2, history: { status: 'unavailable', unavailableReason: 'workbuddy_rule_context_disabled' } });
  });

  it('fails fast on an invalid session id before any history work', () => {
    const context = provider()(request({ sessionId: ' ' }));
    expect(context).toMatchObject({ history: { unavailableReason: 'session_id_invalid' } });
  });

  it('refuses a workspace other than the resolved governance workspace', () => {
    const context = provider()(request({ workspaceDir: project }));
    expect(context).toMatchObject({ history: { unavailableReason: 'workspace_scope_mismatch' } });
  });

  it('reports the precise missing-project-scope reason when the hook observed no cwd', () => {
    const context = createWorkbuddyRuleContextProvider({
      workspaceDir: ws,
      enabled: true,
      cutoffAt: new Date('2026-10-28T12:00:00.000Z'),
      currentToolCallId: 'call-99',
      toolSemantics: semantics,
    })(request());
    expect(context).toMatchObject({ history: { unavailableReason: 'workbuddy_project_scope_unavailable' } });
  });

  it('reports no-prior-history honestly for a session with no WorkBuddy trajectory rows (first managed write, H08)', () => {
    mkdirSync(path.join(ws, '.state'), { recursive: true });
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT)`);
    db.close();
    const context = provider()(request());
    expect(context).toMatchObject({ history: { unavailableReason: 'no_prior_session_history' } });
  });

  it('resolves an available context from WorkBuddy\'s own attributed rows — positive row identity, facts, and NO designGate fact', () => {
    const [readId, writeId] = seedTrajectory('workbuddy');
    const context = provider()(request()) as {
      version: number;
      history: { status: string; calls: readonly { sequenceId: number; toolName: string; canonicalKind: string; normalizedPath: string | null; outcome: string }[] };
      facts: Record<string, unknown>;
    };
    expect(context).toMatchObject({
      version: 2,
      history: { status: 'available' },
      facts: {
        priorReadOfTarget: 'yes',
        readCount: 1,
        writeCount: 1,
        uniqueWritePathCount: 1,
        sameActionBlockCount: null,
      },
    });
    expect(context.history.calls).toEqual([
      expect.objectContaining({ sequenceId: readId, toolName: 'Read', canonicalKind: 'read', normalizedPath: 'a.ts', outcome: 'success' }),
      expect.objectContaining({ sequenceId: writeId, toolName: 'Write', canonicalKind: 'write', normalizedPath: 'b.ts', outcome: 'success' }),
    ]);
    // WorkBuddy has no design-gate attestation entry — the provider must not
    // fabricate or borrow one (design_approval rules suspend upstream).
    expect(context.facts.designGate).toBeUndefined();
  });

  // ── Review finding 2 (P1): history rows must be PROVEN WorkBuddy's ──

  it('R2-red→green: a Codex-attributed session history must NEVER become WorkBuddy\'s priorReadOfTarget', () => {
    // The exact cross-host contamination scenario: same governance workspace,
    // same sessionId, same projectDir — but every row was produced by Codex.
    seedTrajectory('codex');
    const context = provider()(request());
    expect(context).toMatchObject({
      history: { status: 'unavailable', unavailableReason: 'workbuddy_history_attribution_conflict' },
      facts: { priorReadOfTarget: 'unknown' },
    });
  });

  it('R2-red→green: legacy rows with NO host attribution cannot pose as WorkBuddy history', () => {
    seedTrajectory(null);
    const context = provider()(request());
    expect(context).toMatchObject({
      history: { status: 'unavailable', unavailableReason: 'workbuddy_history_attribution_unprovable' },
      facts: { priorReadOfTarget: 'unknown' },
    });
  });

  it('R2: a workspace whose tool_calls predates the host_kind column entirely is also unprovable — never guessed', () => {
    mkdirSync(path.join(ws, '.state'), { recursive: true });
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT)`);
    db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('wb-session-1', 'Read', 'success', JSON.stringify({ file_path: path.join(project, 'a.ts') }), '2026-10-28T11:00:00.000Z', 'call-1', project);
    db.close();
    const context = provider()(request());
    expect(context).toMatchObject({ history: { status: 'unavailable', unavailableReason: 'workbuddy_history_attribution_unprovable' } });
  });

  it('mixed proven WorkBuddy rows plus even one legacy row are unprovable as a whole (never a partial count)', () => {
    seedTrajectory('workbuddy');
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    insertToolCall(db, {
      toolName: 'Read', params: { file_path: path.join(project, 'legacy-read.ts') },
      createdAt: '2026-10-28T11:15:00.000Z', toolUseId: 'legacy-call', projectDir: project, hostKind: null,
    });
    db.close();
    const context = provider()(request());
    expect(context).toMatchObject({
      history: { status: 'unavailable', unavailableReason: 'workbuddy_history_attribution_unprovable' },
      facts: {
        priorReadOfTarget: 'unknown', readCount: null, writeCount: null,
        uniqueWritePathCount: null, sameActionBlockCount: null,
      },
    });
  });

  it('an empty current call identity (the provider shape of a missing call_id/tool_use_id) is a scope mismatch before history is consumed', () => {
    seedTrajectory('workbuddy');
    const context = provider({ currentToolCallId: '' })(request());
    expect(context).toMatchObject({
      history: { status: 'unavailable', unavailableReason: 'workbuddy_pre_tool_scope_mismatch' },
      facts: {
        priorReadOfTarget: 'unknown', readCount: null, writeCount: null,
        uniqueWritePathCount: null, sameActionBlockCount: null,
      },
    });
  });

  it('one unscoped NULL-project row makes the same-session window incomplete even when scoped WorkBuddy rows exist', () => {
    seedTrajectory('workbuddy');
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    insertToolCall(db, {
      toolName: 'Read', params: { file_path: path.join(project, 'unscoped.ts') },
      createdAt: '2026-10-28T11:15:00.000Z', toolUseId: 'unscoped-call', projectDir: null, hostKind: 'workbuddy',
    });
    db.close();
    const context = provider()(request());
    expect(context).toMatchObject({
      history: { status: 'unavailable', unavailableReason: 'trajectory_project_scope_incomplete' },
      facts: {
        priorReadOfTarget: 'unknown', readCount: null, writeCount: null,
        uniqueWritePathCount: null, sameActionBlockCount: null,
      },
    });
  });

  it('exact project scope excludes a same-session WorkBuddy row from another project', () => {
    const [readId, writeId] = seedTrajectory('workbuddy');
    const otherProject = path.join(ws, 'other-project');
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    insertToolCall(db, {
      toolName: 'Read', params: { file_path: path.join(project, 'wrong-project-read.ts') },
      createdAt: '2026-10-28T11:15:00.000Z', toolUseId: 'wrong-project-call', projectDir: otherProject, hostKind: 'workbuddy',
    });
    db.close();
    const context = provider()(request()) as {
      history: { status: string; calls: readonly { sequenceId: number; toolName: string }[] };
      facts: { readCount: number | null; writeCount: number | null };
    };
    expect(context.history.status).toBe('available');
    expect(context.history.calls.map((call) => call.sequenceId)).toEqual([readId, writeId]);
    expect(context.facts).toMatchObject({ readCount: 1, writeCount: 1 });
  });

  it('a NULL stored tool_use_id cannot be excluded as the current call and therefore enters a later window', () => {
    const db = trajectoryDb();
    const nullIdRow = insertToolCall(db, {
      toolName: 'Read', params: { file_path: path.join(project, 'a.ts') },
      createdAt: '2026-10-28T11:00:00.000Z', toolUseId: null, projectDir: project, hostKind: 'workbuddy',
    });
    db.close();
    const context = provider()(request()) as {
      history: { status: string; calls: readonly { sequenceId: number; toolName: string; canonicalKind: string }[] };
      facts: { priorReadOfTarget: string; readCount: number | null };
    };
    // The reader's SQL is `(tool_use_id IS NULL OR tool_use_id <> ?)`: NULL is
    // never equal to the current id, so it is always history-eligible rather
    // than excludable as the in-flight call.
    expect(context.history.status).toBe('available');
    expect(context.history.calls).toEqual([
      expect.objectContaining({ sequenceId: nullIdRow, toolName: 'Read', canonicalKind: 'read' }),
    ]);
    expect(context.facts).toMatchObject({ priorReadOfTarget: 'yes', readCount: 1 });
  });

  it('excludes the current tool-call id independently of the strict exact-cutoff exclusion', () => {
    const [readId, writeId] = seedTrajectory('workbuddy');
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    insertToolCall(db, {
      toolName: 'Write', params: { file_path: path.join(project, 'current-before-cutoff.ts') },
      createdAt: '2026-10-28T11:59:59.999Z', toolUseId: 'call-99', projectDir: project, hostKind: 'workbuddy',
    });
    insertToolCall(db, {
      toolName: 'Write', params: { file_path: path.join(project, 'exact-cutoff.ts') },
      createdAt: '2026-10-28T12:00:00.000Z', toolUseId: 'call-at-cutoff', projectDir: project, hostKind: 'workbuddy',
    });
    insertToolCall(db, {
      toolName: 'Write', params: { file_path: path.join(project, 'after-cutoff.ts') },
      createdAt: '2026-10-28T12:00:00.001Z', toolUseId: 'call-after-cutoff', projectDir: project, hostKind: 'workbuddy',
    });
    db.close();
    const context = provider()(request()) as {
      history: { status: string; calls: readonly { sequenceId: number; normalizedPath: string | null }[] };
      facts: { writeCount: number | null; uniqueWritePathCount: number | null };
    };
    expect(context.history.status).toBe('available');
    expect(context.history.calls.map((call) => call.sequenceId)).toEqual([readId, writeId]);
    expect(context.history.calls.map((call) => call.normalizedPath)).toEqual(['a.ts', 'b.ts']);
    // Positive control: the one pre-cutoff non-current Write remains counted;
    // each exclusion is independently observable because the current-id row is
    // BEFORE the cutoff and the exact-cutoff row carries a different id.
    expect(context.facts).toMatchObject({ writeCount: 1, uniqueWritePathCount: 1 });
  });

  it('an execute row yields the full conservative facts posture, never partial counts or a fabricated no', () => {
    const db = trajectoryDb();
    const executeId = insertToolCall(db, {
      toolName: 'Bash', params: { command: 'npm test' },
      createdAt: '2026-10-28T11:00:00.000Z', toolUseId: 'call-1', projectDir: project, hostKind: 'workbuddy',
    });
    db.close();
    const context = provider()(request()) as {
      history: { status: string; calls: readonly { sequenceId: number; canonicalKind: string }[] };
      facts: Record<string, unknown>;
    };
    expect(context.history.status).toBe('available');
    expect(context.history.calls).toEqual([expect.objectContaining({ sequenceId: executeId, canonicalKind: 'execute' })]);
    expect(context.facts).toMatchObject({
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    });
  });

  it('an actual other-kind row yields the same full conservative facts posture even when its params name the target', () => {
    const db = trajectoryDb();
    const otherId = insertToolCall(db, {
      toolName: 'mcp__filesystem__read_text_file', params: { path: path.join(project, 'a.ts') },
      createdAt: '2026-10-28T11:00:00.000Z', toolUseId: 'call-other', projectDir: project, hostKind: 'workbuddy',
    });
    db.close();
    const context = provider()(request()) as {
      history: { status: string; calls: readonly { sequenceId: number; toolName: string; canonicalKind: string; normalizedPath: string | null }[] };
      facts: Record<string, unknown>;
    };
    expect(context.history.status).toBe('available');
    expect(context.history.calls).toEqual([
      expect.objectContaining({ sequenceId: otherId, toolName: 'mcp__filesystem__read_text_file', canonicalKind: 'other', normalizedPath: 'a.ts' }),
    ]);
    expect(context.facts).toMatchObject({
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    });
  });

  it('truncation retains the newest 100 rows in stored write/reader order and degrades every fact because the omitted tail is unknowable', () => {
    const db = trajectoryDb();
    const oldest = new Date('2026-10-28T09:00:00.000Z');
    let omittedReadId = -1;
    let firstRetainedId = -1;
    for (let index = 0; index < 101; index += 1) {
      const id = insertToolCall(db, {
        toolName: index === 0 ? 'Read' : 'Write',
        params: { file_path: path.join(project, index === 0 ? 'a.ts' : `write-${index}.ts`) },
        createdAt: new Date(oldest.getTime() + index * 60_000).toISOString(),
        toolUseId: `truncate-${index}`,
        projectDir: project,
        hostKind: 'workbuddy',
      });
      if (index === 0) omittedReadId = id;
      if (index === 1) firstRetainedId = id;
    }
    db.close();
    const context = provider()(request()) as {
      history: { status: string; truncated: boolean; calls: readonly { sequenceId: number; toolName: string }[] };
      facts: Record<string, unknown>;
    };
    expect(context.history).toMatchObject({ status: 'available', truncated: true });
    expect(context.history.calls).toHaveLength(100);
    expect(context.history.calls.some((call) => call.sequenceId === omittedReadId)).toBe(false);
    expect(context.history.calls[0]?.sequenceId).toBe(firstRetainedId);
    expect(context.facts).toMatchObject({
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    });
  });
});
