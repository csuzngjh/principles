import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GOVERNANCE_RETENTION_MAX_TURNS,
  ingestGovernanceObservations,
  listGovernanceObservations,
  promoteGovernanceEvidence,
  readGovernanceCheckpoint,
  type GovernanceObservationInput,
} from '../src/governance-observation-store.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-store-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-29T12:00:00.000Z');

function observation(overrides: Partial<GovernanceObservationInput> & { logicalObservationKey: string; kind: GovernanceObservationInput['kind']; hostTurnId: string }): GovernanceObservationInput {
  return {
    hostKind: 'codex',
    rolloutIdentity: 'rollout-uuid-1',
    rootSessionId: 'root-session-1',
    hostTurnId: overrides.hostTurnId,
    kind: overrides.kind,
    logicalObservationKey: overrides.logicalObservationKey,
    source: 'transcript',
    completeness: 'complete',
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function ingest(input: Parameters<typeof ingestGovernanceObservations>[0]) {
  return ingestGovernanceObservations({ ...input, workspaceDir: input.workspaceDir ?? workspaceDir, now: input.now ?? NOW });
}

describe('governance observation store — schema and idempotency', () => {
  it('creates the governance tables in an existing trajectory.db and reports versioned state', () => {
    const result = ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'hello world' })] });
    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(1);
    const listed = listGovernanceObservations({ workspaceDir });
    expect(listed.ok && listed.observations).toHaveLength(1);
  });

  it('degrades explicitly when the workspace has no trajectory.db', () => {
    fs.rmSync(path.join(workspaceDir, '.state', 'trajectory.db'));
    const result = ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user' })] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('trajectory_db_not_found');
  });

  it('exact replay is idempotent through both the logical and the physical key', () => {
    const obs = [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'hello', transcriptRecordKey: 'codex|rollout-uuid-1|8' })];
    expect(ingest({ observations: obs })).toMatchObject({ ok: true, inserted: 1 });
    const replay = ingest({ observations: obs });
    expect(replay).toMatchObject({ ok: true, inserted: 0, enriched: 0, duplicates: 1 });
    const listed = listGovernanceObservations({ workspaceDir });
    expect(listed.ok && listed.observations).toHaveLength(1);
  });

  it('a different logical key reusing one physical record key is a duplicate, not a second row', () => {
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', transcriptRecordKey: 'codex|rollout-uuid-1|8' })] })).toMatchObject({ ok: true });
    const second = ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user-alt', transcriptRecordKey: 'codex|rollout-uuid-1|8' })] });
    expect(second).toMatchObject({ ok: true, inserted: 0, duplicates: 1 });
  });
});

