/**
 * Pain Recall Capability Facade contract tests — SPEC-PD-AGENT-CAPABILITY-API-001
 * v0.5 §7/§8/§11 B/D.
 *
 * Pins, against an INDEPENDENT frozen copy of the od-a-v1 whitelist (copied
 * field-by-field from the hash-anchored Gate 2 executable projection, plus
 * the single v0.5 addition `disclosureProfile`):
 *   - ALLOW: every allowed leaf that the fixture can populate IS present and
 *     its value equals the read model's corresponding field (cross-adapter
 *     parity, §11 D);
 *   - DENY: forbidden key paths never appear, and planted unique sentinel
 *     values never leak into the envelope (keys AND values, §8.1 rule 2);
 *   - status/error mapping (§7.3) incl. the statusDetail-derived
 *     pain_not_found code and the fail-closed self-check path;
 *   - the Core-layer resource limit: limit ∈ [1,10], default 3 (§7.5.2);
 *   - the profile version od-a-v1 (§7.4 governance).
 *
 * The read model is vi.mock'd so tests can (a) assert invalid input never
 * reaches it, and (b) inject a type-violating projection input to prove the
 * per-call self-check withholds the payload (fail closed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

vi.mock('../pain-recall-read-model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReadModelModule>();
  return { ...actual, recallPains: vi.fn() };
});

import type * as ReadModelModule from '../pain-recall-read-model.js';
import type { PainRecallCapabilityResult, PainRecallCapabilityData } from '../pain-recall-capability.js';
import { recallPains } from '../pain-recall-read-model.js';
import {
  recallPrinciplePainsCapability,
  CAPABILITY_SCHEMA_VERSION,
  OD_A_DISCLOSURE_PROFILE,
  RECALL_PAIN_CAPABILITY_ID,
} from '../pain-recall-capability.js';
import * as capabilityModule from '../pain-recall-capability.js';

const actualReadModel = await vi.importActual<typeof ReadModelModule>('../pain-recall-read-model.js');

/** Narrowing accessor: data is non-null for every status except
 * unavailable/invalid_input (§7.2) — a null here fails the test loudly. */
function unwrapData(envelope: PainRecallCapabilityResult): PainRecallCapabilityData {
  if (envelope.data === null) throw new Error(`expected non-null data for status=${envelope.status}`);
  return envelope.data;
}

// ── Frozen od-a-v1 whitelist (independent copy — NOT imported from the module
//    under test, so silent widening in production breaks this test) ─────────

const FROZEN_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  'schemaVersion', 'capability', 'status', 'disclosureProfile',
  'data.principle.requestedId', 'data.principle.identityStatus',
  'data.query.limit', 'data.query.contextUsedForRanking', 'data.query.truncated',
  'data.results[].association.type', 'data.results[].association.confidence',
  'data.results[].availability.painEvent', 'data.results[].availability.diagnoses',
  'data.results[].availability.correctionEvidence',
  'data.summary.returned', 'data.summary.availableCandidates', 'data.summary.truncated',
  'data.sources.ledger', 'data.sources.trajectoryDb', 'data.sources.stateDb',
  'data.unresolvedAssociations[].reason',
  'provenance.workspaceBinding', 'provenance.sources[].name', 'provenance.sources[].status',
  'warnings[].code', 'warnings[].message',
  'error', 'error.code', 'error.message',
  'nextAction', 'nextAction.code', 'nextAction.message',
]);

