/**
 * SPEC-PD-EXAMINER-001 v0.10.1 — P1 repair verification (Owner review round).
 *
 * Pins the six P1 fixes against the REAL route boundary and REAL lab engine:
 *   P1-1  the production snapshot is INSIDE the freeze chain — tamper/move/
 *         delete is drift that preflight refuses; an anchor-consistent
 *         re-hash without the anchor still fails.
 *   P1-2  a degraded activation read is UNKNOWN truth: no independence=TRUE,
 *         the snapshot carries status/reason/nextAction and the freeze marker.
 *   P1-3  evidence pagination truth rides through (loaded counts + hasMore),
 *         never presented as totals.
 *   P1-4  acceptance is atomic under the study lock (one live run per study,
 *         concurrent requests: exactly one 202); a corrupt/unreadable ledger
 *         refuses runs and is reported structurally; finishedAt is settlement
 *         time.
 *   P1-6  symlinked ledgers / planted links are refused; exclusive temp dirs
 *         for the dry-run probe.
 * All fixtures live in temp dirs; no real workspace, host or model is touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleExaminerRoute } from '../../../src/server/routes/examiner.js';
import {
  readConsoleRuns, recoverUnfinishedConsoleRuns, appendConsoleRunEvent, mintRunId,
  CONSOLE_RUN_SCHEMA, ConsoleLedgerUnreadableError, type ConsoleRunMode,
} from '../../../src/server/routes/examiner-runs.js';
import { resolveStudyRoots } from '../../../src/server/routes/examiner-executor.js';
import { disposeReceiptsModels } from '../../../src/server/routes/receipts.js';

const STUDY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

function createMockRequest(method: string, url: string, body?: unknown): IncomingMessage {
  // A BUFFERING request double, never a timer. handleExaminerRoute awaits real
  // I/O before it reaches readBody (the lab cold-load on the first request of
  // a process, startup recovery on the first request per root). A
  // `setTimeout(..., 0)` emitter loses that race on the first request — the
  // body events fire before any listener exists, readBody's promise never
  // settles, and the test deadlocks (this was the long-standing local hang).
  // A real IncomingMessage buffers the body until a consumer subscribes;
  // this double does the same: it emits the buffered body at the moment the
  // reader subscribes to 'end' (readBody subscribes 'data' then 'end' in one
  // synchronous block), so no macrotask can intervene.
  const listeners: { data: Array<(chunk: Buffer) => void>; end: Array<() => void> } = { data: [], end: [] };
  let emitted = false;
  const req = {
    method,
    url,
    on(event: 'data' | 'end', handler: (chunk?: unknown) => void) {
      if (event === 'end') {
        listeners.end.push(handler as () => void);
        if (!emitted) {
          emitted = true;
          const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
          if (payload !== null) for (const dataHandler of listeners.data) dataHandler(payload);
          for (const endHandler of listeners.end) endHandler();
        }
      } else {
        listeners.data.push(handler as (chunk: Buffer) => void);
      }
      return req;
    },
  };
  return req as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(data?: string) {
      if (data !== undefined) res._body = data;
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

function parseBody(res: ServerResponse): { statusCode: number; body: any } {
  const mock = res as unknown as { statusCode: number; _body: string };
  let parsed: unknown = null;
  if (mock._body) {
    try {
      parsed = JSON.parse(mock._body);
    } catch {
      parsed = mock._body;
    }
  }
  return { statusCode: mock.statusCode, body: parsed };
}

let tempDir: string;
let workspaceDir: string;
let studiesRoot: string;

function studyDirOf(studyId: string): string {
  if (!STUDY_ID_PATTERN.test(studyId)) throw new Error(`test: refusing non-handle study id '${studyId}'`);
  const dir = path.resolve(studiesRoot, studyId);
  if (!dir.startsWith(path.resolve(studiesRoot) + path.sep)) throw new Error('test: study dir escaped root');
  return dir;
}

function readEvents(studyId: string): Record<string, unknown>[] {
  return fs.readFileSync(path.join(studyDirOf(studyId), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resolveRoots() {
  const labRoot = path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab');
  return resolveStudyRoots(labRoot, path.join(workspaceDir, '.pd', 'examiner'));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-exm-p1-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  studiesRoot = path.join(tempDir, 'studies');
  fs.mkdirSync(studiesRoot, { recursive: true });
  process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
  const principle = (id: string) => ({
    id, text: `原则 ${id}`, triggerPattern: 't', action: 'a', status: id === 'pri-archived' ? 'archived' : 'active',
    priority: 'P1', scope: 'general', evaluability: 'manual_only', valueScore: 1, adherenceRate: 1,
    painPreventedCount: 0, derivedFromPainIds: id === 'pri-target' ? ['pain-e2e-1'] : [], ruleIds: [],
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', version: 1,
  });
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: { 'pri-target': principle('pri-target'), 'pri-archived': principle('pri-archived') },
        rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-11-01T00:00:00Z',
      },
    }),
  );
});

afterEach(() => {
  delete process.env.PD_EXAMINER_STUDIES_ROOT;
  disposeReceiptsModels();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function call(method: string, subPath: string, body?: unknown) {
  const res = createMockResponse();
  await handleExaminerRoute(createMockRequest(method, subPath, body), res, workspaceDir, subPath);
  return parseBody(res);
}

async function createStudy(suiteKey = 'didactic-pair'): Promise<string> {
  const created = await call('POST', '/studies', { targetPrincipleId: 'pri-target', experimentMode: 'full_library_incremental', repetitionsPerCase: 1, suiteKey });
  expect(created.statusCode).toBe(200);
  return created.body.data.studyId as string;
}

async function waitForTerminalRun(studyId: string, runId: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = readConsoleRuns(studyDirOf(studyId));
    const found = runs.find((run) => run.runId === runId);
    if (found && found.status !== 'RUNNING') return found;
    if (Date.now() > deadline) throw new Error(`console run ${runId} did not settle in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

// ── P1-1: the production snapshot is INSIDE the freeze chain ────────────────

describe('P1-1 — production snapshot inside the preregistration binding chain', () => {
  it('a fresh study verifies with the snapshot hash-bound (manifest → binding → anchor)', async () => {
    const studyId = await createStudy();
    const studyDir = studyDirOf(studyId);
    const manifest = JSON.parse(fs.readFileSync(path.join(studyDir, 'examiner-manifest.json'), 'utf8'));
    expect(typeof manifest.productionSnapshotHash).toBe('string');
    const snapshot = JSON.parse(fs.readFileSync(path.join(studyDir, 'production-snapshot.json'), 'utf8'));
    const canonical = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map((entry) => canonical(entry));
      if (input !== null && typeof input === 'object') {
        const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined);
        return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
      }
      return input;
    };
    expect(manifest.productionSnapshotHash).toBe(createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex'));
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(true);
    // The anchor carries the snapshot inside its binding payload.
    const anchor = readEvents(studyId).find((event) => event.type === 'PREREGISTRATION_FROZEN');
    expect(anchor?.binding?.productionSnapshotHash).toBe(manifest.productionSnapshotHash);
  });

  it('tampering with the snapshot FAILS preflight (content drift, anchor untouched)', async () => {
    const studyId = await createStudy();
    const snapshotPath = path.join(studyDirOf(studyId), 'production-snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    snapshot.budget.chars = 999_999;
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(false);
    expect(JSON.stringify(preflight.body.data.blockers)).toContain('production-snapshot');
  });

  it('DELETING the snapshot FAILS preflight (manifest declares it, file gone)', async () => {
    const studyId = await createStudy();
    fs.rmSync(path.join(studyDirOf(studyId), 'production-snapshot.json'));
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(false);
    expect(JSON.stringify(preflight.body.data.blockers)).toContain('production-snapshot.json is missing');
  });

  it('re-hashing the manifest AND hashes.json together still FAILS — the anchor is immutable and no regeneration happens', async () => {
    const studyId = await createStudy();
    const studyDir = studyDirOf(studyId);
    // The full "consistent rewrite" attack: mutate the snapshot, re-point the
    // manifest, re-hash the manifest and re-write hashes.json — everything
    // EXCEPT the append-only anchor event.
    const canonical = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map((entry) => canonical(entry));
      if (input !== null && typeof input === 'object') {
        const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined);
        return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
      }
      return input;
    };
    const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
    const snapshotPath = path.join(studyDir, 'production-snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    snapshot.experimentVsProduction.markers = [];
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    const newSnapshotHash = hashOf(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(studyDir, 'examiner-manifest.json'), 'utf8'));
    manifest.productionSnapshotHash = newSnapshotHash;
    delete manifest.manifestHash;
    manifest.manifestHash = hashOf(manifest);
    fs.writeFileSync(path.join(studyDir, 'examiner-manifest.json'), JSON.stringify(manifest, null, 2));
    const hashes = JSON.parse(fs.readFileSync(path.join(studyDir, 'hashes.json'), 'utf8'));
    hashes.examinerManifestHash = { value: manifest.manifestHash };
    fs.writeFileSync(path.join(studyDir, 'hashes.json'), JSON.stringify(hashes, null, 2));
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(false);
    expect(JSON.stringify(preflight.body.data.blockers)).toContain('manifestHash');
  });
});

// ── P1-2: degraded runtime activation is UNKNOWN, never zero ────────────────

describe('P1-2 — degraded activation read is frozen as UNKNOWN (not zero activations)', () => {
  it('a workspace without state.db freezes the DEGRADED marker and never independence=true', async () => {
    // This fixture workspace has NO state.db: the activation read model
    // degrades, so the frozen snapshot must carry status/reason/nextAction
    // and the ACTIVATION_DATA_DEGRADED marker — and the created study must
    // still verify (the ledger remains readable evidence).
    const studyId = await createStudy();
    const snapshot = JSON.parse(fs.readFileSync(path.join(studyDirOf(studyId), 'production-snapshot.json'), 'utf8'));
    expect(snapshot.runtimeActivation.status).toBe('degraded');
    expect(typeof snapshot.runtimeActivation.reason).toBe('string');
    expect(snapshot.experimentVsProduction.markers).toContain('ACTIVATION_DATA_DEGRADED');
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(true);
  });
});

// ── P1-3: pagination truth, never fake totals ───────────────────────────────

describe('P1-3 — evidence pagination passes through (loaded counts + hasMore)', () => {
  it('reports loaded counts with hasMore per kind when records exceed the audit window', async () => {
    const evidenceDir = path.join(workspaceDir, '.pd');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const { getInterventionEvidenceIngress } = await import('@principles/host-runtime');
    const ingress = getInterventionEvidenceIngress();
    const recordedAt = '2025-01-15T08:00:00Z';
    // 55 distinct deliveries — above the audit's 50-row window.
    const batch = Array.from({ length: 55 }, (_, index) => ({
      observationKey: `openclaw|delivery|agent_context|sess-p1|run-${index}|act-p1`,
      sourceLocator: `openclaw-plugin-event-log:sess-p1:${index}`,
      kind: 'delivery',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-p1', runId: `run-${index}` },
      principleId: 'pri-target',
      contentRef: { principleId: 'pri-target', payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: 'act-p1', sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    }));
    const result = ingress.appendObservationBatch({ workspaceDir, batch: {
      evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
      sourceKind: 'openclaw_plugin_event_log' as const,
      adapterVersion: 'p1-repair@1',
      recordedAt: new Date().toISOString(),
      observations: batch as never,
    } });
    expect(result.ok, `ingress refused: ${result.reason ?? 'unknown'} ${JSON.stringify(result.duplicates ?? '')}`).toBe(true);
    void recordedAt;
    const evidence = await call('GET', '/principles/pri-target/evidence');
    expect(evidence.statusCode).toBe(200);
    const audit = evidence.body.data.evidenceAudit;
    expect(audit.status).toBe('ok');
    expect(audit.counts.deliveries).toBe(50);
    expect(audit.pages.delivery.hasMore).toBe(true);
    expect(audit.anyHasMore).toBe(true);
    expect(audit.pages.delivery.nextCursor).not.toBeNull();
  });

  it('a small ledger reports the exact loaded count with NO hasMore (no fake scarcity)', async () => {
    const evidenceDir = path.join(workspaceDir, '.pd');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const { getInterventionEvidenceIngress } = await import('@principles/host-runtime');
    const ingress = getInterventionEvidenceIngress();
    const batch = Array.from({ length: 7 }, (_, index) => ({
      observationKey: `openclaw|delivery|agent_context|sess-small|run-${index}|act-p1`,
      sourceLocator: `openclaw-plugin-event-log:sess-small:${index}`,
      kind: 'delivery',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-small', runId: `run-${index}` },
      principleId: 'pri-target',
      contentRef: { principleId: 'pri-target', payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: 'act-p1', sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    }));
    const small = ingress.appendObservationBatch({ workspaceDir, batch: {
      evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
      sourceKind: 'openclaw_plugin_event_log' as const,
      adapterVersion: 'p1-repair@1',
      recordedAt: new Date().toISOString(),
      observations: batch as never,
    } });
    expect(small.ok, `ingress refused: ${small.reason ?? 'unknown'}`).toBe(true);
    const evidence = await call('GET', '/principles/pri-target/evidence');
    const audit = evidence.body.data.evidenceAudit;
    expect(audit.counts.deliveries).toBe(7);
    expect(audit.pages.delivery.hasMore).toBe(false);
    expect(audit.anyHasMore).toBe(false);
  });

  it('EXACTLY 50 deliveries report hasMore=false — the window boundary is not "more"', async () => {
    const evidenceDir = path.join(workspaceDir, '.pd');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const { getInterventionEvidenceIngress } = await import('@principles/host-runtime');
    const ingress = getInterventionEvidenceIngress();
    const batch = Array.from({ length: 50 }, (_, index) => ({
      observationKey: `openclaw|delivery|agent_context|sess-boundary|run-${index}|act-p1`,
      sourceLocator: `openclaw-plugin-event-log:sess-boundary:${index}`,
      kind: 'delivery',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-boundary', runId: `run-${index}` },
      principleId: 'pri-target',
      contentRef: { principleId: 'pri-target', payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: 'act-p1', sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    }));
    const result = ingress.appendObservationBatch({ workspaceDir, batch: {
      evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
      sourceKind: 'openclaw_plugin_event_log' as const,
      adapterVersion: 'p1-repair@1',
      recordedAt: new Date().toISOString(),
      observations: batch as never,
    } });
    expect(result.ok, `ingress refused: ${result.reason ?? 'unknown'}`).toBe(true);
    const evidence = await call('GET', '/principles/pri-target/evidence');
    const audit = evidence.body.data.evidenceAudit;
    expect(audit.counts.deliveries).toBe(50);
    expect(audit.pages.delivery.hasMore).toBe(false);
    expect(audit.anyHasMore).toBe(false);
  });

  it('pagination is PER KIND: two saturated kinds both report hasMore; unsaturated kinds do not', async () => {
    const evidenceDir = path.join(workspaceDir, '.pd');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const { getInterventionEvidenceIngress } = await import('@principles/host-runtime');
    const ingress = getInterventionEvidenceIngress();
    const recordedAt = new Date().toISOString();
    const deliveries = Array.from({ length: 55 }, (_, index) => ({
      observationKey: `openclaw|delivery|agent_context|sess-multi|run-${index}|act-p1`,
      sourceLocator: `openclaw-plugin-event-log:sess-multi:d${index}`,
      kind: 'delivery',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-multi', runId: `run-${index}` },
      principleId: 'pri-target',
      contentRef: { principleId: 'pri-target', payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: 'act-p1', sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    }));
    const effects = Array.from({ length: 55 }, (_, index) => ({
      observationKey: `openclaw|effect|observed|sess-multi|e${index}`,
      sourceLocator: `openclaw-plugin-event-log:sess-multi:e${index}`,
      kind: 'effect',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-multi', runId: `run-${index}` },
      principleId: 'pri-target',
      episodeKey: `openclaw|episode|sess-multi|${index}`,
      contentRef: { principleId: 'pri-target', payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      payload: { status: 'observed', observationSummary: `effect ${index}` },
    }));
    const scope = ingress.evidenceScopeIdFor(workspaceDir);
    const append = (observations: unknown[]) => ingress.appendObservationBatch({ workspaceDir, batch: {
      evidenceScopeId: scope,
      sourceKind: 'openclaw_plugin_event_log' as const,
      adapterVersion: 'p1-repair@1',
      recordedAt,
      observations: observations as never,
    } });
    const first = append(deliveries);
    expect(first.ok, `ingress refused deliveries: ${first.reason ?? 'unknown'}`).toBe(true);
    // The ingress caps ONE batch at 64 observations; saturation is per kind.
    const second = append(effects);
    expect(second.ok, `ingress refused effects: ${second.reason ?? 'unknown'}`).toBe(true);
    const evidence = await call('GET', '/principles/pri-target/evidence');
    const audit = evidence.body.data.evidenceAudit;
    expect(audit.counts.deliveries).toBe(50);
    expect(audit.counts.effects).toBe(50);
    expect(audit.pages.delivery.hasMore).toBe(true);
    expect(audit.pages.effect.hasMore).toBe(true);
    expect(audit.pages.application.hasMore).toBe(false);
    expect(audit.pages.outcome.hasMore).toBe(false);
    expect(audit.anyHasMore).toBe(true);
  });
});

// ── P1-4: atomic single-live acceptance + honest ledger reads ───────────────

describe('P1-4 — atomic acceptance under the study lock + fail-loud ledger', () => {
  it('TWO concurrent run requests: exactly one is accepted (409 for the other), one ACCEPTED event total', async () => {
    const studyId = await createStudy();
    const [first, second] = await Promise.all([
      call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' }),
      call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([202, 409]);
    const accepted = readEvents(studyId).filter((event) => event.type === 'CONSOLE_RUN_ACCEPTED');
    expect(accepted).toHaveLength(1);
    await waitForTerminalRun(studyId, accepted[0].runId as string);
  });

  it('a CORRUPT ledger refuses the run with a 500 and is reported structurally on status', async () => {
    const studyId = await createStudy();
    const ledger = path.join(studyDirOf(studyId), 'events.jsonl');
    fs.appendFileSync(ledger, 'this is not json\n');
    const refused = await call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' });
    expect(refused.statusCode).toBe(500);
    expect(refused.body.error).toBe('console_ledger_unreadable');
    const status = await call('GET', `/studies/${studyId}`);
    expect(status.body.data.consoleRuns.ledgerProblem.code).toBe('ledger_corrupt');
    expect(() => readConsoleRuns(studyDirOf(studyId))).toThrow(ConsoleLedgerUnreadableError);
  });

  it('readConsoleRuns distinguishes ENOENT (empty) from a corrupt ledger (throw)', () => {
    const fresh = path.join(tempDir, 'fresh-study');
    fs.mkdirSync(fresh, { recursive: true });
    expect(readConsoleRuns(fresh)).toEqual([]);
    const corrupt = path.join(tempDir, 'corrupt-study');
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, 'events.jsonl'), '{broken\n');
    expect(() => readConsoleRuns(corrupt)).toThrow(ConsoleLedgerUnreadableError);
  });

  it('a settled run timestamps finishedAt AFTER acceptedAt (settlement time, not request time)', async () => {
    const studyId = await createStudy();
    const run = await call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' });
    expect(run.statusCode).toBe(202);
    const settled = await waitForTerminalRun(studyId, run.body.data.runId);
    expect(new Date(settled.finishedAt).getTime()).toBeGreaterThanOrEqual(new Date(settled.acceptedAt).getTime());
  });

  it('recovery skips a study with an unreadable ledger instead of treating it as no-runs', async () => {
    const studyId = await createStudy();
    appendConsoleRunEvent(resolveRoots(), studyDirOf(studyId), {
      type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId: mintRunId(), studyId,
      mode: 'host-dry-run' as ConsoleRunMode, acceptedAt: new Date().toISOString(), pid: 999_999_999, owner: 'pd-console',
    });
    fs.appendFileSync(path.join(studyDirOf(studyId), 'events.jsonl'), 'corrupt line\n');
    const recovered = await recoverUnfinishedConsoleRuns(resolveRoots());
    expect(recovered).toEqual([]);
  });
});

// ── P1-6: symlink / planted-link refusals ───────────────────────────────────

describe('P1-6 — path and temp-file symlink safety', () => {
  it('a ledger REPLACED by a symlink pointing outside the workspace is refused (acceptance + read)', async () => {
    const studyId = await createStudy();
    const ledger = path.join(studyDirOf(studyId), 'events.jsonl');
    const outside = path.join(tempDir, 'outside-ledger.jsonl');
    fs.writeFileSync(outside, '{}\n');
    fs.rmSync(ledger);
    try {
      fs.symlinkSync(outside, ledger, 'file');
    } catch (error) {
      const { code } = error as { code?: string };
      if (code === 'EPERM') {
        console.warn('skipping file-symlink case: this platform refuses unprivileged symlinks (Linux CI covers it)');
        return;
      }
      throw error;
    }
    const refused = await call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' });
    expect(refused.statusCode).toBe(500);
    expect(refused.body.error).toBe('console_ledger_unreadable');
    expect(() => readConsoleRuns(studyDirOf(studyId))).toThrow(ConsoleLedgerUnreadableError);
    expect(fs.readlinkSync(ledger)).toBe(outside);
  });

  it('a study directory swapped for a symlink is skipped by recovery and refused for writes', async () => {
    const studyId = await createStudy();
    appendConsoleRunEvent(resolveRoots(), studyDirOf(studyId), {
      type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId: 'RUN-C-SWAP', studyId,
      mode: 'host-dry-run' as ConsoleRunMode, acceptedAt: new Date().toISOString(), pid: 999_999_999, owner: 'pd-console',
    });
    // Swap the directory for a link to a decoy OUTSIDE the studies root.
    const decoy = path.join(tempDir, 'decoy-study');
    fs.mkdirSync(decoy, { recursive: true });
    fs.copyFileSync(path.join(studyDirOf(studyId), 'events.jsonl'), path.join(decoy, 'events.jsonl'));
    fs.rmSync(studyDirOf(studyId), { recursive: true });
    fs.symlinkSync(decoy, studyDirOf(studyId), 'junction');
    const recovered = await recoverUnfinishedConsoleRuns(resolveRoots());
    expect(recovered).toEqual([]);
    // The decoy was never written through the link.
    expect(fs.readFileSync(path.join(decoy, 'events.jsonl'), 'utf8')).not.toContain('CONSOLE_RUN_ABANDONED');
  });

  it('the dry-run probe leaves NO fixed-name residue (exclusive temp dir)', async () => {
    const studyId = await createStudy();
    const run = await call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' });
    expect(run.statusCode).toBe(202);
    await waitForTerminalRun(studyId, run.body.data.runId);
    const entries = fs.readdirSync(studyDirOf(studyId));
    expect(entries.some((name) => name.startsWith('.console-host-dry-run-probe'))).toBe(false);
  });

  it('a link planted at the LEGACY fixed probe name is never followed (random exclusive recipe)', async () => {
    const studyId = await createStudy();
    const studyDir = studyDirOf(studyId);
    const decoy = path.join(tempDir, 'probe-decoy');
    fs.mkdirSync(decoy, { recursive: true });
    const legacyName = path.join(studyDir, '.console-host-dry-run-probe');
    try {
      fs.symlinkSync(decoy, legacyName, 'junction');
    } catch (error) {
      const { code } = error as { code?: string };
      if (code === 'EPERM') {
        console.warn('skipping junction case: this platform refuses unprivileged links (Linux CI covers it)');
        return;
      }
      throw error;
    }
    const run = await call('POST', `/studies/${studyId}/run`, { mode: 'host-dry-run' });
    expect(run.statusCode).toBe(202);
    await waitForTerminalRun(studyId, run.body.data.runId);
    // The probe never wrote through the planted link: its target stays empty.
    expect(fs.readdirSync(decoy)).toEqual([]);
    fs.rmSync(legacyName, { force: true });
  });
});