describe('live + transcript convergence (SPEC §10 source precedence)', () => {
  it('a live user observation is enriched, not duplicated, by the transcript replay', () => {
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'fix the login bug', source: 'live_hook' })] })).toMatchObject({ ok: true, inserted: 1 });
    const replay = ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'fix the login bug', transcriptRecordKey: 'codex|rollout-uuid-1|8' })] });
    expect(replay).toMatchObject({ ok: true, inserted: 0, enriched: 1 });
    const listed = listGovernanceObservations({ workspaceDir });
    expect(listed.ok && listed.observations).toHaveLength(1);
    if (listed.ok) {
      expect(listed.observations[0]?.transcriptRecordKey).toBe('codex|rollout-uuid-1|8');
      expect(listed.observations[0]?.source).toBe('transcript');
    }
  });

  it('the reverse ordering (transcript first, live later) is also one logical observation', () => {
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'same text', transcriptRecordKey: 'codex|rollout-uuid-1|8' })] })).toMatchObject({ ok: true });
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'same text', source: 'live_hook' })] })).toMatchObject({ ok: true, inserted: 0 });
    const listed = listGovernanceObservations({ workspaceDir });
    expect(listed.ok && listed.observations).toHaveLength(1);
  });

  it('a live tool observation converges with the transcript by tool_use_id (facts never conflict)', () => {
    expect(ingest({ observations: [observation({ kind: 'tool_call', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|exec-abc', toolUseId: 'exec-abc', toolFacts: { toolName: 'Bash', params: { command: 'npm test' }, result: { exitCode: 1 } }, source: 'live_hook' })] })).toMatchObject({ ok: true, inserted: 1 });
    const replay = ingest({ observations: [observation({ kind: 'tool_call', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|exec-abc', toolUseId: 'exec-abc', transcriptToolCallId: 'call_xyz', transcriptRecordKey: 'codex|rollout-uuid-1|13', toolFacts: { exitCode: 1, stdout: 'failed' } })] });
    expect(replay).toMatchObject({ ok: true, inserted: 0, enriched: 1 });
    const listed = listGovernanceObservations({ workspaceDir });
    if (listed.ok) {
      expect(listed.observations).toHaveLength(1);
      expect(listed.observations[0]?.transcriptToolCallId).toBe('call_xyz');
      expect(listed.observations[0]?.transcriptRecordKey).toBe('codex|rollout-uuid-1|13');
    }
  });

  it('a user content mismatch for one logical key is a lineage conflict: first content kept, partial, checkpoint stopped', () => {
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'original words', source: 'live_hook' })] })).toMatchObject({ ok: true });
    const conflict = ingest({
      observations: [observation({ kind: 'user_turn', hostTurnId: 't2', logicalObservationKey: 'codex|rollout-uuid-1|t2|user', visibleText: 'fine' })],
      checkpoint: { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', byteOffset: 500, lastOrdinal: 9, cliVersion: '0.150.1', rootSessionId: 'root-session-1', incompleteTail: false },
    });
    expect(conflict.ok).toBe(true);
    const conflicted = ingest({
      observations: [
        observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'DIFFERENT words', transcriptRecordKey: 'codex|rollout-uuid-1|8', recordByteStart: 120 }),
        observation({ kind: 'user_turn', hostTurnId: 't3', logicalObservationKey: 'codex|rollout-uuid-1|t3|user', visibleText: 'after conflict' }),
      ],
      checkpoint: { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', byteOffset: 900, lastOrdinal: 12, cliVersion: '0.150.1', rootSessionId: 'root-session-1', incompleteTail: false },
    });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.reason).toBe('logical_key_content_conflict');
    expect(conflicted.checkpointCommitted).toBe(false);
    const listed = listGovernanceObservations({ workspaceDir });
    if (listed.ok) {
      const conflictedRow = listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t1|user');
      expect(conflictedRow?.completeness).toBe('partial');
      expect(conflictedRow?.visibleText).toBe('original words');
      expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t3|user')).toBeUndefined();
    }
    const checkpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1' });
    expect(checkpoint && 'byteOffset' in checkpoint ? checkpoint.byteOffset : null).toBe(500);
  });
});

describe('bounded retention (SPEC §11)', () => {
  it('keeps only the latest 32 conversational turns per rollout — a multi-observation turn consumes one slot', () => {
    const observations: GovernanceObservationInput[] = [];
    for (let index = 0; index < 40; index += 1) {
      observations.push(observation({ kind: 'user_turn', hostTurnId: `t${index}`, logicalObservationKey: `codex|rollout-uuid-1|t${index}|user`, visibleText: `user ${index}` }));
      observations.push(observation({ kind: 'assistant_turn', hostTurnId: `t${index}`, logicalObservationKey: `codex|rollout-uuid-1|t${index}|msg-${index}`, assistantItemId: `msg-${index}`, visibleText: `assistant ${index}` }));
    }
    expect(ingest({ observations })).toMatchObject({ ok: true, inserted: 80 });
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    const live = listed.observations.filter((row) => row.retentionClass === 'operational');
    const turns = new Set(live.map((row) => row.hostTurnId));
    expect(turns.size).toBe(GOVERNANCE_RETENTION_MAX_TURNS);
    expect([...turns].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
      Array.from({ length: GOVERNANCE_RETENTION_MAX_TURNS }, (_, i) => `t${i + 8}`),
    );
    // Expired rows keep identity but never the message text.
    const expired = listed.observations.filter((row) => row.retentionClass === 'expired');
    expect(expired.length).toBeGreaterThan(0);
    for (const row of expired) {
      expect(row.visibleText).toBeNull();
      expect(row.hostTurnId).toMatch(/^t\d+$/);
    }
  });

  it('unpromoted content older than 7 days expires even within the 32-turn window', () => {
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'old words', observedAt: old })] })).toMatchObject({ ok: true, inserted: 1 });
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations[0]?.retentionClass).toBe('expired');
    expect(listed.observations[0]?.visibleText).toBeNull();
  });

  it('promoted evidence survives operational pruning', () => {
    const observations: GovernanceObservationInput[] = [];
    for (let index = 0; index < 40; index += 1) {
      observations.push(observation({ kind: 'user_turn', hostTurnId: `t${index}`, logicalObservationKey: `codex|rollout-uuid-1|t${index}|user`, visibleText: `user ${index}`, observedAt: new Date(NOW.getTime() - (40 - index) * 60_000).toISOString() }));
    }
    expect(ingest({ observations })).toMatchObject({ ok: true });
    // The latest turn is inside the retained 32-turn window; promoting it
    // must shield it from later pruning.
    const promotion = promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t39|user', painRef: 'pain-e2e-ref-1', now: NOW });
    expect(promotion.ok).toBe(true);
    // A later pruning pass (any subsequent ingest) must not expire it.
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't40', logicalObservationKey: 'codex|rollout-uuid-1|t40|user', visibleText: 'newest' })] })).toMatchObject({ ok: true });
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    const trigger = listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t39|user');
    expect(trigger?.retentionClass).toBe('promoted');
    expect(trigger?.visibleText).toBe('user 39');
    expect(trigger?.promotionRef).toBe('pain-e2e-ref-1');
    // Promoting an already-expired observation keeps it a tombstone: expired
    // bodies are gone by design (SPEC §11) and never resurrected.
    const expiredPromotion = promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t0|user', painRef: 'pain-e2e-ref-2', now: NOW });
    expect(expiredPromotion.ok).toBe(true);
    const expiredRow = listGovernanceObservations({ workspaceDir });
    if (expiredRow.ok) {
      const t0 = expiredRow.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t0|user');
      expect(t0?.retentionClass).toBe('promoted');
      expect(t0?.visibleText).toBeNull();
    }
  });
});