/** DENY leaf/segment paths that must NEVER resolve in any envelope (§8.1). */
const FROZEN_DENY_PATHS: readonly string[] = [
  'data.principle.canonicalId',
  'data.principle.text',
  'data.query.painId',
  'data.results[].painId',
  'data.results[].association.evidenceRefs',
  'data.results[].association.evidenceRefs[].candidateId',
  'data.results[].association.evidenceRefs[].taskId',
  'data.results[].association.evidenceRefs[].decidedAt',
  'data.results[].association.evidenceRefs[].decisionId',
  'data.results[].pain.reason',
  'data.results[].pain.text',
  'data.results[].pain.rawStatement',
  'data.results[].pain.occurredAt',
  'data.results[].pain.source',
  'data.results[].pain.host',
  'data.results[].pain.score',
  'data.results[].pain.severity',
  'data.results[].diagnoses',
  'data.results[].diagnoses[].diagnosisId',
  'data.results[].diagnoses[].taskId',
  'data.results[].diagnoses[].category',
  'data.results[].diagnoses[].rootCause',
  'data.results[].diagnoses[].supportingEvidence',
  'data.results[].correctionEvidence',
  'data.results[].correctionEvidence.text',
  'data.results[].correctionEvidence.sessionId',
  'data.results[].lineage',
  'data.results[].lineage[].from',
  'data.results[].lineage[].to',
  'data.results[].lineage[].relation',
  'data.statusDetail',
  'data.unresolvedAssociations[].painId',
  'data.unresolvedAssociations[].candidateId',
];

/** Unique sentinel values planted into every sensitive read-model field. */
const SENSITIVE_SENTINELS: readonly string[] = [
  'G3SENT-PAIN-REASON',
  'G3SENT-PAIN-TEXT',
  'G3SENT-DIAG-ROOTCAUSE',
  'G3SENT-CORRECTION-TEXT',
  'G3SENT-CORRECTION-SESSION',
  'G3SENT-DECIDED-AT',
];

/** Deep key-path walk, identical normalization to the production collector.
 * The bare `data` leaf (the §7.2 null marker for unavailable/invalid_input)
 * is removed exactly like the production self-check does. */
function collectLeafPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectLeafPaths(v, prefix + '[]', out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectLeafPaths(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.add(prefix);
}

function envelopeLeafPaths(envelope: unknown): Set<string> {
  const out = new Set<string>();
  collectLeafPaths(envelope, '', out);
  const data = envelope as { data?: unknown };
  if (data !== null && typeof data === 'object' && data.data === null) out.delete('data');
  return out;
}

// ── Fixture builders (same shapes as pain-recall-service.test.ts, with
//    sentinels planted into every DENY-guarded value) ────────────────────────

const tempDirs: string[] = [];

const P1 = '11111111-1111-4111-8111-111111111111';
const P_EMPTY = '33333333-3333-4333-8333-333333333333';
const CAND_A = 'cand-aaaaaaaa-1111-4111-8111-111111111111';
const CAND_B = 'cand-bbbbbbbb-2222-4222-8222-222222222222';
const PAIN_REUSE = 'pain-reuse-001';
const PAIN_LINEAGE = 'pain-lineage-002';
const PAIN_ORPHAN = 'pain-orphan-888';

function writeLedger(dir: string, principles: unknown[]): void {
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const tree = {
    principles: Object.fromEntries(
      (principles as { id: string; text?: string; derivedFromPainIds?: string[]; reuseEvidence?: unknown[] }[]).map((p) => [
        p.id,
        {
          id: p.id,
          version: 1,
          text: p.text ?? `principle ${p.id}`,
          triggerPattern: 'when in doubt',
          action: 'verify first',
          status: 'active',
          derivedFromPainIds: p.derivedFromPainIds ?? [],
          ...(p.reuseEvidence !== undefined ? { reuseEvidence: p.reuseEvidence } : {}),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    ),
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({ _tree: tree }, null, 2));
}

interface PainRow { canonical: string; reason?: string; text?: string | null; created?: string }

function writeTrajectory(dir: string, pains: PainRow[]): void {
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.prepare(`CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT,
      severity TEXT, origin TEXT, confidence REAL, text TEXT,
      canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    )`).run();
  const insert = db.prepare(`INSERT INTO pain_events
      (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
    VALUES ('s1', ?, 80, ?, 'moderate', 'system_infer', NULL, ?, ?, ?, ?, ?)`);
  for (const p of pains) {
    insert.run('tool_failure', p.reason ?? 'fixture reason', p.text ?? null, p.canonical, `diagnosis_${p.canonical}`, null, p.created ?? '2026-10-01T10:00:00.000Z');
  }
  db.close();
}

async function writeStateDb(dir: string, spec: { tasks?: unknown[]; candidates?: unknown[]; diagnoses?: unknown[]; corruptStateDb?: boolean }): Promise<void> {
  if (spec.corruptStateDb) {
    const pdDir = path.join(dir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    fs.writeFileSync(path.join(pdDir, 'state.db'), 'this is not a sqlite database');
    return;
  }
  const { RuntimeStateManager } = await import('../store/runtime-state-manager.js');
  const manager = new RuntimeStateManager({ workspaceDir: dir });
  await manager.initialize();
  manager.connection.getDb();
  await manager.close();

  const db = new Database(path.join(dir, '.pd', 'state.db'));
  db.pragma('foreign_keys = OFF');
  const insertTask = db.prepare(`INSERT INTO tasks
      (task_id, task_kind, status, created_at, updated_at, input_ref, diagnostic_json)
    VALUES (?, 'diagnostician', 'succeeded', '2026-10-01T09:00:00.000Z', '2026-10-01T09:05:00.000Z', ?, ?)`);
  for (const t of spec.tasks ?? []) {
    const row = t as { taskId: string; inputRef?: string | null; diagnosticJson?: string | null };
    insertTask.run(row.taskId, row.inputRef ?? null, row.diagnosticJson ?? null);
  }
  const insertCandidate = db.prepare(`INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
       source_recommendation_json, idempotency_key, status, created_at, consumed_at, recommendation_kind)
    VALUES (?, 'art-1', ?, 'run-1', 't', 'd', 0.9, '{}', ?, 'consumed', '2026-10-01T09:10:00.000Z', '2026-10-01T09:20:00.000Z', 'principle')`);
  for (const c of spec.candidates ?? []) {
    const row = c as { candidateId: string; taskId: string };
    insertCandidate.run(row.candidateId, row.taskId, `idem-${row.candidateId}`);
  }
  const insertDiagnosis = db.prepare(`INSERT INTO pain_diagnoses
      (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at)
    VALUES (?, ?, ?, ?, 'Tooling', ?, '[]', 0.8, NULL, '2026-10-01T09:05:00.000Z')`);
  for (const d of spec.diagnoses ?? []) {
    const row = d as { painId: string; taskId: string; diagnosisId: string; rootCause?: string };
    insertDiagnosis.run(`${row.taskId}::${row.diagnosisId}`, row.painId, row.taskId, row.diagnosisId, row.rootCause ?? 'Tooling: fixture root cause');
  }
  db.close();
}

async function makeWorkspace(spec: {
  principles?: unknown[];
  pains?: PainRow[];
  tasks?: unknown[];
  candidates?: unknown[];
  diagnoses?: unknown[];
  corruptStateDb?: boolean;
}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-cap-'));
  tempDirs.push(dir);
  writeLedger(dir, spec.principles ?? []);
  writeTrajectory(dir, spec.pains ?? []);
  await writeStateDb(dir, spec);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can briefly hold SQLite handles after close; the vitest
      // temp-lifecycle keeper sweeps leftovers.
    }
  }
});

/** Rich workspace: every read-model branch populated, sentinels planted. */
async function makeSentinelWorkspace(): Promise<string> {
  return makeWorkspace({
    principles: [
      {
        id: P1,
        text: 'G3SENT-PRINCIPLE-TEXT',
        derivedFromPainIds: [CAND_A, 'cand-missing-zzzz'],
        reuseEvidence: [
          {
            painId: PAIN_REUSE,
            candidateId: CAND_B,
            decision: 'reuse',
            actor: { kind: 'owner', id: 'owner-1' },
            reason: 'same underlying pain',
            decidedAt: 'G3SENT-DECIDED-AT',
          },
        ],
      },
      { id: P_EMPTY, text: 'Lonely principle' },
    ],
    pains: [
      { canonical: PAIN_REUSE, reason: 'G3SENT-PAIN-REASON', text: 'G3SENT-PAIN-TEXT', created: '2026-10-01T10:00:00.000Z' },
      { canonical: PAIN_LINEAGE, reason: 'agent skipped verification', created: '2026-10-01T11:00:00.000Z' },
      { canonical: PAIN_ORPHAN, reason: 'unassociated orphan pain', created: '2026-10-01T12:00:00.000Z' },
    ],
    tasks: [
      { taskId: `diagnosis_${PAIN_LINEAGE}`, inputRef: PAIN_LINEAGE },
      {
        taskId: `diagnosis_${PAIN_REUSE}`,
        inputRef: PAIN_REUSE,
        diagnosticJson: JSON.stringify({
          painId: PAIN_REUSE,
          correctionEvidence: {
            text: 'G3SENT-CORRECTION-TEXT',
            classification: 'owner_statement',
            channel: 'cli_owner_statement',
            sessionId: 'G3SENT-CORRECTION-SESSION',
          },
        }),
      },
    ],
    candidates: [{ candidateId: CAND_A, taskId: `diagnosis_${PAIN_LINEAGE}` }],
    diagnoses: [
      { painId: PAIN_REUSE, taskId: `diagnosis_${PAIN_REUSE}`, diagnosisId: 'diag-1', rootCause: 'G3SENT-DIAG-ROOTCAUSE' },
    ],
  });
}

// ── Default mock delegation to the real read model ───────────────────────────

beforeEach(() => {
  vi.mocked(recallPains).mockImplementation(actualReadModel.recallPains);
});

afterEach(() => {
  vi.mocked(recallPains).mockRestore();
});

// ── Runtime export face (G-2 companion: real module keys) ───────────────────

describe('pain-recall capability: runtime export face', () => {
  it('exports exactly the facade surface — constants + the single use-case function', () => {
    expect(Object.keys(capabilityModule).sort()).toEqual([
      'CAPABILITY_SCHEMA_VERSION',
      'OD_A_DISCLOSURE_PROFILE',
      'RECALL_PAIN_CAPABILITY_ID',
      'recallPrinciplePainsCapability',
    ]);
    expect(Object.hasOwn(capabilityModule, 'painRecallSnapshotTestHooks')).toBe(false);
  });
});

// ── ALLOW: presence + value parity (§11 B-1 / D) ─────────────────────────────

describe('recallPrinciplePainsCapability: ALLOW set and parity', () => {
  it('every populated allowed leaf is present, and each value equals the read model field', async () => {
    const ws = await makeSentinelWorkspace();
    const raw = await actualReadModel.recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(raw.status).toBe('ok');
    expect(raw.results).toHaveLength(2); // reuse + lineage; cand-missing-zzzz unresolved

    const envelope = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });

    expect(envelope.schemaVersion).toBe(CAPABILITY_SCHEMA_VERSION);
    expect(envelope.capability).toBe(RECALL_PAIN_CAPABILITY_ID);
    expect(envelope.disclosureProfile).toBe(OD_A_DISCLOSURE_PROFILE);
    expect(envelope.status).toBe('ok');
    expect(envelope.error).toBeNull();

    // Parity: every projected value equals the read model's value (§11 D).
    const data = unwrapData(envelope);
    expect(data.principle.requestedId).toBe(raw.principle.requestedId);
    expect(data.principle.identityStatus).toBe(raw.principle.identityStatus);
    expect(data.query.limit).toBe(raw.query.limit);
    expect(data.query.contextUsedForRanking).toBe(raw.query.contextUsedForRanking);
    expect(data.query.truncated).toBe(raw.query.truncated);
    expect(data.summary.returned).toBe(raw.summary.returned);
    expect(data.summary.availableCandidates).toBe(raw.summary.availableCandidates);
    expect(data.summary.truncated).toBe(raw.summary.truncated);
    expect(data.sources).toEqual(raw.sources);
    expect(data.unresolvedAssociations).toEqual(raw.unresolvedAssociations.map((u) => ({ reason: u.reason })));
    for (let i = 0; i < raw.results.length; i++) {
      const projected = data.results[i];
      const source = raw.results[i];
      if (projected === undefined || source === undefined) throw new Error(`result index ${i} missing`);
      expect(projected.association.type).toBe(source.association.type);
      expect(projected.association.confidence).toBe(source.association.confidence);
      expect(projected.availability.painEvent).toBe(source.availability.painEvent);
      expect(projected.availability.diagnoses).toBe(source.availability.diagnoses);
      expect(projected.availability.correctionEvidence).toBe(source.availability.correctionEvidence);
    }
    expect(envelope.provenance.workspaceBinding).toBe('configured');
    expect(envelope.provenance.sources).toEqual([
      { name: 'ledger', status: raw.sources.ledger },
      { name: 'trajectoryDb', status: raw.sources.trajectoryDb },
      { name: 'stateDb', status: raw.sources.stateDb },
    ]);
    expect(envelope.warnings).toEqual([]);

    // Completeness: every leaf the fixture can populate IS present — the
    // projection may not silently narrow either.
    const paths = envelopeLeafPaths(envelope);
    for (const required of [
      'schemaVersion', 'capability', 'disclosureProfile', 'status',
      'data.principle.requestedId', 'data.principle.identityStatus',
      'data.query.limit', 'data.query.contextUsedForRanking', 'data.query.truncated',
      'data.results[].association.type', 'data.results[].association.confidence',
      'data.results[].availability.painEvent', 'data.results[].availability.diagnoses',
      'data.results[].availability.correctionEvidence',
      'data.summary.returned', 'data.summary.availableCandidates', 'data.summary.truncated',
      'data.sources.ledger', 'data.sources.trajectoryDb', 'data.sources.stateDb',
      'data.unresolvedAssociations[].reason',
      'provenance.workspaceBinding', 'provenance.sources[].name', 'provenance.sources[].status',
    ]) {
      expect(paths.has(required), `missing allowed leaf: ${required}`).toBe(true);
    }
    // Whitelist containment against the INDEPENDENT frozen copy.
    for (const p of paths) {
      expect(FROZEN_ALLOWED_PATHS.has(p), `non-whitelisted leaf leaked: ${p}`).toBe(true);
    }
  });

  it('field-tree snapshot pins the od-a-v1 profile shape (value-independent)', async () => {
    const ws = await makeSentinelWorkspace();
    const envelope = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });
    const paths = [...envelopeLeafPaths(envelope)].sort();
    // The frozen expected field tree — updating this line REQUIRES a new
    // profile version + Owner decision (v0.5 §7.4).
    expect(paths).toEqual([
      'capability',
      'data.principle.identityStatus',
      'data.principle.requestedId',
      'data.query.contextUsedForRanking',
      'data.query.limit',
      'data.query.truncated',
      'data.results[].association.confidence',
      'data.results[].association.type',
      'data.results[].availability.correctionEvidence',
      'data.results[].availability.diagnoses',
      'data.results[].availability.painEvent',
      'data.sources.ledger',
      'data.sources.stateDb',
      'data.sources.trajectoryDb',
      'data.summary.availableCandidates',
      'data.summary.returned',
      'data.summary.truncated',
      'data.unresolvedAssociations[].reason',
      'disclosureProfile',
      'error',
      'nextAction',
      'provenance.sources[].name',
      'provenance.sources[].status',
      'provenance.workspaceBinding',
      'schemaVersion',
      'status',
    ]);
    expect(envelope.disclosureProfile).toBe(OD_A_DISCLOSURE_PROFILE);
  });
});

