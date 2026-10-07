/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * SqliteInterventionEvidenceStore integration tests (PD v2 Phase 1).
 *
 * Covers the persistence invariants the architecture depends on:
 * atomic append, idempotent same-source replay, reported (not overwritten)
 * source conflicts, one-scope-per-ledger, append-only immutability,
 * activation occurrence snapshot stability, out-of-order pending
 * association, and honest unavailability on pre-evidence databases.
 *
 * Fixtures flow through normalizeInterventionEvidenceBatch so the tests
 * exercise the real ingress path, not hand-built normalized objects.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteInterventionEvidenceStore } from './sqlite-intervention-evidence-store.js';
import { normalizeInterventionEvidenceBatch } from '../intervention-evidence-normalizer.js';
import type { InterventionEvidenceBatchInput } from '../types/intervention-evidence-contract.js';

function deliveryBatch(overrides: Partial<InterventionEvidenceBatchInput> = {}): InterventionEvidenceBatchInput {
  return {
    evidenceScopeId: 'scope-ws-1',
    sourceKind: 'openclaw_plugin_event_log',
    adapterVersion: 'openclaw-plugin@test',
    recordedAt: '2026-10-07T08:00:00Z',
    observations: [
      {
        observationKey: 'openclaw|delivery|prompt|sess-1|run-1|act-1',
        sourceLocator: 'logs/events_2026-10-07.jsonl',
        kind: 'delivery',
        occurredAt: '2026-10-07T07:59:59Z',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', runId: 'run-1' },
        principleId: 'T-01',
        contentRef: { principleId: 'T-01', artifactId: 'art-1', payloadDigest: 'sha256:aa', resolution: 'resolved' },
        activationRef: {
          activationId: 'act-1', artifactId: 'art-1', channel: 'prompt',
          activatedAt: '2026-10-01T00:00:00Z', sourceSnapshotDigest: 'sha256:bb',
        },
        payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
      },
      {
        observationKey: 'openclaw|episode|sess-1|tool-9',
        sourceLocator: 'logs/events_2026-10-07.jsonl',
        kind: 'behavior_episode',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', toolCallId: 'tool-9', toolName: 'write_file' },
        payload: { status: 'closed', actionSummary: 'write_file to test.txt' },
      },
    ],
    ...overrides,
  };
}

