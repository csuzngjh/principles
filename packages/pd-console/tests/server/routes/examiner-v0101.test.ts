/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §4/§5/§9/§12 — Examiner Console API route tests.
 *
 * Covers the v0.10.1 additions against the REAL backend path:
 *   - production evidence aggregate (degraded honesty: unavailable data is
 *     DEGRADED with reason/nextAction, never "zero events");
 *   - challenge-suite catalog (server-fixed keys) and suite-selected study
 *     creation with the frozen production snapshot + real pain lineage;
 *   - host readiness projection (zero host calls);
 *   - the §12.3 async run contract: 202 + runId, duplicate/concurrent
 *     refusal (409), restart recovery (ABANDONED / RESULT_UNKNOWN, never
 *     retried), host dry-run checklist with ZERO model calls, and the F2
 *     authorization gate (403 without an APPROVED bound record; accepted
 *     then loudly NOT executed this round — still zero model calls).
 *
 * Studies are created under PD_EXAMINER_STUDIES_ROOT (a temp dir) so test
 * runs never touch the repository's committed research artifacts. Study ids
 * are server-minted handles; every directory access re-validates the handle
 * charset before joining (defense in depth for the test-only reader).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleExaminerRoute } from '../../../src/server/routes/examiner.js';
import { readConsoleRuns, recoverUnfinishedConsoleRuns, appendConsoleRunEvent, mintRunId, CONSOLE_RUN_SCHEMA, type ConsoleRunMode } from '../../../src/server/routes/examiner-runs.js';
import { resolveStudyRoots } from '../../../src/server/routes/examiner-executor.js';

const STUDY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function createMockRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req = {
    method,
    url,
    on(event: string, handler: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    },
  };
  if (body !== undefined) {
    setTimeout(() => {
      for (const handler of listeners.data ?? []) handler(Buffer.from(JSON.stringify(body)));
      for (const handler of listeners.end ?? []) handler();
    }, 0);
  } else {
    setTimeout(() => {
      for (const handler of listeners.end ?? []) handler();
    }, 0);
  }
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

/** Test-side study directory reader: handle-charset-validated before joining. */
function studyDirOf(studyId: string): string {
  if (!STUDY_ID_PATTERN.test(studyId)) throw new Error(`test: refusing non-handle study id '${studyId}'`);
  const dir = path.resolve(studiesRoot, studyId);
  const rootPrefix = path.resolve(studiesRoot) + path.sep;
  if (!dir.startsWith(rootPrefix)) throw new Error('test: study dir escaped the studies root');
  return dir;
}

/** Read the study's event ledger (validated handle). */
function readEvents(studyId: string): Record<string, unknown>[] {
  return fs.readFileSync(path.join(studyDirOf(studyId), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-examiner-v0101-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  studiesRoot = path.join(tempDir, 'studies');
  fs.mkdirSync(studiesRoot, { recursive: true });
  process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: {
          'pri-target': {
            id: 'pri-target',
            text: '结论不得超越观察：对目标对象的断言必须先以当前证据核实。',
            triggerPattern: 't',
            action: 'a',
            status: 'active',
            priority: 'P1',
            scope: 'general',
            evaluability: 'manual_only',
            valueScore: 1,
            adherenceRate: 1,
            painPreventedCount: 0,
            derivedFromPainIds: ['pain-e2e-1'],
            ruleIds: [],
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
            version: 1,
          },
          'pri-archived': {
            id: 'pri-archived',
            text: 'archived',
            triggerPattern: 't',
            action: 'a',
            status: 'archived',
            priority: 'P2',
            scope: 'general',
            evaluability: 'manual_only',
            valueScore: 1,
            adherenceRate: 1,
            painPreventedCount: 0,
            derivedFromPainIds: [],
            ruleIds: [],
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
            version: 1,
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-11-01T00:00:00Z',
      },
    }),
  );
});