// ── DENY: keys and sentinel values never appear (§11 B-2/3) ──────────────────

describe('recallPrinciplePainsCapability: OD-A DENY enforcement', () => {
  it('no DENY key path resolves and no planted sentinel value leaks (ok path)', async () => {
    const ws = await makeSentinelWorkspace();
    const envelope = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });

    const paths = envelopeLeafPaths(envelope);
    for (const deny of FROZEN_DENY_PATHS) {
      expect(paths.has(deny), `DENY path resolved: ${deny}`).toBe(false);
    }
    const serialized = JSON.stringify(envelope);
    for (const sentinel of SENSITIVE_SENTINELS) {
      expect(serialized.includes(sentinel), `sentinel leaked: ${sentinel}`).toBe(false);
    }
    // statusDetail never surfaces as a data field (frozen §8.1 detail 1).
    expect(serialized.includes('statusDetail')).toBe(false);
    expect(serialized.includes('canonicalId')).toBe(false);
    expect(serialized.includes('painId')).toBe(false);
  });

  it('error paths leak nothing: not_found / unavailable envelopes pass the same scans', async () => {
    const ws = await makeSentinelWorkspace();

    const notFound = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: '99999999-9999-4999-8999-999999999999' });
    expect(notFound.status).toBe('not_found');
    expect(notFound.error?.code).toBe('principle_not_found');
    // §7.2: data is null ONLY for unavailable/invalid_input — not_found still
    // carries the projected (empty) data object.
    expect(notFound.data).not.toBeNull();
    if (notFound.data === null) throw new Error('unreachable');
    expect(notFound.data.results).toEqual([]);
    expect(notFound.data.summary.returned).toBe(0);
    expect(notFound.data.principle.identityStatus).toBe('not_found');

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-cap-empty-'));
    tempDirs.push(emptyDir);
    fs.mkdirSync(path.join(emptyDir, '.state'), { recursive: true });
    const unavailable = await recallPrinciplePainsCapability({ workspaceDir: emptyDir, principleId: P1 });
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.error?.code).toBe('source_missing');
    expect(unavailable.data).toBeNull();

    for (const envelope of [notFound, unavailable]) {
      const serialized = JSON.stringify(envelope);
      for (const sentinel of SENSITIVE_SENTINELS) {
        expect(serialized.includes(sentinel)).toBe(false);
      }
      for (const deny of FROZEN_DENY_PATHS) {
        expect(envelopeLeafPaths(envelope).has(deny), `DENY path resolved: ${deny}`).toBe(false);
      }
    }
  });

  it('pain_not_found derives error.code from statusDetail without emitting it (frozen §8.1 detail 1)', async () => {
    const ws = await makeSentinelWorkspace();
    // The capability input has no painId parameter; drive the underlying path
    // through the mocked read model to pin the derivation contract.
    vi.mocked(recallPains).mockImplementation(async () => {
      const raw = await actualReadModel.recallPains(ws, { requestedPrincipleId: P1, painId: PAIN_ORPHAN, limit: 3 });
      expect(raw.status).toBe('pain_not_found');
      expect(raw.statusDetail).toBe('not_associated');
      return raw;
    });
    const result = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1 });
    expect(result.status).toBe('not_found');
    expect(result.error?.code).toBe('not_associated'); // derived FROM statusDetail
    expect(JSON.stringify(result).includes('statusDetail')).toBe(false); // but never emitted
    expect(JSON.stringify(result).includes('pain_event_not_found')).toBe(false);
  });

  it('self-check failure withholds the violating payload and reports unavailable (fail closed)', async () => {
    const ws = await makeSentinelWorkspace();
    // Test-reachable injection: a type-violating read-model result whose
    // availability field carries an out-of-whitelist leaf. The projection
    // copies trusted fields verbatim, so the envelope gains a violating leaf;
    // the per-call self-check must catch it and withhold EVERYTHING.
    vi.mocked(recallPains).mockImplementation(async () => {
      const raw = await actualReadModel.recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
      expect(raw.status).toBe('ok');
      return {
        ...raw,
        results: raw.results.map((r) => ({
          ...r,
          availability: { ...r.availability, painEvent: { 'G3SENT-VIOLATING': 'leak' } },
        })),
      // The deliberate type violation is the injection itself; the double
      // cast is how a test states that intentionality to the compiler.
      } as unknown as typeof raw;
    });
    const envelope = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });
    expect(envelope.status).toBe('unavailable');
    expect(envelope.error?.code).toBe('disclosure_assertion_failed');
    expect(envelope.data).toBeNull();
    const serialized = JSON.stringify(envelope);
    expect(serialized.includes('G3SENT-VIOLATING')).toBe(false); // violating payload withheld
    expect(serialized.includes('G3SENT-PAIN-REASON')).toBe(false);
  });

  it('reserved OUTER_STATUS row is pinned in source (ambiguous_principle is not fabricated)', () => {
    // The read model never produces ambiguous_principle (v0.5 F8), so the
    // reserved mapping row is unreachable end-to-end. Pin it at the source
    // level: the row must exist exactly once and map fail-closed to
    // invalid_input — removing or widening it is a contract change.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'pain-recall-capability.ts'),
      'utf-8',
    );
    expect(src.match(/ambiguous_principle:\s*'invalid_input'/g)).toHaveLength(1);
    expect(src.includes('reserved — not produced'));
  });
});