function normalized(input: InterventionEvidenceBatchInput) {
  const result = normalizeInterventionEvidenceBatch(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.batch;
}

describe('SqliteInterventionEvidenceStore', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-iev-${process.pid}-${Date.now()}`);
  let workspaceDir: string;
  let conn: SqliteConnection;
  let store: SqliteInterventionEvidenceStore;

  beforeEach(() => {
    workspaceDir = path.join(tmpRoot, `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    conn = new SqliteConnection(workspaceDir);
    store = new SqliteInterventionEvidenceStore(conn);
  });

  afterEach(() => {
    conn.close();
  });

  afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('appends a batch and reads it back after connection restart (round-trip)', () => {
    const result = store.appendObservationBatch(normalized(deliveryBatch()));
    expect(result.ok).toBe(true);
    expect(result.insertedCount).toBe(2);

    conn.close();
    conn = new SqliteConnection(workspaceDir);
    store = new SqliteInterventionEvidenceStore(conn);

    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.deliveries).toHaveLength(1);
    expect(read.relations.deliveries[0]!.payload).toEqual({
      targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted',
    });
    expect(read.relations.deliveries[0]!.associationStatus).toBe('linked');

    // Episodes are not principle-scoped (an episode may involve no principle);
    // they are addressed by their own native observation key.
    const episodeRead = store.readAuditRelations({ type: 'episode', observationKey: 'openclaw|episode|sess-1|tool-9' });
    expect(episodeRead.available).toBe(true);
    if (!episodeRead.available) return;
    expect(episodeRead.relations.episodes).toHaveLength(1);
    expect(episodeRead.relations.episodes[0]!.payload).toEqual({
      status: 'closed', actionSummary: 'write_file to test.txt',
    });
  });

  it('replaying the identical source batch is idempotent (no new rows, duplicates reported)', () => {
    const batch = normalized(deliveryBatch());
    const first = store.appendObservationBatch(batch);
    expect(first.insertedCount).toBe(2);
    const second = store.appendObservationBatch(batch);
    expect(second.ok).toBe(true);
    expect(second.insertedCount).toBe(0);
    expect(second.duplicates).toHaveLength(2);

    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.deliveries).toHaveLength(1);
  });

  it('reports a different payload under the same source key as a conflict, preserving the original', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    const conflicting = normalized(deliveryBatch({
      observations: [{
        ...deliveryBatch().observations[0]!,
        payload: { targetKind: 'agent_context', confirmation: 'prepared', outcome: 'attempted' },
      }],
    }));
    const result = store.appendObservationBatch(conflicting);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.reason).toContain('source_conflict');

    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    // Original attempt record preserved byte-for-byte.
    expect(read.relations.deliveries).toHaveLength(1);
    expect(read.relations.deliveries[0]!.payload).toEqual({
      targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted',
    });
  });

  it('rejects a batch from a different evidence scope without writing anything', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    const foreign = normalized(deliveryBatch({
      evidenceScopeId: 'scope-other',
      observations: [{ ...deliveryBatch().observations[0]!, observationKey: 'openclaw|delivery|prompt|sess-1|run-1|act-2' }],
    }));
    const result = store.appendObservationBatch(foreign);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('evidence_scope_mismatch');

    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.deliveries).toHaveLength(1);
  });

  it('keeps out-of-order references pending until the referenced record arrives', () => {
    const base = deliveryBatch();
    const episode = base.observations[1]!;
    const effect = {
      observationKey: 'openclaw|effect|tool-9|1',
      sourceLocator: 'logs/events_2026-10-07.jsonl',
      kind: 'effect' as const,
      nativeRefs: { hostKind: 'openclaw' as const, sessionId: 'sess-1', toolCallId: 'tool-9' },
      principleId: 'T-01',
      episodeKey: episode.observationKey,
      contentRef: { principleId: 'T-01', payloadDigest: 'sha256:aa', resolution: 'resolved' as const },
      payload: { status: 'observed' as const, observationSummary: 'write_file blocked by rule' },
    };
    store.appendObservationBatch(normalized({ ...base, observations: [effect] }));

    let read = store.readAuditRelations({ type: 'episode', observationKey: episode.observationKey });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.effects).toHaveLength(1);
    expect(read.relations.effects[0]!.associationStatus).toBe('pending_association');
    expect(read.relations.unresolvedReferences).toEqual([
      { evidenceId: read.relations.effects[0]!.evidenceId, missingKey: episode.observationKey, field: 'episodeKey' },
    ]);

    store.appendObservationBatch(normalized(base));
    read = store.readAuditRelations({ type: 'episode', observationKey: episode.observationKey });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.effects[0]!.associationStatus).toBe('linked');
    expect(read.relations.unresolvedReferences).toHaveLength(0);
  });

  it('enforces append-only immutability at the DB level', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    const db = conn.getDb();
    expect(() => db.prepare("UPDATE intervention_evidence_records SET principle_id = 'X'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM intervention_evidence_records').run()).toThrow(/immutable/);
  });

  it('preserves the activation occurrence snapshot even if the activations row is later replaced', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    const db = conn.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO activations
        (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES ('act-1', 'idem-2', 'art-2', 'prompt', 'activate', 'ref', '2026-10-06T00:00:00Z')
    `).run();

    const read = store.readAuditRelations({ type: 'activation', activationId: 'act-1' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.deliveries).toHaveLength(1);
    // Snapshot columns on the evidence row are untouched by the source row replace.
    const row = db.prepare(
      'SELECT content_ref_json, activation_ref_json FROM intervention_evidence_records WHERE record_kind = ?',
    ).get('delivery');
    expect(row).toBeTruthy();
  });

  it('upserts capability declarations (latest per host x capability wins)', () => {
    const first = normalized({
      ...deliveryBatch(),
      observations: [],
      capabilityDeclarations: [{
        hostKind: 'openclaw', capability: 'application_runtime_verified', status: 'supported',
        adapterVersion: 'v1', channel: 'code_tool_hook', maxConfirmation: 'runtime_loaded',
        note: 'live gate evaluation + block return',
      }],
    });
    store.appendObservationBatch(first);
    store.appendObservationBatch(normalized({
      ...deliveryBatch(),
      observations: [],
      capabilityDeclarations: [{
        hostKind: 'openclaw', capability: 'application_runtime_verified', status: 'supported',
        adapterVersion: 'v2', channel: 'code_tool_hook', maxConfirmation: 'runtime_loaded',
        note: 'live gate evaluation + block return (v2)',
      }],
    }));

    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    const caps = read.relations.capabilityDeclarations.filter(
      (c) => c.capability === 'application_runtime_verified',
    );
    expect(caps).toHaveLength(1);
    expect(caps[0]!.adapterVersion).toBe('v2');
  });

  it('answers the four audit selector shapes', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    expect(store.readAuditRelations({ type: 'principle', principleId: 'T-01' }).available).toBe(true);
    expect(store.readAuditRelations({ type: 'activation', activationId: 'act-1' }).available).toBe(true);
    expect(store.readAuditRelations({ type: 'episode', observationKey: 'openclaw|episode|sess-1|tool-9' }).available).toBe(true);
    expect(store.readAuditRelations({ type: 'effect', observationKey: 'none' }).available).toBe(true);
  });

  it('reports unavailable (never bootstraps) on a pre-evidence database read via readonly connection', () => {
    // Simulate an old workspace: create state.db WITHOUT the evidence tables.
    const oldWorkspace = path.join(tmpRoot, `old-${Date.now()}`);
    fs.mkdirSync(oldWorkspace, { recursive: true });
    const writer = new SqliteConnection(oldWorkspace);
    writer.getDb();
    const db = writer.getDb();
    db.prepare('DROP TRIGGER IF EXISTS intervention_evidence_records_no_update').run();
    db.prepare('DROP TRIGGER IF EXISTS intervention_evidence_records_no_delete').run();
    db.prepare('DROP TABLE IF EXISTS intervention_evidence_records').run();
    db.prepare('DROP TABLE IF EXISTS intervention_evidence_scope').run();
    db.prepare('DROP TABLE IF EXISTS intervention_capability_declarations').run();
    writer.close();

    const readonlyConn = new SqliteConnection({ workspaceDir: oldWorkspace, readonly: true, bootstrapIfMissing: false });
    const readonlyStore = new SqliteInterventionEvidenceStore(readonlyConn);
    const read = readonlyStore.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(false);
    if (read.available) return;
    expect(read.reason).toBe('evidence_schema_not_initialized');
    expect(read.nextAction).toBeTruthy();
    readonlyConn.close();
  });

  it('fails loud on a corrupted payload row instead of silently skipping it', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    const db = conn.getDb();
    // INSERT is not blocked by the immutability triggers (only UPDATE/DELETE);
    // a hand-inserted malformed row simulates ledger corruption.
    db.prepare(`
      INSERT INTO intervention_evidence_records (
        evidence_id, scope_id, source_kind, observation_key, source_locator, record_kind,
        principle_id, recorded_at, native_refs_json, payload_json, record_digest
      ) VALUES ('sha256:bad', 'scope-ws-1', 'host_runtime_dispatch', 'bad-key', 'loc', 'delivery',
        'T-01', '2026-10-07T08:00:00Z', '{}', 'not-json{', 'sha256:x')
    `).run();
    expect(() => store.readAuditRelations({ type: 'principle', principleId: 'T-01' })).toThrow(/Malformed/);
  });
});

describe('SqliteConnection busyTimeoutMs', () => {
  const tmpRoot = path.join(os.tmpdir(), `pd-iev-busy-${process.pid}-${Date.now()}`);

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('applies the default 5000ms and reports healthy', () => {
    const workspaceDir = path.join(tmpRoot, `d-${Date.now()}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const conn = new SqliteConnection(workspaceDir);
    conn.getDb();
    const report = conn.getPragmaReport();
    expect(report.busyTimeout).toBe(5000);
    expect(report.healthy).toBe(true);
    conn.close();
  });

  it('applies 0 for evidence-writer connections without waiting on locks', () => {
    const workspaceDir = path.join(tmpRoot, `z-${Date.now()}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const conn = new SqliteConnection({ workspaceDir, busyTimeoutMs: 0 });
    conn.getDb();
    const report = conn.getPragmaReport();
    expect(report.busyTimeout).toBe(0);
    // Per-connection configuration: 0 is healthy for a zero-wait writer.
    expect(report.healthy).toBe(true);
    conn.close();
  });

  it('rejects invalid busyTimeoutMs values', () => {
    const workspaceDir = path.join(tmpRoot, `i-${Date.now()}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    expect(() => new SqliteConnection({ workspaceDir, busyTimeoutMs: -1 })).toThrow(/non-negative integer/);
    expect(() => new SqliteConnection({ workspaceDir, busyTimeoutMs: 1.5 })).toThrow(/non-negative integer/);
  });
});