afterEach(() => {
  delete process.env.PD_EXAMINER_STUDIES_ROOT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function call(method: string, subPath: string, body?: unknown) {
  const res = createMockResponse();
  await handleExaminerRoute(createMockRequest(method, subPath, body), res, workspaceDir, subPath);
  return parseBody(res);
}

async function createStudy(suiteKey?: string, reps = 1) {
  const body: Record<string, unknown> = { targetPrincipleId: 'pri-target', experimentMode: 'full_library_incremental', repetitionsPerCase: reps };
  if (suiteKey !== undefined) body.suiteKey = suiteKey;
  const created = await call('POST', '/studies', body);
  expect(created.statusCode).toBe(200);
  return created.body.data as { studyId: string; plannedPairs: number; suiteKey: string; productionSnapshotMarkers: string[] };
}

/** Poll a study's console-run list until the current run reaches a terminal state. */
async function waitForTerminalRun(studyId: string, runId: string, timeoutMs = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await call('GET', `/studies/${studyId}`);
    const runs: any[] = status.body.data.consoleRuns?.runs ?? [];
    const found = runs.find((run) => run.runId === runId);
    if (found && found.status !== 'RUNNING') return found;
    if (Date.now() > deadline) throw new Error(`console run ${runId} did not settle in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Examiner v0.10.1 — production evidence aggregate (§4/§5)', () => {
  it('answers 404 for a principle that is not in the ledger', async () => {
    const res = await call('GET', '/principles/pri-missing/evidence');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('principle_not_found');
  });

  it('aggregates the ledger principle and reports EVERY unavailable lane as degraded — never as zero events', async () => {
    const res = await call('GET', '/principles/pri-target/evidence');
    expect(res.statusCode).toBe(200);
    const data = res.body.data;
    // Ledger facts come from the real ledger file.
    expect(data.principle.id).toBe('pri-target');
    expect(data.principle.status).toBe('active');
    expect(data.principle.derivedFromPainIds).toEqual(['pain-e2e-1']);
    expect(data.principle.ledgerStatusNote).toContain('ASSET lifecycle');
    // No state.db in this fixture: activations degrade with a reason, not an empty "ok".
    expect(data.activation.status).toBe('degraded');
    expect(typeof data.activation.reason).toBe('string');
    // Injection lane degrades loudly (globalReason), statuses stay an array.
    expect(data.injection.status).toBe('degraded');
    expect(typeof data.injection.globalReason).toBe('string');
    expect(Array.isArray(data.injection.statuses)).toBe(true);
    // Receipts degrade with coverage; audit degrades with zero counts AND a reason.
    expect(data.receipts.status).toBe('degraded');
    expect(data.evidenceAudit.counts).toEqual({ deliveries: 0, applications: 0, episodes: 0, effects: 0, outcomes: 0 });
    expect(data.evidenceAudit.status).toBe('degraded');
    expect(typeof data.evidenceAudit.reason).toBe('string');
    // The confirmation ladder and proof split exist and stay unpromoted.
    expect(data.evidenceAudit.deliveryConfirmations).toEqual({ prepared: 0, submitted: 0, hostAccepted: 0, contextPresent: 0, runtimeLoaded: 0 });
    expect(data.evidenceAudit.applicationProof).toEqual({ agentClaimed: 0, runtimeVerified: 0 });
    expect(typeof data.asOf).toBe('string');
  });
});

describe('Examiner v0.10.1 — challenge-suite catalog (§9)', () => {
  it('lists the fixed catalog with counts, gold provenance and the Gate 1 boundary', async () => {
    const res = await call('GET', '/suites');
    expect(res.statusCode).toBe(200);
    const suites = res.body.data.suites as any[];
    expect(suites.map((s) => s.key)).toEqual(['didactic-pair', 'calibration-core']);
    expect(suites[0].caseCount).toBe(2);
    expect(suites[1].caseCount).toBe(6);
    for (const suite of suites) {
      expect(suite.goldProvenance).toBe('SYNTHETIC_OFFLINE');
      expect(suite.goldGate).toContain('Gate 1');
      expect(typeof suite.suiteHash).toBe('string');
    }
  });

  it('creates a study on the calibration-core suite with real pain lineage and a frozen production snapshot', async () => {
    const created = await createStudy('calibration-core', 1);
    expect(created.suiteKey).toBe('calibration-core');
    // 6 cases x 1 repetition = 6 planned pairs.
    expect(created.plannedPairs).toBe(6);
    const status = await call('GET', `/studies/${created.studyId}`);
    const snapshot = status.body.data.productionSnapshot;
    expect(snapshot.schema).toBe('examiner-production-snapshot.v1');
    expect(snapshot.targetPrincipleId).toBe('pri-target');
    expect(Array.isArray(snapshot.experimentVsProduction.markers)).toBe(true);
    const mapping = JSON.parse(fs.readFileSync(path.join(studyDirOf(created.studyId), 'pain-mechanism-mapping.json'), 'utf8'));
    expect(mapping.painRefs).toEqual(['pain-e2e-1']);
    expect(mapping.observedFailure).toContain('pain-e2e-1');
    // The frozen files still verify with the appended snapshot present.
    const preflight = await call('POST', `/studies/${created.studyId}/preflight`);
    expect(preflight.statusCode).toBe(200);
    expect(preflight.body.data.ok).toBe(true);
  });

  it('falls back to the v0.9 didactic suite for an unrecognized suite key', async () => {
    const created = await createStudy('not-a-suite', 2);
    expect(created.suiteKey).toBe('didactic-pair');
    expect(created.plannedPairs).toBe(4);
  });
});

describe('Examiner v0.10.1 — host readiness projection (§6.2)', () => {
  it('reports the OpenClaw ceiling and requirements without host calls', async () => {
    const res = await call('GET', '/hosts/openclaw/readiness');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.host).toBe('openclaw');
    expect(res.body.data.maxProvableInjectionLevel).toBe('SUBMITTED');
    expect(res.body.data.executionModes).toEqual(['offline-stub', 'host-dry-run', 'f2-real-host']);
    expect(res.body.data.requirements.map((r: any) => r.id)).toContain('stage_r_authorization');
    expect(res.body.data.note).toContain('no host calls');
  });
});

describe('Examiner v0.10.1 — async execution contract (§12.3)', () => {
  it('accepts a host dry-run with 202 + runId, settles a checklist with ZERO model calls, and never starts the offline runner', async () => {
    const created = await createStudy();
    const run = await call('POST', `/studies/${created.studyId}/run`, { mode: 'host-dry-run' });
    expect(run.statusCode).toBe(202);
    expect(run.body.data.runId).toMatch(/^RUN-C-/);
    expect(run.body.data.status).toBe('ACCEPTED');
    const settled = await waitForTerminalRun(created.studyId, run.body.data.runId);
    // No authorization record exists in a fresh study → the dry-run FAILS its
    // prerequisite checklist loudly (that IS the Owner-facing answer).
    expect(['DRY_RUN_CHECKS_FAILED', 'DRY_RUN_CHECKS_PASSED']).toContain(settled.outcome);
    // The ledger carries the full checklist with the zero-model-call guarantee.
    const events = readEvents(created.studyId);
    const settledEvent = events.find((event) => event.runId === run.body.data.runId && event.type !== 'CONSOLE_RUN_ACCEPTED');
    expect(settledEvent !== undefined).toBe(true);
    expect(settledEvent!.type === 'CONSOLE_RUN_FINISHED' || settledEvent!.type === 'CONSOLE_RUN_FAILED').toBe(true);
    const checkIds = ((settledEvent!.checks as any[]) ?? []).map((check) => check.id);
    expect(checkIds).toContain('offline_contract_preflight');
    expect(checkIds).toContain('stage_r_authorization');
    expect(checkIds).toContain('host_cli_probe');
    expect(checkIds).toContain('model_calls_zero');
    // The offline study runner was NOT invoked (no RUN_STARTED from the dry-run).
    expect(events.some((event) => event.type === 'RUN_STARTED')).toBe(false);
  });

  it('refuses a second run while one is in progress (idempotency by refusal, 409)', async () => {
    const created = await createStudy();
    // A live accepting process holds the run open deterministically.
    appendConsoleRunEvent(resolveStudyRootsFromLab(), studyDirOf(created.studyId), {
      type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId: mintRunId(), studyId: created.studyId,
      mode: 'host-dry-run' as ConsoleRunMode, acceptedAt: new Date().toISOString(), pid: process.pid, owner: 'pd-console',
    });
    const second = await call('POST', `/studies/${created.studyId}/run`, { mode: 'host-dry-run' });
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('run_in_progress');
    // The refusal added NO new run event.
    expect(readEvents(created.studyId).filter((event) => event.type === 'CONSOLE_RUN_ACCEPTED')).toHaveLength(1);
  });

  it('refuses an async run while a synchronous offline execution is in flight', async () => {
    const created = await createStudy();
    fs.appendFileSync(path.join(studyDirOf(created.studyId), 'events.jsonl'), `${JSON.stringify({ type: 'RUN_STARTED', owner: 'test' })}\n`);
    const res = await call('POST', `/studies/${created.studyId}/run`, { mode: 'host-dry-run' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('run_in_progress');
  });

  it('recovers an unfinished run after a restart as ABANDONED / RESULT_UNKNOWN and never auto-retries', async () => {
    const created = await createStudy();
    // A dead accepting pid simulates a crashed server.
    appendConsoleRunEvent(resolveStudyRootsFromLab(), studyDirOf(created.studyId), {
      type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId: 'RUN-C-DEAD', studyId: created.studyId,
      mode: 'host-dry-run' as ConsoleRunMode, acceptedAt: new Date().toISOString(), pid: 999_999_999, owner: 'pd-console',
    });
    const roots = resolveStudyRootsFromLab();
    const recovered = await recoverUnfinishedConsoleRuns(roots);
    expect(recovered).toEqual([{ studyId: created.studyId, runId: 'RUN-C-DEAD' }]);
    // Second recovery is a no-op — the run is terminal now.
    expect(await recoverUnfinishedConsoleRuns(roots)).toEqual([]);
    const runs = readConsoleRuns(studyDirOf(created.studyId));
    expect(runs.find((run) => run.runId === 'RUN-C-DEAD')?.status).toBe('ABANDONED');
    expect(runs.find((run) => run.runId === 'RUN-C-DEAD')?.outcome).toBe('RESULT_UNKNOWN');
    // After recovery a NEW run may be started (the abandoned one is never retried).
    const again = await call('POST', `/studies/${created.studyId}/run`, { mode: 'host-dry-run' });
    expect(again.statusCode).toBe(202);
    await waitForTerminalRun(created.studyId, again.body.data.runId);
    const final = readConsoleRuns(studyDirOf(created.studyId)).filter((run) => run.runId === 'RUN-C-DEAD');
    expect(final).toHaveLength(1);
    expect(final[0].status).toBe('ABANDONED');
  });
});

describe('Examiner v0.10.1 — F2 authorization gate (§12.3/§13)', () => {
  it('refuses f2-real-host without an authorization record (403, structured reasons, no run event)', async () => {
    const created = await createStudy();
    const res = await call('POST', `/studies/${created.studyId}/run`, { mode: 'f2-real-host' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('real_execution_not_authorized');
    expect(res.body.message).toContain('run-authorization.json');
    expect(readEvents(created.studyId).some((event) => event.type === 'CONSOLE_RUN_ACCEPTED')).toBe(false);
  });

  it('refuses a record that is not an APPROVED F2 record bound to this study', async () => {
    const created = await createStudy();
    const studyDir = studyDirOf(created.studyId);
    const suite = JSON.parse(fs.readFileSync(path.join(studyDir, 'suite-manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(studyDir, 'run-authorization.json'), JSON.stringify({
      schema: 'challenge-stage-authorization.v1', stage: 'R', status: 'REQUESTED',
      studyId: created.studyId, suiteHash: suite.suiteHash, executionMode: 'F2-real-host',
    }));
    const res = await call('POST', `/studies/${created.studyId}/run`, { mode: 'f2-real-host' });
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toContain('APPROVED required');

    fs.writeFileSync(path.join(studyDir, 'run-authorization.json'), JSON.stringify({
      schema: 'challenge-stage-authorization.v1', stage: 'R', status: 'APPROVED',
      studyId: 'EXM-OTHER', suiteHash: suite.suiteHash, executionMode: 'F2-real-host',
    }));
    const bound = await call('POST', `/studies/${created.studyId}/run`, { mode: 'f2-real-host' });
    expect(bound.statusCode).toBe(403);
    expect(bound.body.message).toContain('different study id');
  });

  it('accepts a bound APPROVED record with 202, then settles LOUDLY as not-executed-this-round with zero model calls', async () => {
    const created = await createStudy();
    const studyDir = studyDirOf(created.studyId);
    const suite = JSON.parse(fs.readFileSync(path.join(studyDir, 'suite-manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(studyDir, 'run-authorization.json'), JSON.stringify({
      schema: 'challenge-stage-authorization.v1', stage: 'R', status: 'APPROVED',
      studyId: created.studyId, suiteHash: suite.suiteHash, executionMode: 'F2-real-host',
    }));
    const res = await call('POST', `/studies/${created.studyId}/run`, { mode: 'f2-real-host' });
    expect(res.statusCode).toBe(202);
    const settled = await waitForTerminalRun(created.studyId, res.body.data.runId);
    expect(settled.status).toBe('FAILED');
    expect(settled.outcome).toBe('F2_EXECUTION_NOT_ENABLED_THIS_ROUND');
    // Zero model calls and no offline runner start: the study ledger has no
    // RUN_STARTED from this path.
    const events = readEvents(created.studyId);
    expect(events.some((event) => event.type === 'RUN_STARTED')).toBe(false);
    expect(events.some((event) => event.type === 'CONSOLE_RUN_FAILED')).toBe(true);
  });
});

/** Resolve study roots the way the route does (lab root from the module layout). */
function resolveStudyRootsFromLab() {
  // The tests run from the repository: the lab root is the scripts/dev lab.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const labRoot = process.env.PD_EXAMINER_LAB_ROOT
    ? path.resolve(process.env.PD_EXAMINER_LAB_ROOT)
    : path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab');
  return resolveStudyRoots(labRoot, path.join(workspaceDir, '.pd', 'examiner'));
}