// ── Input validation (§7.1; rc-1/rc-2) ───────────────────────────────────────

describe('recallPrinciplePainsCapability: input validation (fail closed)', () => {
  const WS = 'C:/does-not-matter-validation-happens-first';

  async function expectInvalid(input: unknown): Promise<void> {
    vi.mocked(recallPains).mockClear();
    vi.mocked(recallPains).mockImplementation(async () => {
      throw new Error('read model must not be called for invalid input');
    });
    const envelope = await recallPrinciplePainsCapability(input as never);
    expect(envelope.status).toBe('invalid_input');
    expect(envelope.error?.code).toBe('invalid_input');
    expect(envelope.data).toBeNull();
    expect(envelope.provenance.sources).toEqual([]);
    expect(recallPains).not.toHaveBeenCalled();
  }

  it('non-object input is rejected', async () => {
    for (const bad of [null, undefined, 42, 'x', [], [{}], true]) {
      await expectInvalid(bad);
    }
  });

  it('unknown properties are rejected', async () => {
    await expectInvalid({ workspaceDir: WS, principleId: 'p', context: 'no such parameter' });
    await expectInvalid({ workspaceDir: WS, principleId: 'p', painId: 'no such parameter' });
    await expectInvalid({ workspaceDir: WS, principleId: 'p', host: 'codex', session: 's-1' });
  });

  it('workspaceDir must be a non-empty string', async () => {
    await expectInvalid({ principleId: 'p' });
    await expectInvalid({ workspaceDir: '', principleId: 'p' });
    await expectInvalid({ workspaceDir: 42, principleId: 'p' });
  });

  it('principleId must be a 1..200 char string', async () => {
    await expectInvalid({ workspaceDir: WS, principleId: '' });
    await expectInvalid({ workspaceDir: WS, principleId: 'x'.repeat(201) });
    await expectInvalid({ workspaceDir: WS, principleId: 42 });
  });

  it('limit must be an integer within [1,10]', async () => {
    for (const bad of [0, -1, 11, 99, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      await expectInvalid({ workspaceDir: WS, principleId: 'p', limit: bad });
    }
  });
});

// ── Resource limit: single-call ≤ 10 entries (§7.5.2) ────────────────────────

describe('recallPrinciplePainsCapability: limit resource constraint', () => {
  it('defaults to 3 and accepts the [1,10] bounds', async () => {
    const ws = await makeWorkspace({
      principles: [{ id: P1, reuseEvidence: [1, 2, 3, 4, 5].map((i) => ({ painId: `pain-t-00${i}`, candidateId: `cand-t-00${i}` })) }],
      pains: [1, 2, 3, 4, 5].map((i) => ({ canonical: `pain-t-00${i}`, reason: `truncation pain ${i}`, created: `2026-10-0${i}T10:00:00.000Z` })),
    });
    const def = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1 });
    expect(unwrapData(def).query.limit).toBe(3);
    expect(unwrapData(def).summary.returned).toBe(3);
    expect(unwrapData(def).summary.availableCandidates).toBe(5);
    expect(unwrapData(def).summary.truncated).toBe(true);

    const low = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 1 });
    expect(unwrapData(low).summary.returned).toBe(1);
    expect(unwrapData(low).summary.truncated).toBe(true);

    const high = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });
    expect(unwrapData(high).query.limit).toBe(10);
    expect(unwrapData(high).summary.returned).toBe(5);
    expect(unwrapData(high).summary.truncated).toBe(false);
  });

  it('more than 10 candidates still cap at limit ≤ 10 with honest truncation (§7.5.2)', async () => {
    const ws = await makeWorkspace({
      principles: [{ id: P1, reuseEvidence: Array.from({ length: 12 }, (_, i) => ({ painId: `pain-t-${String(i + 1).padStart(3, '0')}`, candidateId: `cand-t-${i}` })) }],
      pains: Array.from({ length: 12 }, (_, i) => ({ canonical: `pain-t-${String(i + 1).padStart(3, '0')}`, reason: `cap pain ${i}`, created: `2026-10-01T10:00:0${i % 10}.000Z` })),
    });
    const envelope = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });
    expect(envelope.status).toBe('ok');
    const data = unwrapData(envelope);
    expect(data.results.length).toBeLessThanOrEqual(10);
    expect(data.summary.returned).toBe(10);
    expect(data.summary.availableCandidates).toBe(12);
    expect(data.summary.truncated).toBe(true); // never silently truncated
    // Default limit also stays bounded.
    const def = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1 });
    expect(unwrapData(def).results.length).toBeLessThanOrEqual(10);
  });
});