describe('promotion substrate (SPEC §11/§18)', () => {
  const seedTurns = (count: number, options: { lastAssistant?: boolean } = {}) => {
    const observations: GovernanceObservationInput[] = [];
    for (let index = 0; index < count; index += 1) {
      observations.push(observation({ kind: 'user_turn', hostTurnId: `t${index}`, logicalObservationKey: `codex|rollout-uuid-1|t${index}|user`, visibleText: `user ${index}` }));
      const includeAssistant = index < count - 1 || options.lastAssistant !== false;
      if (includeAssistant) {
        observations.push(observation({ kind: 'assistant_turn', hostTurnId: `t${index}`, logicalObservationKey: `codex|rollout-uuid-1|t${index}|msg-${index}`, assistantItemId: `msg-${index}`, phase: 'final_answer', visibleText: `answer ${index}` }));
      }
    }
    return ingest({ observations });
  };

  it('promotes at most 12 preceding turns + trigger + existing next assistant turn', () => {
    expect(seedTurns(16)).toMatchObject({ ok: true });
    // Trigger on the turn-5 user observation: 5 preceding turns exist, and
    // turn 5's own completed assistant answer is the "next assistant turn".
    const result = promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t5|user', painRef: 'pain-ref-1', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tailState).toBe('completed');
      // 5 preceding turns × 2 rows + trigger + turn-5 assistant = 12
      expect(result.promoted).toBe(12);
    }
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    // All 5 preceding turns (t0..t4) are inside the 12-turn window.
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t0|user')?.retentionClass).toBe('promoted');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t4|msg-4')?.retentionClass).toBe('promoted');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t5|msg-5')?.retentionClass).toBe('promoted');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t6|msg-6')?.retentionClass).toBe('operational');
  });

  it('caps the preceding window at 12 turns even when more exist', () => {
    expect(seedTurns(30)).toMatchObject({ ok: true });
    const result = promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t29|user', painRef: 'pain-ref-window', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.promoted).toBe(12 * 2 + 2);
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t29|user')?.retentionClass).toBe('promoted');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t17|user')?.retentionClass).toBe('promoted');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t16|user')?.retentionClass).toBe('operational');
  });

  it('records a durable pending tail when the next assistant turn does not exist yet', () => {
    // Turn 2's assistant answer was never written (turn cut off mid-flight).
    expect(seedTurns(3, { lastAssistant: false })).toMatchObject({ ok: true });
    const result = promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t2|user', painRef: 'pain-ref-2', now: NOW });
    expect(result.ok && result.tailState).toBe('pending');
  });

  it('crash/restart completes the pending tail exactly once when the next assistant turn arrives', () => {
    expect(seedTurns(3, { lastAssistant: false })).toMatchObject({ ok: true });
    expect(promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t2|user', painRef: 'pain-ref-3', now: NOW }).ok && true).toBe(true);
    // Restart: a fresh store instance ingests the completed assistant turn
    // for the trigger's own turn (it did not exist at promotion time).
    const afterRestart = ingest({
      rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', rootSessionId: 'root-session-1' },
      observations: [observation({ kind: 'assistant_turn', hostTurnId: 't2', logicalObservationKey: 'codex|rollout-uuid-1|t2|msg-2', assistantItemId: 'msg-2', phase: 'final_answer', visibleText: 'the awaited answer' })],
    });
    expect(afterRestart.ok).toBe(true);
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    const tail = listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t2|msg-2');
    expect(tail?.retentionClass).toBe('promoted');
    expect(tail?.promotionRef).toBe('pain-ref-3');
    // Replaying the same delivery is exactly-once: the promoted set for this
    // pain reference never grows beyond trigger + window + tail.
    const replay = ingest({
      observations: [observation({ kind: 'assistant_turn', hostTurnId: 't3', logicalObservationKey: 'codex|rollout-uuid-1|t3|msg-3', assistantItemId: 'msg-3', phase: 'final_answer', visibleText: 'a later turn' })],
    });
    expect(replay.ok).toBe(true);
    const listedAgain = listGovernanceObservations({ workspaceDir });
    if (!listedAgain.ok) throw new Error('list failed');
    const promotedForPain = listedAgain.observations.filter((row) => row.promotionRef === 'pain-ref-3');
    expect(promotedForPain.map((row) => row.logicalKey).sort()).toEqual([
      'codex|rollout-uuid-1|t0|msg-0',
      'codex|rollout-uuid-1|t0|user',
      'codex|rollout-uuid-1|t1|msg-1',
      'codex|rollout-uuid-1|t1|user',
      'codex|rollout-uuid-1|t2|msg-2',
      'codex|rollout-uuid-1|t2|user',
    ]);
    expect(listedAgain.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t3|msg-3')?.retentionClass).toBe('operational');
  });

  it('a pending tail older than the stale horizon becomes an explicit diagnosable state', () => {
    expect(seedTurns(3, { lastAssistant: false })).toMatchObject({ ok: true });
    expect(promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t2|user', painRef: 'pain-ref-4', now: NOW }).ok && true).toBe(true);
    const muchLater = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    // Any later ingest ages the still-unresolved tail into the stale state.
    const laterIngest = ingest({ observations: [], now: muchLater });
    expect(laterIngest.ok).toBe(true);
    const staleCheck = promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', triggerLogicalKey: 'codex|rollout-uuid-1|t2|user', painRef: 'pain-ref-4', now: muchLater });
    expect(staleCheck.ok).toBe(false);
    if (!staleCheck.ok) expect(staleCheck.reason).toBe('promotion_tail_stale');
  });
});

describe('compaction and rollback markers (G1 §6)', () => {
  it('a compaction marker tombstones prior unpromoted observations without keeping text', () => {
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'before compaction', observedAt: '2026-08-29T11:00:00.000Z' })] })).toMatchObject({ ok: true });
    const result = ingest({
      rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', rootSessionId: 'root-session-1' },
      observations: [observation({ kind: 'user_turn', hostTurnId: 't2', logicalObservationKey: 'codex|rollout-uuid-1|t2|user', visibleText: 'after compaction', observedAt: '2026-08-29T11:02:00.000Z' })],
      compactionTimestamp: '2026-08-29T11:01:00.000Z',
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('compaction_marker_applied');
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t1|user')?.retentionClass).toBe('rolled_back');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t1|user')?.visibleText).toBeNull();
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t2|user')?.retentionClass).toBe('operational');
  });

  it('a rollback marker tombstones the last N logical turns', () => {
    const observations: GovernanceObservationInput[] = [];
    for (let index = 0; index < 4; index += 1) {
      observations.push(observation({ kind: 'user_turn', hostTurnId: `t${index}`, logicalObservationKey: `codex|rollout-uuid-1|t${index}|user`, visibleText: `user ${index}` }));
    }
    expect(ingest({ observations })).toMatchObject({ ok: true });
    const result = ingest({
      rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', rootSessionId: 'root-session-1' },
      observations: [],
      rollbackTurns: [2],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('rollback_marker_applied:2');
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t0|user')?.retentionClass).toBe('operational');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t1|user')?.retentionClass).toBe('operational');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t2|user')?.retentionClass).toBe('rolled_back');
    expect(listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t3|user')?.retentionClass).toBe('rolled_back');
  });
});

