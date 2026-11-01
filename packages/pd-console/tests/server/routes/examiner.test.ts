/**
 * SPEC-PD-EXAMINER-001 v0.9 §8 — Examiner Console API route tests.
 *
 * Exercises the REAL backend path end-to-end against a fixture workspace:
 * principle list (real ledger) → study creation (server-minted identity,
 * synthetic offline gold) → fail-closed preflight → offline-stub execution →
 * Report V2 generation → read-only report access. Also pins the safety
 * refusals: real execution modes are 403, study identities cannot collide,
 * and request input never constructs study paths (enumeration membership).
 *
 * Studies are created under PD_EXAMINER_STUDIES_ROOT (a temp dir) so test
 * runs never touch the repository's committed research artifacts — one test
 * pins the production default, `<workspace>/.pd/examiner/studies`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleExaminerRoute, resolveLabRoot } from '../../../src/server/routes/examiner.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const historicalStudiesRoot = path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab', 'examiner-studies');

/**
 * Full-directory fingerprint (relative path → type/content/link-target hash).
 * Used to prove a refused console action mutated NOTHING in a historical or
 * frozen study — not even a lock file, ledger line or directory.
 */
function fingerprintTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    // Entry types come from the directory read itself. A separate lstat before
    // each access is a check-then-use pattern (and a TOCTOU window).
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        entries[relPath] = `link:${fs.readlinkSync(abs)}`;
      } else if (entry.isDirectory()) {
        entries[relPath] = 'dir';
        walk(abs, relPath);
      } else {
        entries[relPath] = `file:${createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
      }
    }
  };
  walk(root, '');
  return entries;
}

function readJsonFile(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-examiner-route-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  studiesRoot = path.join(tempDir, 'studies');
  fs.mkdirSync(studiesRoot, { recursive: true });
  process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
  // fixture ledger with one ACTIVE principle (the study target) and one
  // archived principle (must be excluded by HEPS eligibility)
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
            derivedFromPainIds: [],
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

describe('Examiner Console API (offline-first, SPEC v0.9 §8)', () => {
  it('overview reports gates, host capability and the study list', async () => {
    const { statusCode, body } = await call('GET', '/overview');
    expect(statusCode).toBe(200);
    expect(body.data.gates.gate1_challenge_trust).toContain('BLOCKED');
    expect(body.data.executionScope).toContain('offline-stub only');
    expect(body.data.hostInjectionCapability['offline-stub']).toBe('RUNTIME_LOADED');
    expect(Array.isArray(body.data.studies)).toBe(true);
  });

  it('principles lists the real workspace ledger (read-only inputs)', async () => {
    const { statusCode, body } = await call('GET', '/principles');
    expect(statusCode).toBe(200);
    const ids = body.data.principles.map((p: any) => p.id);
    expect(ids).toContain('pri-target');
  });

  it('full journey: create → preflight → run → report with real backend state', async () => {
    // create (server-minted identity)
    const created = await call('POST', '/studies', { targetPrincipleId: 'pri-target', experimentMode: 'full_library_incremental', repetitionsPerCase: 1 });
    expect(created.statusCode).toBe(200);
    const studyId = created.body.data.studyId as string;
    expect(studyId).toMatch(/^EXM-C-[0-9A-F-]+$/);
    expect(created.body.data.experimentMode).toBe('full_library_incremental');
    // preflight passes offline
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.statusCode).toBe(200);
    expect(preflight.body.data.ok).toBe(true);
    expect(preflight.body.data.status).toBe('READY_FOR_OFFLINE_EXECUTION');
    // offline execution succeeds with the frozen randomized order
    const run = await call('POST', `/studies/${studyId}/run`);
    expect(run.statusCode).toBe(200);
    expect(run.body.data.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    // status reflects the ledger truth
    const status = await call('GET', `/studies/${studyId}`);
    expect(status.body.data.runFinished).toBe(true);
    expect(status.body.data.unitStates.SUCCEEDED).toBeGreaterThan(0);
    expect(status.body.data.reportStatus).toBeNull();
    // report generation then read-only access
    const report = await call('POST', `/studies/${studyId}/report`);
    expect(report.statusCode).toBe(200);
    const fetched = await call('GET', `/studies/${studyId}/report`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body.data.report.examiner.experimentMode).toBe('full_library_incremental');
    expect(fetched.body.data.report.examiner.itt.plannedApplicablePairs).toBeGreaterThan(0);
    // synthetic gold → honest REPORT_PENDING, never READY
    expect(['REPORT_PENDING', 'REPORT_INCONCLUSIVE']).toContain(fetched.body.data.report.status);
  });

  it('refuses real execution modes at the route boundary (403, no runner call)', async () => {
    const created = await call('POST', '/studies', { targetPrincipleId: 'pri-target' });
    const studyId = created.body.data.studyId as string;
    const refused = await call('POST', `/studies/${studyId}/run`, { mode: 'F2-real-host' });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toBe('real_execution_not_authorized');
    // nothing ran
    const status = await call('GET', `/studies/${studyId}`);
    expect(status.body.data.runStarted).toBe(false);
  });

  it('rejects unknown target principles and invalid ids (validation first)', async () => {
    const missing = await call('POST', '/studies', { targetPrincipleId: 'pri-nope' });
    expect(missing.statusCode).toBe(404);
    const invalid = await call('POST', '/studies', { targetPrincipleId: 'bad id!' });
    expect(invalid.statusCode).toBe(400);
    const unknownStudy = await call('GET', '/studies/EXM-C-DOES-NOT-EXIST');
    expect(unknownStudy.statusCode).toBe(404);
  });

  it('study selection is enumeration-bounded (path traversal shapes are just not found)', async () => {
    const traversal = await call('GET', '/studies/..%2F..%2Fetc');
    expect([400, 404]).toContain(traversal.statusCode);
    expect(traversal.body.data).toBeUndefined();
  });
});

describe('Examiner Console write isolation (v0.9 §1)', () => {
  it('historical acceptance studies are readable but every write is refused, and nothing changes on disk', async () => {
    for (const studyId of ['EXM-V09-ACC-FULL', 'EXM-V09-ACC-ISO']) {
      const studyDir = path.join(historicalStudiesRoot, studyId);
      const before = fingerprintTree(studyDir);

      const status = await call('GET', `/studies/${studyId}`);
      expect(status.statusCode).toBe(200);
      expect(status.body.data.readOnly).toBe(true);
      expect(status.body.data.access).toContain('historical research asset');

      const report = await call('GET', `/studies/${studyId}/report`);
      expect(report.statusCode).toBe(200);
      expect(report.body.data.readOnly).toBe(true);

      const run = await call('POST', `/studies/${studyId}/run`);
      expect(run.statusCode).toBe(403);
      expect(run.body.error).toBe('study_read_only');

      const write = await call('POST', `/studies/${studyId}/report`);
      expect(write.statusCode).toBe(403);
      expect(write.body.error).toBe('study_read_only');

      expect(fingerprintTree(studyDir)).toEqual(before);
    }
  });

  it('a directory under the writable root without a matching server marker is read-only (name membership is not ownership)', async () => {
    const studyId = 'EXM-C-UNOWNED0001';
    const studyDir = path.join(studiesRoot, studyId);
    fs.mkdirSync(studyDir, { recursive: true });
    fs.writeFileSync(path.join(studyDir, 'examiner-manifest.json'), JSON.stringify({ studyId }));

    const unowned = await call('GET', `/studies/${studyId}`);
    expect(unowned.statusCode).toBe(200);
    expect(unowned.body.data.readOnly).toBe(true);
    const unownedRun = await call('POST', `/studies/${studyId}/run`);
    expect(unownedRun.statusCode).toBe(403);
    expect(unownedRun.body.error).toBe('study_read_only');

    // A forged marker that names a different study is still refused.
    fs.writeFileSync(
      path.join(studyDir, '.console-study-owner.json'),
      JSON.stringify({
        schema: 'examiner-console-ownership.v1',
        origin: 'pd-console',
        studyId: 'EXM-C-SOMEONE-ELSE',
        writableRoot: fs.realpathSync(studiesRoot),
      }),
    );
    const forged = await call('GET', `/studies/${studyId}`);
    expect(forged.body.data.readOnly).toBe(true);

    // Correcting the identity alone is not enough either: the manifest must
    // agree and the marker must have been issued for this root.
    fs.writeFileSync(
      path.join(studyDir, '.console-study-owner.json'),
      JSON.stringify({
        schema: 'examiner-console-ownership.v1',
        origin: 'pd-console',
        studyId,
        writableRoot: fs.realpathSync(studiesRoot),
      }),
    );
    const corrected = await call('GET', `/studies/${studyId}`);
    expect(corrected.body.data.readOnly).toBe(false);
    const correctedWrite = await call('POST', `/studies/${studyId}/report`);
    expect(correctedWrite.statusCode).not.toBe(403);
  });

  it('treats an unreadable ownership marker as read-only without leaking exception text', async () => {
    const studyId = 'EXM-C-BROKENMARK01';
    const studyDir = path.join(studiesRoot, studyId);
    fs.mkdirSync(studyDir, { recursive: true });
    fs.writeFileSync(path.join(studyDir, 'examiner-manifest.json'), JSON.stringify({ studyId }));
    fs.writeFileSync(path.join(studyDir, '.console-study-owner.json'), '{ not json');

    const status = await call('GET', `/studies/${studyId}`);
    expect(status.statusCode).toBe(200);
    expect(status.body.data.readOnly).toBe(true);
    expect(status.body.data.access).toContain('unreadable');
    // The refusal reason is our own vocabulary: no parser message, no paths.
    expect(status.body.data.access).not.toContain('SyntaxError');
    expect(status.body.data.access).not.toContain(studiesRoot);
  });

  it('refuses to create studies when the writable root is not separated from the historical research area', async () => {
    process.env.PD_EXAMINER_STUDIES_ROOT = historicalStudiesRoot;
    try {
      const res = await call('POST', '/studies', { targetPrincipleId: 'pri-target' });
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe('writable_root_not_isolated');
      // Nothing was enumerated or created in the historical area.
      expect(fs.readdirSync(historicalStudiesRoot).sort()).toEqual(['EXM-V09-ACC-FULL', 'EXM-V09-ACC-ISO', 'acceptance-summary.json']);
    } finally {
      process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
    }
  });
});

describe('Examiner Console run gate (v0.9 §5)', () => {
  it('POST /run refuses a study whose frozen artifacts drifted after preflight: 409, no RUN_STARTED, no lock, no ledger, no mutation', async () => {
    const created = await call('POST', '/studies', {
      targetPrincipleId: 'pri-target',
      experimentMode: 'full_library_incremental',
      repetitionsPerCase: 1,
    });
    expect(created.statusCode).toBe(200);
    const studyId = created.body.data.studyId as string;
    const studyDir = path.join(studiesRoot, studyId);

    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(true);

    // Rewrite a frozen fact. The rewrite is internally consistent (the HEPS
    // snapshot is recomputed from its own file), so only the immutable anchor
    // can catch it — the point of the cross-file binding.
    const hepsFile = path.join(studyDir, 'heps-principles.json');
    const heps = readJsonFile(hepsFile);
    heps.principles = heps.principles.map((p: any) =>
      p.id === heps.targetPrincipleId ? { ...p, text: `${p.text} (rewritten after preflight)` } : p,
    );
    fs.writeFileSync(hepsFile, JSON.stringify(heps, null, 2));
    const before = fingerprintTree(studyDir);

    const run = await call('POST', `/studies/${studyId}/run`);
    expect(run.statusCode).toBe(409);
    expect(run.body.error).toBe('preflight_blocked');

    expect(fingerprintTree(studyDir)).toEqual(before);
    expect(fs.existsSync(path.join(studyDir, 'runs', 'writer.lock'))).toBe(false);
    expect(fs.existsSync(path.join(studyDir, 'budget-ledger.jsonl'))).toBe(false);
    const eventsFile = path.join(studyDir, 'events.jsonl');
    expect(fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '').not.toContain('RUN_STARTED');

    // The study is not poisoned: restoring the frozen fact lets the run proceed.
    fs.writeFileSync(hepsFile, JSON.stringify(heps, null, 2).replace(' (rewritten after preflight)', ''));
    const retried = await call('POST', `/studies/${studyId}/run`);
    expect(retried.statusCode).toBe(200);
    expect(retried.body.data.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    expect(fs.existsSync(path.join(studyDir, 'runs', 'writer.lock'))).toBe(false);
  });

  it('drift discovered only at LOCK TIME (after the server preflight passed) is a 409 with zero side effects', async () => {
    const created = await call('POST', '/studies', {
      targetPrincipleId: 'pri-target',
      experimentMode: 'full_library_incremental',
      repetitionsPerCase: 1,
    });
    expect(created.statusCode).toBe(200);
    const studyId = created.body.data.studyId as string;
    const studyDir = path.join(studiesRoot, studyId);

    // First preflight passes: every file the console gate inspects is intact.
    const preflight = await call('POST', `/studies/${studyId}/preflight`);
    expect(preflight.body.data.ok).toBe(true);

    // Drift a file only the RUNNER's under-lock verification re-hashes
    // (judge-only gold). The console preflight does not read it, so this is
    // exactly the "changed after preflight, caught under the lock" race.
    const suite = readJsonFile(path.join(studyDir, 'suite-manifest.json'));
    const caseId = suite.cases[0].caseId as string;
    const judgeFile = path.join(studyDir, 'judge-only', `${caseId}.json`);
    const judge = readJsonFile(judgeFile);
    judge.extraActions = { ...(judge.extraActions ?? {}), deploy: !judge.extraActions?.deploy };
    fs.writeFileSync(judgeFile, JSON.stringify(judge, null, 2));
    const afterDrift = fingerprintTree(studyDir);

    const run = await call('POST', `/studies/${studyId}/run`);
    expect(run.statusCode).toBe(409);
    expect(run.body.error).toBe('preflight_blocked');
    expect(Array.isArray(run.body.blockers)).toBe(true);
    expect(run.body.blockers[0].id).toBe('frozen_study_drift');
    expect(run.body.blockers[0].problems.join(' ')).toContain('goldHash drift');
    // No stack, no absolute path, no parser text in the operator payload.
    const serialized = JSON.stringify(run.body);
    expect(serialized).not.toContain(studyDir);
    expect(serialized).not.toContain('FrozenStudyDriftError');
    expect(serialized).not.toMatch(/\bat .*:\d+:\d+/);

    // Zero side effects: no RUN_STARTED, no lock, no budget row, no attempt.
    // (The lock acquisition may leave an EMPTY runs/ directory; it must hold
    // nothing at all.)
    const withoutRuns = (fp: Record<string, string>) =>
      Object.fromEntries(Object.entries(fp).filter(([key]) => key !== 'runs' && !key.startsWith('runs/')));
    expect(withoutRuns(fingerprintTree(studyDir))).toEqual(withoutRuns(afterDrift));
    expect(fs.existsSync(path.join(studyDir, 'runs', 'writer.lock'))).toBe(false);
    expect(fs.existsSync(path.join(studyDir, 'budget-ledger.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(studyDir, 'runs', caseId))).toBe(false);
    const runsDir = path.join(studyDir, 'runs');
    expect(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []).toEqual([]);
    const eventsFile = path.join(studyDir, 'events.jsonl');
    expect(fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '').not.toContain('RUN_STARTED');
  });
});

describe('Examiner product surface (ships with the console payload)', () => {
  it('resolves the lab from an explicit override, the installed sibling, or the repository layout', () => {
    const installedConsole = path.join(tempDir, 'console');
    const installedLab = path.join(installedConsole, 'lab');
    fs.mkdirSync(path.join(installedLab, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(installedLab, 'lib', 'examiner-study.mjs'), 'export {};');
    const installedModule = pathToFileURL(path.join(installedConsole, 'dist', 'server', 'routes', 'examiner.js')).href;

    // installed layout: <console>/lab sits next to <console>/dist
    expect(resolveLabRoot(installedModule, {})).toBe(installedLab);
    // repository layout: this checkout's scripts/dev lab (no console/lab present)
    const repoModule = pathToFileURL(path.join(repoRoot, 'packages', 'pd-console', 'dist', 'server', 'routes', 'examiner.js')).href;
    expect(resolveLabRoot(repoModule, {})).toBe(path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab'));
    // explicit override wins over both
    expect(resolveLabRoot(repoModule, { PD_EXAMINER_LAB_ROOT: installedLab })).toBe(installedLab);

    // a candidate without the entry module is not evidence of a lab
    const emptyConsole = path.join(tempDir, 'no-lab-console');
    fs.mkdirSync(path.join(emptyConsole, 'lab', 'lib'), { recursive: true });
    const emptyModule = pathToFileURL(path.join(emptyConsole, 'dist', 'server', 'routes', 'examiner.js')).href;
    expect(resolveLabRoot(emptyModule, { PD_EXAMINER_LAB_ROOT: path.join(emptyConsole, 'lab') })).toBeNull();
  });

  it('serves the offline research panel in a production runtime (no dev-only gate)', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDev = process.env.PD_EXAMINER_DEV;
    process.env.NODE_ENV = 'production';
    process.env.PD_EXAMINER_DEV = '1';
    try {
      const res = await call('GET', '/overview');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.gates.gate4_product_integration).toContain('ACTIVE');
      expect(res.body.data.executionScope).toContain('offline-stub only');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDev === undefined) delete process.env.PD_EXAMINER_DEV;
      else process.env.PD_EXAMINER_DEV = previousDev;
    }
  });

  it('stores new studies as workspace data under <workspace>/.pd/examiner/studies by default', async () => {
    delete process.env.PD_EXAMINER_STUDIES_ROOT;
    try {
      const created = await call('POST', '/studies', { targetPrincipleId: 'pri-target' });
      expect(created.statusCode).toBe(200);
      const studyId = created.body.data.studyId as string;
      const defaultRoot = path.join(workspaceDir, '.pd', 'examiner', 'studies');
      expect(fs.existsSync(path.join(defaultRoot, studyId, 'examiner-manifest.json'))).toBe(true);

      const overview = await call('GET', '/overview');
      expect(overview.body.data.studiesAreWorkspaceData).toBe(true);
      expect(path.resolve(overview.body.data.writableStudiesRoot).toLowerCase())
        .toBe(fs.realpathSync.native(defaultRoot).toLowerCase());
      // The repository's research lab is never a console write target.
      expect(fs.existsSync(path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab', 'examiner-console-studies'))).toBe(false);
    } finally {
      process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
    }
  });
});
