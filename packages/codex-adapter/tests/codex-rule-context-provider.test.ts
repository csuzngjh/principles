import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createCodexRuleContextProvider } from '../../host-runtime/src/codex-rule-context-provider.js';
import { CODEX_TOOL_SEMANTICS } from '../src/tool-semantics.js';

const roots: string[] = [];
const cutoff = new Date('2026-10-18T12:00:00.000Z');

function workspace(): { workspaceDir: string; projectDir: string; db: Database.Database } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-rule-context-'));
  roots.push(workspaceDir);
  const projectDir = workspaceDir;
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.exec(`CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    project_dir TEXT,
    outcome TEXT NOT NULL,
    params_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  return { workspaceDir, projectDir, db };
}

function addCall(db: Database.Database, input: {
  sessionId: string; projectDir: string | null; toolName?: string; toolUseId?: string; outcome?: string; params?: unknown; createdAt: string;
}): void {
  db.prepare('INSERT INTO tool_calls (session_id, tool_name, tool_use_id, project_dir, outcome, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.sessionId, input.toolName ?? 'read_file', input.toolUseId ?? `call-${input.sessionId}-${input.createdAt}`, input.projectDir, input.outcome ?? 'success', JSON.stringify(input.params ?? { file_path: 'target.txt' }), input.createdAt);
}

function request(workspaceDir: string, projectDir: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceDir,
    sessionId: 'session-current',
    targetPath: 'target.txt',
    toolName: 'Bash',
    rawPayload: { toolInput: { toolName: 'Bash', params: { command: 'echo next' } }, ...overrides },
  };
}

function provider(workspaceDir: string, projectDir: string, enabled = true) {
  return createCodexRuleContextProvider({
    workspaceDir,
    projectDir,
    enabled,
    toolSemantics: CODEX_TOOL_SEMANTICS,
    cutoffAt: cutoff,
    currentToolUseId: 'current-call',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex RuleContextV2 history provider', () => {
  it('reads only prior same-session rows and does not infer a missing file-read from Codex Bash', () => {
    const { workspaceDir, projectDir, db } = workspace();
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      toolUseId: 'prior-call',
      toolName: 'Bash',
      params: { command: `cat ${path.join(projectDir, 'target.txt')}` },
      createdAt: '2026-10-18T11:00:00.000Z',
    });
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      toolUseId: 'current-call',
      toolName: 'Bash',
      params: { command: `cat ${path.join(projectDir, 'target.txt')}` },
      createdAt: '2026-10-18T11:59:59.999Z',
    });
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      toolName: 'Bash',
      params: { command: `cat ${path.join(projectDir, 'target.txt')}` },
      createdAt: '2026-10-18T13:00:00.000Z',
    });
    addCall(db, {
      sessionId: 'other-session',
      projectDir,
      toolName: 'Bash',
      params: { command: `cat ${path.join(projectDir, 'target.txt')}` },
      createdAt: '2026-10-18T10:00:00.000Z',
    });
    addCall(db, {
      sessionId: 'session-current',
      projectDir: path.join(workspaceDir, 'another-project'),
      toolName: 'apply_patch',
      params: { file_path: 'target.txt' },
      createdAt: '2026-10-18T10:30:00.000Z',
    });
    db.close();

    const context = provider(workspaceDir, projectDir)(request(workspaceDir, projectDir)) as {
      history: { status: string; calls: readonly { toolName: string }[] };
      facts: { priorReadOfTarget: string; readCount: number | null };
    };
    expect(context.history.status).toBe('available');
    expect(context.history.calls).toHaveLength(1);
    expect(context.history.calls[0]?.toolName).toBe('Bash');
    expect(context.facts).toMatchObject({ priorReadOfTarget: 'unknown', readCount: null, writeCount: null });
  });

  it('keeps missing history and unreadable storage unavailable with unknown facts', () => {
    const { workspaceDir, projectDir, db } = workspace();
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      createdAt: '2026-10-18T13:00:00.000Z',
    });
    db.close();

    const history = provider(workspaceDir, projectDir)(request(workspaceDir, projectDir)) as {
      history: { status: string; unavailableReason?: string };
      facts: { priorReadOfTarget: string; readCount: number | null };
    };
    expect(history.history.status).toBe('unavailable');
    expect(history.history.unavailableReason).toBe('no_prior_session_history');
    expect(history.facts).toMatchObject({ priorReadOfTarget: 'unknown', readCount: null });

    const missingWorkspace = path.join(workspaceDir, 'missing');
    const failed = provider(missingWorkspace, projectDir)(request(missingWorkspace, projectDir)) as {
      history: { status: string; unavailableReason?: string };
      facts: { priorReadOfTarget: string; readCount: number | null };
    };
    expect(failed.history.status).toBe('unavailable');
    expect(failed.history.unavailableReason).toContain('trajectory_history_unavailable:');
    expect(failed.facts).toMatchObject({ priorReadOfTarget: 'unknown', readCount: null });
  });

  it('keeps same-session history unavailable when legacy rows have no verified project scope', () => {
    const { workspaceDir, projectDir, db } = workspace();
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      toolName: 'apply_patch',
      params: { file_path: 'target.txt' },
      createdAt: '2026-10-18T11:00:00.000Z',
    });
    addCall(db, {
      sessionId: 'session-current',
      projectDir: null,
      toolName: 'apply_patch',
      params: { file_path: 'target.txt' },
      createdAt: '2026-10-18T11:30:00.000Z',
    });
    db.close();

    const context = provider(workspaceDir, projectDir)(request(workspaceDir, projectDir)) as {
      history: { status: string; unavailableReason?: string };
      facts: { priorReadOfTarget: string; writeCount: number | null };
    };
    expect(context.history.status).toBe('unavailable');
    expect(context.history.unavailableReason).toBe('trajectory_project_scope_incomplete');
    expect(context.facts).toMatchObject({ priorReadOfTarget: 'unknown', writeCount: null });
  });

  it('does not turn an omitted older read or partial counts into negative absence facts', () => {
    const { workspaceDir, projectDir, db } = workspace();
    const oldest = new Date('2026-10-18T10:00:00.000Z');
    for (let index = 0; index < 101; index += 1) {
      const isOldestRead = index === 0;
      addCall(db, {
        sessionId: 'session-current',
        projectDir,
        toolName: isOldestRead ? 'read_file' : 'apply_patch',
        params: isOldestRead
          ? { file_path: path.join(projectDir, 'target.txt') }
          : { file_path: path.join(projectDir, `other-${index}.txt`) },
        createdAt: new Date(oldest.getTime() + index * 60_000).toISOString(),
      });
    }
    db.close();

    const context = provider(workspaceDir, projectDir)(request(workspaceDir, projectDir)) as {
      history: { status: string; truncated: boolean; calls: readonly unknown[] };
      facts: { priorReadOfTarget: string; readCount: number | null; writeCount: number | null; uniqueWritePathCount: number | null };
    };
    expect(context.history).toMatchObject({ status: 'available', truncated: true });
    expect(context.history.calls).toHaveLength(100);
    expect(context.facts).toMatchObject({
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
    });
  });

  it('keeps target-read and exact action facts unknown when history contains an undeclared host tool', () => {
    const { workspaceDir, projectDir, db } = workspace();
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      toolName: 'mcp__filesystem__read_text_file',
      params: { path: path.join(projectDir, 'target.txt') },
      createdAt: '2026-10-18T11:00:00.000Z',
    });
    db.close();

    const context = provider(workspaceDir, projectDir)(request(workspaceDir, projectDir)) as {
      history: { status: string; calls: readonly { canonicalKind: string }[] };
      facts: { priorReadOfTarget: string; readCount: number | null; writeCount: number | null; uniqueWritePathCount: number | null; sameActionBlockCount: number | null };
    };
    expect(context.history.status).toBe('available');
    expect(context.history.calls[0]?.canonicalKind).toBe('other');
    expect(context.facts).toMatchObject({
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    });
  });

  it('does not turn an unrecognized persisted outcome into a successful call', () => {
    const { workspaceDir, projectDir, db } = workspace();
    addCall(db, {
      sessionId: 'session-current',
      projectDir,
      toolName: 'Bash',
      outcome: 'maybe',
      params: { command: `cat ${path.join(projectDir, 'target.txt')}` },
      createdAt: '2026-10-18T11:00:00.000Z',
    });
    db.close();

    const context = provider(workspaceDir, projectDir)(request(workspaceDir, projectDir)) as {
      history: { status: string };
      facts: { priorReadOfTarget: string; readCount: number | null };
    };
    expect(context.history.status).toBe('unavailable');
    expect(context.facts).toMatchObject({ priorReadOfTarget: 'unknown', readCount: null });
  });

  it('requires the existing context and ingestion gates plus matching workspace/project/session identity', () => {
    const { workspaceDir, projectDir, db } = workspace();
    addCall(db, { sessionId: 'session-current', projectDir, createdAt: '2026-10-18T11:00:00.000Z' });
    db.close();
    const enabled = provider(workspaceDir, projectDir);

    const disabled = provider(workspaceDir, projectDir, false)(request(workspaceDir, projectDir)) as { history: { status: string } };
    const wrongPayload = enabled(request(workspaceDir, projectDir, { toolInput: { toolName: 'not-Bash', params: {} } })) as { history: { status: string } };
    expect(disabled.history.status).toBe('unavailable');
    expect(wrongPayload.history.status).toBe('unavailable');
  });
});