describe('checkpoint durability', () => {
  it('commits the checkpoint only in the transaction with its observations and records degradations', () => {
    const result = ingest({
      observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user' })],
      checkpoint: { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', byteOffset: 4242, lastOrdinal: 17, cliVersion: '0.150.1', rootSessionId: 'root-session-1', incompleteTail: false },
      degradations: [{ reason: 'transcript_record_malformed', ordinal: 18 }],
    });
    expect(result.checkpointCommitted).toBe(true);
    const checkpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1' });
    expect(checkpoint && 'byteOffset' in checkpoint ? checkpoint : null).toMatchObject({
      byteOffset: 4242,
      lastOrdinal: 17,
      cliVersion: '0.150.1',
      incompleteTail: false,
      lastDegradationReason: 'transcript_record_malformed',
      lastDegradationOrdinal: 18,
    });
  });

  it('sanitizes persisted evidence with the shared sanitizer contract', () => {
    expect(ingest({ observations: [observation({ kind: 'user_turn', hostTurnId: 't1', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', visibleText: 'my token is sk-abcdefghijklmnopqrstuvwxyz123456 keep it' })] })).toMatchObject({ ok: true });
    const listed = listGovernanceObservations({ workspaceDir });
    if (!listed.ok) throw new Error('list failed');
    expect(listed.observations[0]?.visibleText).toContain('___REDACTED___');
    expect(listed.observations[0]?.visibleText).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });
});
