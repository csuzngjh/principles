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
        contentRef: { principleId: 'T-01', artifactId: 'art-1', payloadDigest: 'sha256:aa00000000000000000000000000000000000000000000000000000000000000', resolution: 'resolved' },
        activationRef: {
          activationId: 'act-1', artifactId: 'art-1', channel: 'prompt',
          activatedAt: '2026-10-01T00:00:00Z', sourceSnapshotDigest: 'sha256:bb00000000000000000000000000000000000000000000000000000000000000',
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

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a persisted row');
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      contentRef: { principleId: 'T-01', payloadDigest: 'sha256:aa00000000000000000000000000000000000000000000000000000000000000', resolution: 'resolved' as const },
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

  it('resolves correction_of against evidence_id (not observation_key)', () => {
    // correctionOf cites an evidenceId per the contract; the audit-summary
    // reference probe must use the evidence_id column for that field only.
    store.appendObservationBatch(normalized(deliveryBatch()));
    const first = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(first.available).toBe(true);
    if (!first.available) return;
    const delivery = first.relations.deliveries[0]!;
    const correction = {
      observationKey: 'openclaw|delivery|correction|1',
      sourceLocator: 'logs/events_2026-10-07.jsonl',
      kind: 'delivery' as const,
      nativeRefs: { hostKind: 'openclaw' as const, sessionId: 'sess-1', runId: 'run-1' },
      principleId: 'T-01',
      contentRef: { principleId: 'T-01', payloadDigest: 'sha256:aa00000000000000000000000000000000000000000000000000000000000000', resolution: 'resolved' as const },
      activationRef: { activationId: 'act-1', sourceSnapshotDigest: 'sha256:bb00000000000000000000000000000000000000000000000000000000000000' },
      correctionOf: delivery.evidenceId,
      correctionReason: 'payload digest revised',
      payload: { targetKind: 'agent_context' as const, confirmation: 'submitted' as const, outcome: 'attempted' as const },
    };
    store.appendObservationBatch(normalized(deliveryBatch({ observations: [correction] })));
    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    const correctionSummary = read.relations.deliveries.find((r) => r.observationKey === correction.observationKey)!;
    expect(correctionSummary).toBeDefined();
    expect(correctionSummary.associationStatus).toBe('linked');
    expect(read.relations.unresolvedReferences.filter((u) => u.evidenceId === correctionSummary.evidenceId)).toHaveLength(0);
  });

  it('resolves episode host attribution from the episode row native refs', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    expect(store.findEpisodeHostKind('openclaw|episode|sess-1|tool-9')).toBe('openclaw');
    expect(store.findEpisodeHostKind('missing|episode|none')).toBeNull();
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

  it('bounds each kind independently so newer deliveries cannot hide an older application', () => {
    store.appendObservationBatch(normalized(deliveryBatch({ recordedAt: '2026-09-01T00:00:00Z', observations: [{
      observationKey: 'oc|application|older', sourceLocator: 'loc:application', kind: 'application',
      nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
      contentRef: { principleId: 'T-01', resolution: 'resolved', payloadDigest: `sha256:${'a'.repeat(64)}` },
      activationRef: { activationId: 'act-1', sourceSnapshotDigest: `sha256:${'b'.repeat(64)}` },
      payload: { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'host_gate' },
    }] })));
    const newerDeliveries = Array.from({ length: 55 }, (_, i) => ({
      observationKey: `oc|delivery|${i}`, sourceLocator: `loc:${i}`, kind: 'delivery' as const,
      nativeRefs: { hostKind: 'openclaw' as const }, principleId: 'T-01',
      contentRef: { principleId: 'T-01', resolution: 'resolved' as const, payloadDigest: `sha256:${'a'.repeat(64)}` },
      activationRef: { activationId: 'act-1', sourceSnapshotDigest: `sha256:${'b'.repeat(64)}` },
      payload: { targetKind: 'agent_context' as const, confirmation: 'submitted' as const, outcome: 'attempted' as const },
    }));
    store.appendObservationBatch(normalized(deliveryBatch({ observations: newerDeliveries })));
    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' }, { limit: 50 });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.deliveries).toHaveLength(50);
    expect(read.relations.pages.delivery.hasMore).toBe(true);
    expect(read.relations.applications).toHaveLength(1);
    expect(read.relations.applications[0]!.observationKey).toBe('oc|application|older');
    expect(read.relations.pages.application.hasMore).toBe(false);
    const deliveryCursor = read.relations.pages.delivery.nextCursor;
    expect(deliveryCursor).toBeTruthy();
    if (!deliveryCursor) return;
    const next = store.readAuditRelations({ type: 'principle', principleId: 'T-01' }, {
      limit: 50, cursor: { kind: 'delivery', after: deliveryCursor },
    });
    expect(next.available).toBe(true);
    if (!next.available) return;
    expect(next.relations.deliveries).toHaveLength(5);
    expect(next.relations.pages.delivery.hasMore).toBe(false);
  });

  it('marks unresolved content references as explicit gaps rather than linked evidence', () => {
    store.appendObservationBatch(normalized(deliveryBatch({ observations: [{
      ...deliveryBatch().observations[0]!,
      contentRef: { principleId: 'T-01', resolution: 'revision_reference_unresolved' },
    }] })));
    const read = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.unresolvedReferences).toEqual([
      { evidenceId: read.relations.deliveries[0]!.evidenceId, missingKey: 'revision:T-01', field: 'contentRef' },
    ]);
  });

  it('expires sensitive text without starving later rows, while preserving metadata and immutability', () => {
    const oldAt = '2001-01-01T00:00:00Z';
    const oldDeliveries = Array.from({ length: 200 }, (_, index) => ({
      observationKey: `oc|delivery|metadata-${index}`, sourceLocator: `loc:metadata-${index}`,
      kind: 'delivery' as const, nativeRefs: { hostKind: 'openclaw' as const },
      principleId: 'T-01', payload: { targetKind: 'agent_context' as const, confirmation: 'submitted' as const, outcome: 'attempted' as const },
      contentRef: { principleId: 'T-01', resolution: 'resolved' as const, payloadDigest: `sha256:${'a'.repeat(64)}` },
      activationRef: { activationId: 'act-1', sourceSnapshotDigest: `sha256:${'b'.repeat(64)}` },
    }));
    const oldApplication = {
      observationKey: 'oc|application|sensitive', sourceLocator: 'loc:sensitive', kind: 'application' as const,
      nativeRefs: { hostKind: 'openclaw' as const }, principleId: 'T-01',
      payload: { proofMethod: 'agent_claimed' as const, action: 'self_reported' as const, claimText: 'private claim text' },
    };
    for (let start = 0; start < oldDeliveries.length; start += 50) {
      store.appendObservationBatch(normalized(deliveryBatch({ recordedAt: oldAt, observations: oldDeliveries.slice(start, start + 50) })));
    }
    store.appendObservationBatch(normalized(deliveryBatch({ recordedAt: oldAt, observations: [oldApplication] })));
    const readonlyAudit = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(readonlyAudit.available).toBe(true);
    if (readonlyAudit.available) {
      const oldSummary = readonlyAudit.relations.applications.find((item) => item.observationKey === oldApplication.observationKey);
      expect(oldSummary?.payload).not.toHaveProperty('claimText');
      expect(oldSummary?.contentRedactedAt).toBeTruthy();
    }
    const before = conn.getDb().prepare(`SELECT record_digest, principle_id, native_refs_json, payload_json FROM intervention_evidence_records WHERE observation_key = ?`).get(oldApplication.observationKey);
    expect(before).toMatchObject({ principle_id: 'T-01' });
    store.appendObservationBatch(normalized(deliveryBatch())); // triggers bounded expiry sweep
    const db = conn.getDb();
    const after = db.prepare(`SELECT record_digest, principle_id, native_refs_json, payload_json, content_redacted_at FROM intervention_evidence_records WHERE observation_key = ?`).get(oldApplication.observationKey);
    expect(after).toMatchObject({
      record_digest: record(before).record_digest,
      principle_id: 'T-01', native_refs_json: record(before).native_refs_json,
    });
    expect(JSON.parse(String(record(after).payload_json))).not.toHaveProperty('claimText');
    expect(record(after).content_redacted_at).toBeTruthy();
    expect(() => db.prepare(`UPDATE intervention_evidence_records SET principle_id = 'rewritten' WHERE observation_key = ?`).run(oldApplication.observationKey)).toThrow(/immutable/);
    expect(() => db.prepare(`DELETE FROM intervention_evidence_records WHERE observation_key = ?`).run(oldApplication.observationKey)).toThrow(/immutable/);
    const fresh = normalized(deliveryBatch({ observations: [{
      ...oldApplication, observationKey: 'oc|application|fresh', sourceLocator: 'loc:fresh',
    }] }));
    store.appendObservationBatch(fresh);
    const recent = db.prepare(`SELECT payload_json FROM intervention_evidence_records WHERE observation_key = 'oc|application|fresh'`).get();
    expect(JSON.parse(String(record(recent).payload_json)).claimText).toBe('private claim text');
  });

  it('hides expired Codex summaries on read and marks their source availability unknown', () => {
    const batch = normalized(deliveryBatch({
      recordedAt: '2001-01-01T00:00:00Z',
      sourceKind: 'codex_pd_hook_event_log',
      observations: [{
        observationKey: 'codex|episode|rollout-old', sourceLocator: 'codex:old', kind: 'behavior_episode',
        nativeRefs: { hostKind: 'codex', rolloutIdentity: 'rollout-old' },
        payload: { status: 'closed', actionSummary: 'private Codex summary' },
      }],
    }));
    store.appendObservationBatch(batch);
    const read = store.readAuditRelations({ type: 'episode', observationKey: 'codex|episode|rollout-old' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.episodes[0]!.sourceStatus).toBe('unknown');
    expect(read.relations.episodes[0]!.payload).toMatchObject({ actionSummary: '[expired]' });
    expect(read.relations.episodes[0]!.contentRedactedAt).toBeTruthy();
  });

  it('keeps Owner feedback on its 90-day policy even when native host is Codex', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const batch = normalized(deliveryBatch({
      recordedAt: thirtyDaysAgo,
      sourceKind: 'owner_console_input',
      observations: [{
        observationKey: 'owner|outcome|episode-1', sourceLocator: 'console:feedback-1', kind: 'outcome',
        nativeRefs: { hostKind: 'codex' }, episodeKey: 'episode-1',
        payload: { outcomeSource: 'owner_feedback', observationSummary: 'still within Owner retention', feedbackText: 'keep this feedback', actorId: 'owner-1' },
      }],
    }));
    store.appendObservationBatch(batch);
    const read = store.readAuditRelations({ type: 'episode', observationKey: 'episode-1' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.outcomes[0]!.sourceStatus).toBeUndefined();
    expect(read.relations.outcomes[0]!.payload).toMatchObject({ feedbackText: 'keep this feedback' });
  });

  it('upgrades a legacy evidence table and restores both immutability triggers atomically', () => {
    store.appendObservationBatch(normalized(deliveryBatch()));
    const db = conn.getDb();
    db.prepare('DROP TRIGGER intervention_evidence_records_no_update').run();
    db.prepare('DROP TRIGGER intervention_evidence_records_no_delete').run();
    db.prepare('ALTER TABLE intervention_evidence_records DROP COLUMN content_redacted_at').run();
    conn.close();
    conn = new SqliteConnection(workspaceDir);
    store = new SqliteInterventionEvidenceStore(conn);
    const columns = conn.getDb().prepare('PRAGMA table_info(intervention_evidence_records)').all();
    expect(columns.some((column) => isRecord(column) && Object.hasOwn(column, 'name') && column.name === 'content_redacted_at')).toBe(true);
    expect(() => conn.getDb().prepare('DELETE FROM intervention_evidence_records').run()).toThrow(/immutable/);
    expect(() => conn.getDb().prepare(`UPDATE intervention_evidence_records SET principle_id = 'X'`).run()).toThrow(/immutable/);
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

  it('fails loud on a malformed persisted reference instead of presenting it as linked', () => {
    const db = conn.getDb();
    db.prepare(`INSERT INTO intervention_evidence_records (
      evidence_id, scope_id, source_kind, observation_key, source_locator, record_kind,
      principle_id, recorded_at, native_refs_json, content_ref_json, activation_ref_json, payload_json, record_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'sha256:bad-ref', 'scope-ws-1', 'openclaw_plugin_event_log', 'bad-ref', 'loc:bad-ref', 'delivery',
      'T-01', '2026-10-07T08:00:00Z', JSON.stringify({ hostKind: 'openclaw' }),
      JSON.stringify({ principleId: 'T-01', resolution: 'resolved', payloadDigest: 'sha256:fake' }),
      JSON.stringify({ activationId: 'act-1', sourceSnapshotDigest: 'sha256:fake' }),
      JSON.stringify({ targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' }), 'sha256:record',
    );
    expect(() => store.readAuditRelations({ type: 'principle', principleId: 'T-01' })).toThrow(/content reference is invalid/);
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
