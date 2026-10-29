/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 4 (P2): the governance
 * signal admission entry (`admitGovernanceSignals`) must apply host-scoped
 * dedup on REAL SQLite — the real admission entry with real candidates, never
 * hand-SQL-only proofs. Covers the two dedup queries the Round-3 change made
 * host-scoped (tool-call-id join + content-shape fallback) plus legacy NULL
 * rows, cross-host collisions, and same-host idempotency.
 *
 * Note on shape: admission candidates are host-typed (`hostKind: 'codex'` for
 * tool failures); cross-host collisions are modeled by seeding the OTHER
 * host's durable row (what the WorkBuddy live writer produces in a shared
 * workspace) and admitting a Codex candidate with the same natural identity.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyTrajectorySchemaBase } from '@principles/core/runtime-v2';
import { admitGovernanceSignals } from '../src/governance-signal-admission.js';
import type { GovernanceSignalCandidate } from '../src/governance-signal-admission.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-r4-admission-'));
  mkdirSync(path.join(ws, '.state'), { recursive: true });
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.close();
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function codexCandidate(sessionId: string, toolUseId: string): GovernanceSignalCandidate {
  return {
    kind: 'tool_failure',
    hostKind: 'codex',
    logicalObservationKey: `obs-${sessionId}-${toolUseId}`,
    rolloutIdentity: `rollout-${sessionId}`,
    rootSessionId: sessionId,
    hostTurnId: `turn-${toolUseId}`,
    toolName: 'write_file',
    source: 'codex:post_tool_use',
    toolCallId: toolUseId,
    toolUseId,
    // A risky absolute path outside the workspace pushes the pain score over the strong floor so the candidate is genuinely admitted.
    toolInput: { file_path: '/etc/evil.txt', content: 'x' },
    toolOutput: { exitCode: 1, error: 'severe write failure: disk full' },
    observedAt: '2026-10-29T10:00:00.000Z',
  };
}

interface Row { id: number; session_id: string; outcome: string; tool_use_id: string | null; host_kind: string | null }

function toolCallsRows(sessionId: string): Row[] {
  const db = new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, session_id, outcome, tool_use_id, host_kind FROM tool_calls WHERE session_id = ? ORDER BY id').all(sessionId) as Row[];
  } finally {
    db.close();
  }
}

function seedForeignOrLegacyRow(sessionId: string, toolUseId: string, hostKind: string | null): void {
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, tool_use_id, project_dir, host_kind) VALUES (?, 'write_file', 'unknown', '{}', '2026-10-29T09:00:00.000Z', ?, NULL, ?)`).run(sessionId, toolUseId, hostKind);
  db.close();
}

describe('admitGovernanceSignals — host-scoped dedup on real SQLite (R4/P2)', () => {
  it('a Codex candidate is admitted with its host stamp', () => {
    const result = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-a', 'call-1')] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes[0]).toMatchObject({ disposition: 'admitted' });
    const all = toolCallsRows('sess-a');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ host_kind: 'codex', outcome: 'failure', tool_use_id: 'call-1' });
  });

  it('same-host duplicate delivery stays idempotent (no second row)', () => {
    admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-idem', 'call-1')] });
    const second = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-idem', 'call-1')] });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.outcomes[0]).toMatchObject({ disposition: 'already_admitted' });
    expect(toolCallsRows('sess-idem')).toHaveLength(1);
  });

  it('cross-host collision: a WorkBuddy-stamped row with the same session/call is NOT matched by a Codex candidate — records stay independent', () => {
    seedForeignOrLegacyRow('sess-x', 'call-1', 'workbuddy');
    const result = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-x', 'call-1')] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes[0]).toMatchObject({ disposition: 'admitted' });
    const all = toolCallsRows('sess-x');
    expect(all).toHaveLength(2);
    expect(all.find(row => row.host_kind === 'workbuddy')).toMatchObject({ outcome: 'unknown' });
    expect(all.find(row => row.host_kind === 'codex')).toMatchObject({ outcome: 'failure' });
  });

  it('a legacy host_kind=NULL row with the same identity is never claimed — the admitted record lands beside it', () => {
    seedForeignOrLegacyRow('sess-legacy', 'call-1', null);
    const result = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-legacy', 'call-1')] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes[0]).toMatchObject({ disposition: 'admitted' });
    const all = toolCallsRows('sess-legacy');
    expect(all).toHaveLength(2);
    expect(all.find(row => row.host_kind === null)).toMatchObject({ outcome: 'unknown' });
    expect(all.find(row => row.host_kind === 'codex')).toMatchObject({ outcome: 'failure' });
  });

  it('the content-shape fallback dedup is host-scoped too: same content from the other host does not swallow the candidate', () => {
    seedForeignOrLegacyRow('sess-content', 'call-other', 'workbuddy');
    // Same failure content as the candidate produces; different call id, so
    // only the content-shape fallback could match.
    const result = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-content', 'call-1')] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes[0]).toMatchObject({ disposition: 'admitted' });
    const all = toolCallsRows('sess-content');
    expect(all.filter(row => row.host_kind === 'workbuddy')).toHaveLength(1);
    expect(all.filter(row => row.host_kind === 'codex')).toHaveLength(1);
  });

  it('terminal protection: an existing same-host final row means the candidate is a duplicate (no new row, no overwrite)', () => {
    seedForeignOrLegacyRow('sess-final', 'call-1', 'codex');
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.prepare(`UPDATE tool_calls SET outcome = 'failure' WHERE session_id = 'sess-final' AND tool_use_id = 'call-1'`).run();
    db.close();
    const result = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-final', 'call-1')] });
    expect(result.ok).toBe(true);
    // Honest production semantics: a final same-host row WITHOUT its admitted
    // pain refuses re-admission (duplicate_tool_call_without_admitted_pain) —
    // the candidate can never overwrite or duplicate the existing fact.
    if (result.ok) {
      const first = result.outcomes[0] as { disposition: string; reason?: string };
      expect(first.disposition === 'not_admitted' || first.disposition === 'already_admitted').toBe(true);
      if (first.disposition === 'not_admitted') expect(first.reason).toBe('duplicate_tool_call_without_admitted_pain');
    }
    const all = toolCallsRows('sess-final');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'failure', host_kind: 'codex' });
  });

  it('unknown → final-state upgrades stay on the verified-outcome path (same-host), never inside admission', () => {
    // Seed a same-host UNKNOWN row (the live PostToolUse writer's shape), then
    // admit the same failure: admission dedups by identity without mutating
    // the unknown row — the UPGRADE belongs to recordVerifiedToolOutcomes
    // (covered by recovery-dedup + codex ingestion suites).
    seedForeignOrLegacyRow('sess-upgrade', 'call-1', 'codex');
    const result = admitGovernanceSignals({ workspaceDir: ws, candidates: [codexCandidate('sess-upgrade', 'call-1')] });
    expect(result.ok).toBe(true);
    const all = toolCallsRows('sess-upgrade');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'unknown', host_kind: 'codex' });
  });
});
