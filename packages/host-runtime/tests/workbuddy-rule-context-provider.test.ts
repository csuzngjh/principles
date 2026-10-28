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
import { buildToolSemanticRegistry } from '@principles/core/runtime-v2';
import { createWorkbuddyRuleContextProvider } from '../src/workbuddy-rule-context-provider.js';
import type { ProductionRuleContextRequest } from '../src/production-rulehost-gate.js';

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

const built = buildToolSemanticRegistry([{ rawToolName: 'Read', canonicalKind: 'read' }, { rawToolName: 'Bash', canonicalKind: 'execute' }, { rawToolName: 'Write', canonicalKind: 'write' }]);
if (!built.ok) throw new Error(`test registry failed: ${built.errors.join('; ')}`);

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
    toolSemantics: built.registry,
    ...overrides,
  });
}

function seedTrajectory(): void {
  mkdirSync(path.join(ws, '.state'), { recursive: true });
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  db.exec(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT)`);
  const insert = db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run('wb-session-1', 'Read', 'success', JSON.stringify({ file_path: path.join(project, 'a.ts') }), '2026-10-28T11:00:00.000Z', 'call-1', project);
  insert.run('wb-session-1', 'Write', 'success', JSON.stringify({ file_path: path.join(project, 'b.ts') }), '2026-10-28T11:30:00.000Z', 'call-2', project);
  db.close();
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
      toolSemantics: built.registry,
    })(request());
    expect(context).toMatchObject({ history: { unavailableReason: 'workbuddy_project_scope_unavailable' } });
  });

  it('reports no-prior-history honestly for a session with no WorkBuddy trajectory rows (first managed write, H08)', () => {
    mkdirSync(path.join(ws, '.state'), { recursive: true });
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT)`);
    db.close();
    const context = provider()(request());
    expect(context).toMatchObject({ history: { unavailableReason: 'no_prior_session_history' } });
  });

  it('resolves an available context from WorkBuddy\'s own trajectory rows — with facts computed and NO designGate fact', () => {
    seedTrajectory();
    const context = provider()(request());
    expect(context).toMatchObject({
      version: 2,
      history: { status: 'available' },
      facts: { priorReadOfTarget: 'yes', readCount: 1, writeCount: 1 },
    });
    // WorkBuddy has no design-gate attestation entry — the provider must not
    // fabricate or borrow one (design_approval rules suspend upstream).
    expect((context as { facts: Record<string, unknown> }).facts.designGate).toBeUndefined();
  });

  it('excludes the current tool call and rows at/after the cutoff from the history window', () => {
    seedTrajectory();
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('wb-session-1', 'Write', 'success', JSON.stringify({ file_path: path.join(project, 'c.ts') }), '2026-10-28T12:00:00.000Z', 'call-99', project);
    db.close();
    const context = provider()(request());
    // The seeded window (Read + Write before cutoff) stays; the current call
    // (call-99) and the at-cutoff row never enter.
    expect(context).toMatchObject({ history: { status: 'available' }, facts: { writeCount: 1 } });
  });

  it('marks facts unknown when the window contains execute/other-kind calls (partial semantic view)', () => {
    mkdirSync(path.join(ws, '.state'), { recursive: true });
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT)`);
    db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('wb-session-1', 'Bash', 'success', JSON.stringify({ command: 'npm test' }), '2026-10-28T11:00:00.000Z', 'call-1', project);
    db.close();
    const context = provider()(request());
    expect(context).toMatchObject({ history: { status: 'available' }, facts: { priorReadOfTarget: 'unknown', readCount: null } });
  });
});
