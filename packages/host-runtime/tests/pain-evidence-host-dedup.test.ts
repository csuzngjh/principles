/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 4 (P2): host attribution must
 * hold on the REAL production pain-evidence write path — the actual
 * `createProductionPainEvidenceHandler` against a real SQLite trajectory
 * store (applyTrajectorySchemaBase schema), covering BOTH dedup routes the
 * Round-3 change made host-scoped (tool-call-id join + content-shape
 * fallback). No hand-SQL-only assertions: every scenario drives the real
 * handler and reads the rows back.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyTrajectorySchemaBase } from '@principles/core/runtime-v2';
import { createProductionPainEvidenceHandler } from '../src/production-pain-evidence.js';

let ws: string;
let handlerWorkbuddy: (event: never) => Promise<unknown>;
let handlerCodex: (event: never) => Promise<unknown>;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-r4-pain-'));
  mkdirSync(path.join(ws, '.state'), { recursive: true });
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.close();
  handlerWorkbuddy = createProductionPainEvidenceHandler({ hostKind: 'workbuddy', projectDir: ws }) as unknown as (event: never) => Promise<unknown>;
  handlerCodex = createProductionPainEvidenceHandler({ hostKind: 'codex', projectDir: ws }) as unknown as (event: never) => Promise<unknown>;
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

interface Row { id: number; session_id: string; tool_name: string; outcome: string; tool_use_id: string | null; host_kind: string | null; params_json: string }

function rows(sessionId: string): Row[] {
  const db = new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, session_id, tool_name, outcome, tool_use_id, host_kind, params_json FROM tool_calls WHERE session_id = ? ORDER BY id').all(sessionId) as Row[];
  } finally {
    db.close();
  }
}

function toolEvent(host: 'workbuddy' | 'codex', overrides: Record<string, unknown> = {}): never {
  return {
    kind: 'after_tool_call',
    context: {
      workspaceDir: ws,
      sessionId: overrides.sessionId ?? `sess-${host}`,
      toolName: overrides.toolName ?? 'Read',
      ...(overrides.toolCallId !== undefined ? { toolCallId: overrides.toolCallId } : {}),
      toolOutput: overrides.toolOutput ?? { result: { rendered: true } },
      turnId: overrides.turnId,
    },
    source: `test:${host}`,
  } as never;
}

describe('production pain-evidence handler — host-scoped dedup on real SQLite (R4/P2)', () => {
  it('two hosts sharing one session and toolCallId keep INDEPENDENT records (no swallowing)', async () => {
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-collide', toolCallId: 'call-1' }));
    await handlerCodex(toolEvent('codex', { sessionId: 'sess-collide', toolCallId: 'call-1' }));
    const all = rows('sess-collide');
    expect(all).toHaveLength(2);
    expect(all.find(row => row.host_kind === 'workbuddy')).toMatchObject({ tool_use_id: 'call-1', outcome: 'success' });
    expect(all.find(row => row.host_kind === 'codex')).toMatchObject({ tool_use_id: 'call-1', outcome: 'success' });
  });

  it('two hosts delivering the SAME content shape (no tool id) do not cross-host swallow via the content dedup', async () => {
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-content' }));
    await handlerCodex(toolEvent('codex', { sessionId: 'sess-content' }));
    const all = rows('sess-content');
    expect(all).toHaveLength(2);
    expect(all.filter(row => row.host_kind === 'workbuddy')).toHaveLength(1);
    expect(all.filter(row => row.host_kind === 'codex')).toHaveLength(1);
  });

  it('same-host duplicate delivery of one call stays idempotent (the existing contract)', async () => {
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-idem', toolCallId: 'call-1' }));
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-idem', toolCallId: 'call-1' }));
    expect(rows('sess-idem')).toHaveLength(1);
  });

  it('same host, same call id, DIFFERENT content: the tool-call-id identity wins — one row, facts not overwritten', async () => {
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-same-call', toolCallId: 'call-1', toolOutput: { result: { rendering: 'first' } } }));
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-same-call', toolCallId: 'call-1', toolOutput: { result: { rendering: 'second' } } }));
    const all = rows('sess-same-call');
    expect(all).toHaveLength(1);
    expect(all[0]?.host_kind).toBe('workbuddy');
  });

  it('a legacy host_kind=NULL row with the same identity is never claimed — the new attributed record lands beside it', async () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir, host_kind) VALUES ('sess-legacy', 'Read', 'unknown', '{}', '2026-10-29T00:00:00.000Z', 'call-1', NULL, NULL)`).run();
    db.close();
    await handlerWorkbuddy(toolEvent('workbuddy', { sessionId: 'sess-legacy', toolCallId: 'call-1' }));
    const all = rows('sess-legacy');
    expect(all).toHaveLength(2);
    expect(all.find(row => row.host_kind === null)).toMatchObject({ outcome: 'unknown', tool_use_id: 'call-1' });
    expect(all.find(row => row.host_kind === 'workbuddy')).toMatchObject({ outcome: 'success', tool_use_id: 'call-1' });
  });

  it('known-host writes stamp host_kind on every durable row', async () => {
    await handlerCodex(toolEvent('codex', { sessionId: 'sess-stamp', toolCallId: 'call-1' }));
    const all = rows('sess-stamp');
    expect(all).toHaveLength(1);
    expect(all[0]?.host_kind).toBe('codex');
  });
});