// ── Status mapping (§7.3 reachable rows, end-to-end) ─────────────────────────

describe('recallPrinciplePainsCapability: OUTER_STATUS mapping', () => {
  it('ok / no_matches / partial pass through; not_found and unavailable map per table', async () => {
    const ws = await makeSentinelWorkspace();

    const ok = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P1, limit: 10 });
    expect(ok.status).toBe('ok');
    expect(ok.error).toBeNull();

    const noMatches = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: P_EMPTY });
    expect(noMatches.status).toBe('no_matches');
    expect(noMatches.error).toBeNull();
    expect(unwrapData(noMatches).summary.returned).toBe(0);

    const notFound = await recallPrinciplePainsCapability({ workspaceDir: ws, principleId: '99999999-9999-4999-8999-999999999999' });
    expect(notFound.status).toBe('not_found');
    expect(notFound.error?.code).toBe('principle_not_found');
    expect(unwrapData(notFound).results).toEqual([]); // projected empty data, not null (§7.2)

    // partial: corrupt state.db degrades diagnoses while pains survive.
    const partialWs = await makeWorkspace({
      principles: [{ id: P1, reuseEvidence: [{ painId: PAIN_REUSE, candidateId: CAND_B }] }],
      pains: [{ canonical: PAIN_REUSE, reason: 'r', created: '2026-10-01T10:00:00.000Z' }],
      corruptStateDb: true,
    });
    const partial = await recallPrinciplePainsCapability({ workspaceDir: partialWs, principleId: P1 });
    expect(partial.status).toBe('partial');
    expect(partial.error).toBeNull();
    const partialData = unwrapData(partial);
    expect(partialData.sources.stateDb).toBe('unreadable');
    const [partialEntry] = partialData.results;
    if (partialEntry === undefined) throw new Error('partial fixture lost its reuse entry');
    expect(partialEntry.availability.diagnoses).toBe('unreadable');

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-cap-src-'));
    tempDirs.push(emptyDir);
    fs.mkdirSync(path.join(emptyDir, '.state'), { recursive: true });
    const sourceMissing = await recallPrinciplePainsCapability({ workspaceDir: emptyDir, principleId: P1 });
    expect(sourceMissing.status).toBe('unavailable');
    expect(sourceMissing.error?.code).toBe('source_missing');
  });
});
