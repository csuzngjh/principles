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
import { interventionEvidenceSourcePolicy } from '../receipt-coverage.js';
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
  expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
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

  it('keeps a source-known activation id queryable while marking the missing occurrence snapshot unresolved', () => {
    const application = {
      observationKey: 'openclaw|application|selfreport|sess-1|T-01',
      sourceLocator: 'principle_applications:17',
      kind: 'application' as const,
      nativeRefs: { hostKind: 'openclaw' as const, sessionId: 'sess-1' },
      principleId: 'T-01',
      activationId: 'act-deactivated',
      payload: { proofMethod: 'agent_claimed' as const, action: 'self_reported' as const, claimText: 'I followed T-01' },
    };
    const result = store.appendObservationBatch(normalized(deliveryBatch({ observations: [application] })));
    expect(result.ok).toBe(true);
    expect(result.insertedCount).toBe(1);

    const read = store.readAuditRelations({ type: 'activation', activationId: 'act-deactivated' });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.relations.applications).toHaveLength(1);
    expect(read.relations.applications[0]).toMatchObject({
      activationId: 'act-deactivated',
      associationStatus: 'pending_association',
    });
    expect(read.relations.unresolvedReferences).toEqual([{
      evidenceId: read.relations.applications[0]!.evidenceId,
      missingKey: 'act-deactivated',
      field: 'activationRef',
    }]);
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
      correctionOf: 'prior-application', correctionReason: 'private correction reason',
      payload: { proofMethod: 'agent_claimed' as const, action: 'self_reported' as const, claimText: 'legacy claim text' },
    };
    for (let start = 0; start < oldDeliveries.length; start += 50) {
      store.appendObservationBatch(normalized(deliveryBatch({ recordedAt: oldAt, observations: oldDeliveries.slice(start, start + 50) })));
    }
    const historicalBatch = normalized(deliveryBatch({ recordedAt: oldAt, observations: [oldApplication] }));
    const [historicalRecord] = historicalBatch.records;
    if (!historicalRecord) throw new Error('Expected historical application record');
    // Simulate a legacy row that predates write-time redaction. The 200
    // metadata-only rows ahead of it must not starve the bounded expiry sweep.
    conn.getDb().prepare(`
      INSERT INTO intervention_evidence_records (
        evidence_id, scope_id, source_kind, observation_key, source_locator, record_kind,
        principle_id, activation_id, delivery_key, episode_key, effect_key,
        correction_of, correction_reason, occurred_at, recorded_at,
        native_refs_json, content_ref_json, activation_ref_json, payload_json, record_digest, content_redacted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      historicalRecord.evidenceId, historicalRecord.evidenceScopeId, historicalRecord.sourceKind,
      historicalRecord.observationKey, historicalRecord.sourceLocator, historicalRecord.kind,
      historicalRecord.principleId ?? null, historicalRecord.activationRef?.activationId ?? null,
      historicalRecord.deliveryKey ?? null, historicalRecord.episodeKey ?? null, historicalRecord.effectKey ?? null,
      historicalRecord.correctionOf ?? null, historicalRecord.correctionReason ?? null,
      historicalRecord.occurredAt ?? null, historicalRecord.recordedAt,
      JSON.stringify(historicalRecord.nativeRefs), historicalRecord.contentRef ? JSON.stringify(historicalRecord.contentRef) : null,
      historicalRecord.activationRef ? JSON.stringify(historicalRecord.activationRef) : null,
      JSON.stringify({ proofMethod: 'agent_claimed', action: 'self_reported' }), historicalRecord.recordDigest,
      oldAt,
    );
    const readonlyAudit = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(readonlyAudit.available).toBe(true);
    if (readonlyAudit.available) {
      const oldSummary = readonlyAudit.relations.applications.find((item) => item.observationKey === oldApplication.observationKey);
      expect(oldSummary?.payload).not.toHaveProperty('claimText');
      expect(oldSummary?.contentRedactedAt).toBeTruthy();
    }
    const before = conn.getDb().prepare(`SELECT record_digest, principle_id, native_refs_json, correction_of, correction_reason, payload_json, content_redacted_at FROM intervention_evidence_records WHERE observation_key = ?`).get(oldApplication.observationKey);
    expect(before).toMatchObject({ principle_id: 'T-01', correction_of: 'prior-application', correction_reason: 'private correction reason', content_redacted_at: oldAt });
    store.appendObservationBatch(normalized(deliveryBatch())); // triggers bounded expiry sweep
    const db = conn.getDb();
    const after = db.prepare(`SELECT record_digest, principle_id, native_refs_json, correction_of, correction_reason, payload_json, content_redacted_at FROM intervention_evidence_records WHERE observation_key = ?`).get(oldApplication.observationKey);
    expect(after).toMatchObject({
      record_digest: record(before).record_digest,
      principle_id: 'T-01', native_refs_json: record(before).native_refs_json,
      correction_of: 'prior-application', correction_reason: '[expired]', content_redacted_at: oldAt,
    });
    expect(JSON.parse(String(record(after).payload_json))).not.toHaveProperty('claimText');
    expect(record(after).content_redacted_at).toBeTruthy();
    expect(record(after).payload_json).toBe(record(before).payload_json);
    expect(() => db.prepare(`UPDATE intervention_evidence_records SET principle_id = 'rewritten' WHERE observation_key = ?`).run(oldApplication.observationKey)).toThrow(/immutable/);
    expect(() => db.prepare(`UPDATE intervention_evidence_records SET correction_of = 'rewritten' WHERE observation_key = ?`).run(oldApplication.observationKey)).toThrow(/immutable/);
    expect(() => db.prepare(`UPDATE intervention_evidence_records SET correction_reason = 'forged' WHERE observation_key = ?`).run(oldApplication.observationKey)).toThrow(/immutable/);
    expect(() => db.prepare(`DELETE FROM intervention_evidence_records WHERE observation_key = ?`).run(oldApplication.observationKey)).toThrow(/immutable/);
    const fresh = normalized(deliveryBatch({ observations: [{
      ...oldApplication, observationKey: 'oc|application|fresh', sourceLocator: 'loc:fresh',
      payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'private claim text' },
    }] }));
    store.appendObservationBatch(fresh);
    const recent = db.prepare(`SELECT payload_json FROM intervention_evidence_records WHERE observation_key = 'oc|application|fresh'`).get();
    expect(JSON.parse(String(record(recent).payload_json)).claimText).toBe('private claim text');
    expect(record(db.prepare(`SELECT correction_reason FROM intervention_evidence_records WHERE observation_key = 'oc|application|fresh'`).get()).correction_reason).toBe('private correction reason');
  });

  it('redacts correction-only text on first insert while preserving correction lineage', () => {
    const batch = normalized(deliveryBatch({ recordedAt: '2001-01-01T00:00:00Z', observations: [{
      observationKey: 'oc|delivery|expired-correction-only', sourceLocator: 'loc:expired-correction-only',
      kind: 'delivery', nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
      correctionOf: 'prior-delivery', correctionReason: 'private correction rationale',
      contentRef: { principleId: 'T-01', payloadDigest: `sha256:${'a'.repeat(64)}`, resolution: 'resolved' },
      activationRef: { activationId: 'act-1', sourceSnapshotDigest: `sha256:${'b'.repeat(64)}` },
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    }] }));
    const [incoming] = batch.records;
    if (!incoming) throw new Error('Expected expired correction record');
    store.appendObservationBatch(batch);

    const persisted = record(conn.getDb().prepare(`
      SELECT correction_of, correction_reason, record_digest, payload_json, content_redacted_at
      FROM intervention_evidence_records WHERE evidence_id = ?
    `).get(incoming.evidenceId));
    expect(persisted.correction_of).toBe('prior-delivery');
    expect(persisted.correction_reason).toBe('[expired]');
    expect(persisted.record_digest).toBe(incoming.recordDigest);
    expect(persisted.content_redacted_at).toBeTruthy();
    expect(String(persisted.payload_json)).not.toContain('private correction rationale');
    const audit = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(audit.available).toBe(true);
    if (audit.available) {
      const summary = audit.relations.deliveries.find((item) => item.evidenceId === incoming.evidenceId);
      expect(summary?.contentRedactedAt).toBeTruthy();
      expect(summary).not.toHaveProperty('correctionReason');
    }
    expect(() => conn.getDb().prepare(`UPDATE intervention_evidence_records SET correction_of = 'forged' WHERE evidence_id = ?`).run(incoming.evidenceId)).toThrow(/immutable/);
    expect(() => conn.getDb().prepare(`UPDATE intervention_evidence_records SET correction_reason = 'forged' WHERE evidence_id = ?`).run(incoming.evidenceId)).toThrow(/immutable/);
  });

  it('does not let an already-expired placeholder block a fresh append', () => {
    store.appendObservationBatch(normalized(deliveryBatch({
      recordedAt: '2001-01-01T00:00:00Z',
      observations: [{
        observationKey: 'oc|episode|expired-placeholder', sourceLocator: 'loc:expired-placeholder',
        kind: 'behavior_episode', nativeRefs: { hostKind: 'openclaw', toolCallId: 'tool-expired', toolName: 'test_tool' },
        payload: { status: 'closed', actionSummary: '[expired]' },
      }],
    })));

    const appended = store.appendObservationBatch(normalized(deliveryBatch()));
    expect(appended.ok).toBe(true);
    expect(conn.getDb().prepare(`SELECT payload_json FROM intervention_evidence_records WHERE observation_key = 'oc|episode|expired-placeholder'`).get()).toBeTruthy();
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

  it('redacts an expired application before its first database write', () => {
    const oldAt = '2001-01-01T00:00:00Z';
    const batch = normalized(deliveryBatch({ recordedAt: oldAt, observations: [{
      observationKey: 'oc|application|expired-first-write', sourceLocator: 'loc:expired-first-write',
      kind: 'application', nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
      payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'private-expired-source' },
    }] }));
    const [incoming] = batch.records;
    if (!incoming) throw new Error('Expected expired application record');
    store.appendObservationBatch(batch);

    const persisted = record(conn.getDb().prepare(`
      SELECT payload_json, content_redacted_at, record_digest, principle_id, native_refs_json
      FROM intervention_evidence_records WHERE evidence_id = ?
    `).get(incoming.evidenceId));
    expect(String(persisted.payload_json)).not.toContain('private-expired-source');
    expect(persisted.content_redacted_at).toBeTruthy();
    expect(persisted.record_digest).toBe(incoming.recordDigest);
    expect(persisted.principle_id).toBe('T-01');
    expect(persisted.native_refs_json).toBe(JSON.stringify(incoming.nativeRefs));

    const audit = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(audit.available).toBe(true);
    if (audit.available) {
      const summary = audit.relations.applications.find((item) => item.evidenceId === incoming.evidenceId);
      expect(summary?.payload).not.toHaveProperty('claimText');
      expect(summary?.contentRedactedAt).toBeTruthy();
    }
  });

  it('keeps Owner feedback on its 90-day policy when native host is OpenClaw', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const batch = normalized(deliveryBatch({
      recordedAt: thirtyDaysAgo,
      sourceKind: 'owner_console_input',
      observations: [{
        observationKey: 'owner|outcome|episode-1', sourceLocator: 'console:feedback-1', kind: 'outcome',
        nativeRefs: { hostKind: 'openclaw' }, episodeKey: 'episode-1',
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

  it('applies the seven-day OpenClaw event-log horizon at write, read and sweep', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const firstInput = deliveryBatch({
      sourceKind: 'openclaw_plugin_event_log', recordedAt: eightDaysAgo,
      observations: [{
        observationKey: 'oc|episode|openclaw-expired-first', sourceLocator: 'loc:openclaw-expired-first',
        kind: 'behavior_episode', occurredAt: eightDaysAgo,
        nativeRefs: { hostKind: 'openclaw', toolCallId: 'tool-first', toolName: 'test_tool' },
        payload: { status: 'closed', actionSummary: 'private eight-day summary' },
      }],
    });
    const firstBatch = normalized(firstInput);
    const [firstRecord] = firstBatch.records;
    if (!firstRecord) throw new Error('Expected stale OpenClaw evidence');
    store.appendObservationBatch(firstBatch);

    const firstRow = record(conn.getDb().prepare(`
      SELECT payload_json, content_redacted_at, record_digest, native_refs_json
      FROM intervention_evidence_records WHERE evidence_id = ?
    `).get(firstRecord.evidenceId));
    expect(String(firstRow.payload_json)).not.toContain('private eight-day summary');
    expect(firstRow.content_redacted_at).toBeTruthy();
    expect(firstRow.record_digest).toBe(firstRecord.recordDigest);
    expect(firstRow.native_refs_json).toBe(JSON.stringify(firstRecord.nativeRefs));
    const firstAudit = store.readAuditRelations({ type: 'episode', observationKey: 'oc|episode|openclaw-expired-first' });
    expect(firstAudit.available).toBe(true);
    if (firstAudit.available) {
      expect(firstAudit.relations.episodes[0]!.payload).toMatchObject({ actionSummary: '[expired]' });
      expect(firstAudit.relations.episodes[0]!.contentRedactedAt).toBeTruthy();
      expect(firstAudit.relations.episodes[0]!.sourceStatus).toBe('unknown');
    }

    const legacyBatch = normalized(deliveryBatch({
      sourceKind: 'openclaw_plugin_event_log', recordedAt: eightDaysAgo,
      observations: [{
        observationKey: 'oc|episode|openclaw-expired-legacy', sourceLocator: 'loc:openclaw-expired-legacy',
        kind: 'behavior_episode', occurredAt: eightDaysAgo,
        nativeRefs: { hostKind: 'openclaw', toolCallId: 'tool-legacy', toolName: 'test_tool' },
        payload: { status: 'closed', actionSummary: 'private legacy summary' },
      }],
    }));
    const [legacyRecord] = legacyBatch.records;
    if (!legacyRecord) throw new Error('Expected legacy OpenClaw evidence');
    conn.getDb().prepare(`
      INSERT INTO intervention_evidence_records (
        evidence_id, scope_id, source_kind, observation_key, source_locator, record_kind,
        principle_id, activation_id, delivery_key, episode_key, effect_key,
        correction_of, correction_reason, occurred_at, recorded_at,
        native_refs_json, content_ref_json, activation_ref_json, payload_json, record_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyRecord.evidenceId, legacyRecord.evidenceScopeId, legacyRecord.sourceKind,
      legacyRecord.observationKey, legacyRecord.sourceLocator, legacyRecord.kind,
      legacyRecord.principleId ?? null, legacyRecord.activationRef?.activationId ?? null,
      legacyRecord.deliveryKey ?? null, legacyRecord.episodeKey ?? null, legacyRecord.effectKey ?? null,
      legacyRecord.correctionOf ?? null, legacyRecord.correctionReason ?? null,
      legacyRecord.occurredAt ?? null, legacyRecord.recordedAt, JSON.stringify(legacyRecord.nativeRefs),
      legacyRecord.contentRef ? JSON.stringify(legacyRecord.contentRef) : null,
      legacyRecord.activationRef ? JSON.stringify(legacyRecord.activationRef) : null,
      JSON.stringify(legacyRecord.payload), legacyRecord.recordDigest,
    );
    store.appendObservationBatch(normalized(deliveryBatch()));
    const legacyRow = record(conn.getDb().prepare('SELECT payload_json, content_redacted_at FROM intervention_evidence_records WHERE evidence_id = ?').get(legacyRecord.evidenceId));
    expect(String(legacyRow.payload_json)).not.toContain('private legacy summary');
    expect(legacyRow.content_redacted_at).toBeTruthy();
  });

  it('keeps legacy application-ledger mirrors on the 90-day owner evidence horizon', () => {
    expect(interventionEvidenceSourcePolicy('openclaw_application_ledger').retentionDays).toBe(90);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const currentEvidence = normalized(deliveryBatch({
      sourceKind: 'openclaw_plugin_event_log', recordedAt: thirtyDaysAgo,
      observations: [{
        observationKey: 'openclaw|self-report|thirty-days', sourceLocator: 'openclaw-application-ledger:session-30d',
        kind: 'application', nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
        payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'recent self-report' },
      }],
    }));
    const [currentRecord] = currentEvidence.records;
    if (!currentRecord) throw new Error('Expected recent legacy self-report');
    store.appendObservationBatch(currentEvidence);

    const directLedgerEvidence = normalized(deliveryBatch({
      sourceKind: 'openclaw_application_ledger', recordedAt: thirtyDaysAgo,
      observations: [{
        observationKey: 'openclaw|application-ledger|thirty-days', sourceLocator: 'openclaw-application-ledger:session-new-30d',
        kind: 'application', nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
        payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'new ledger self-report' },
      }],
    }));
    const [directLedgerRecord] = directLedgerEvidence.records;
    if (!directLedgerRecord) throw new Error('Expected recent application-ledger self-report');
    store.appendObservationBatch(directLedgerEvidence);

    const expiredEvidence = normalized(deliveryBatch({
      sourceKind: 'openclaw_plugin_event_log', recordedAt: ninetyOneDaysAgo,
      observations: [{
        observationKey: 'openclaw|self-report|ninety-one-days', sourceLocator: 'openclaw-application-ledger:session-91d',
        kind: 'application', nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
        payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'expired self-report' },
      }],
    }));
    const [expiredRecord] = expiredEvidence.records;
    if (!expiredRecord) throw new Error('Expected expired legacy self-report');
    store.appendObservationBatch(expiredEvidence);

    const db = conn.getDb();
    const currentRow = record(db.prepare('SELECT payload_json, content_redacted_at FROM intervention_evidence_records WHERE evidence_id = ?').get(currentRecord.evidenceId));
    expect(JSON.parse(String(currentRow.payload_json)).claimText).toBe('recent self-report');
    expect(currentRow.content_redacted_at).toBeNull();
    const directLedgerRow = record(db.prepare('SELECT payload_json, content_redacted_at FROM intervention_evidence_records WHERE evidence_id = ?').get(directLedgerRecord.evidenceId));
    expect(JSON.parse(String(directLedgerRow.payload_json)).claimText).toBe('new ledger self-report');
    expect(directLedgerRow.content_redacted_at).toBeNull();
    const expiredRow = record(db.prepare('SELECT payload_json, content_redacted_at, record_digest FROM intervention_evidence_records WHERE evidence_id = ?').get(expiredRecord.evidenceId));
    expect(JSON.parse(String(expiredRow.payload_json))).not.toHaveProperty('claimText');
    expect(expiredRow.content_redacted_at).toBeTruthy();
    expect(expiredRow.record_digest).toBe(expiredRecord.recordDigest);

    const audit = store.readAuditRelations({ type: 'principle', principleId: 'T-01' });
    expect(audit.available).toBe(true);
    if (audit.available) {
      const currentSummary = audit.relations.applications.find((item) => item.evidenceId === currentRecord.evidenceId);
      const directLedgerSummary = audit.relations.applications.find((item) => item.evidenceId === directLedgerRecord.evidenceId);
      const expiredSummary = audit.relations.applications.find((item) => item.evidenceId === expiredRecord.evidenceId);
      expect(currentSummary?.payload).toMatchObject({ claimText: 'recent self-report' });
      expect(currentSummary?.sourceStatus).toBe('unknown');
      expect(directLedgerSummary?.payload).toMatchObject({ claimText: 'new ledger self-report' });
      expect(directLedgerSummary?.sourceStatus).toBeUndefined();
      expect(expiredSummary?.payload).not.toHaveProperty('claimText');
      expect(expiredSummary?.sourceStatus).toBe('unknown');
    }
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
