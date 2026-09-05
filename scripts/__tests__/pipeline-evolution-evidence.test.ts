// PRI-685 Evidence Foundation — integration tests for the experiment-scoped
// evidence collector and evidence package builder.
//
// Fixtures are synthetic workspaces (state.db + trajectory.db + telemetry
// jsonl) created with better-sqlite3 in a temp dir, exercising the real CLI
// via a boundary-validated subprocess helper. The real PRI-653 lab data test
// at the bottom skips when the lab directory is absent (CI has no D:\pd-labs).

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// Every test in this file spawns the real collector CLI (node process spawn
// ≈2s each on Windows); the vitest default 5s is too tight under parallel
// suite load, which caused intermittent false timeouts.
const SPAWN_TEST_TIMEOUT = 60_000;
const itSpawn = (name: string, fn: () => Promise<void>) => it(name, fn, SPAWN_TEST_TIMEOUT);

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3'); // resolved from the repo root, same as the collector

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEV_DIR = path.join(REPO_ROOT, 'scripts', 'dev');
const REAL_LAB = 'D:\\pd-labs\\pri653-e1';

let root: string;
let seedCounter = 0;

// --- subprocess helpers: entry paths are boundary-validated against
// scripts/dev before being handed to the interpreter (accepted shape). ---
function resolveDevScript(rel: string): string {
  const entry = path.resolve(DEV_DIR, rel);
  if (!entry.startsWith(DEV_DIR + path.sep)) throw new Error(`refusing script outside scripts/dev: ${rel}`);
  if (!fs.existsSync(entry)) throw new Error(`script not found: ${entry}`);
  return entry;
}

type RunResult = { code: number; stdout: string; stderr: string };

async function runScript(rel: string, args: string[]): Promise<RunResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const entry = resolveDevScript(rel);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

async function runCollector(args: string[]): Promise<string> {
  const r = await runScript('pipeline-evolution/collect-evidence.mjs', args);
  if (r.code !== 0) throw new Error(`collector failed (${r.code}): ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8');
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseCollectorJson(stdout: string) {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

function manifest(partial: Record<string, unknown>) {
  return {
    schemaVersion: 'experiment-manifest.v1',
    experimentId: 'EXP-A',
    scenarioId: 'S001',
    scenarioVersion: '1',
    pdCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    host: 'openclaw',
    hostVersion: 'test',
    model: { provider: 'test', name: 'test-model', thinking: null, timeoutMs: null },
    featureFlags: {},
    fixtureHash: null,
    workspaceFingerprint: null,
    sessionIds: [],
    painIds: [],
    correlations: [],
    startedAt: '2026-09-01T09:00:00.000Z',
    finishedAt: null,
    behaviorObservation: null,
    ...partial,
  };
}

const STATE_DDL = [
  'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_kind TEXT, status TEXT, attempt_count INTEGER, created_at TEXT, updated_at TEXT)',
  'CREATE TABLE runs (run_id TEXT, task_id TEXT, execution_status TEXT, reason TEXT, started_at TEXT)',
  'CREATE TABLE pi_artifacts (artifact_id TEXT PRIMARY KEY, artifact_kind TEXT, source_task_id TEXT, content_json TEXT, validation_status TEXT, created_at TEXT, updated_at TEXT)',
  'CREATE TABLE principle_candidates (candidate_id TEXT PRIMARY KEY, task_id TEXT, status TEXT, confidence REAL, created_at TEXT)',
  'CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, artifact_id TEXT, channel TEXT, status TEXT, requested_at TEXT, decided_at TEXT)',
  'CREATE TABLE activations (activation_id TEXT, idempotency_key TEXT, artifact_id TEXT, channel TEXT, action TEXT, target_ref TEXT, activated_at TEXT)',
];

const TRAJECTORY_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT, updated_at TEXT)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT, outcome TEXT, created_at TEXT)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, source TEXT, score INTEGER, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT)',
];

function createDb(file: string, ddl: string[]) {
  const db = new Database(file);
  for (const stmt of ddl) db.prepare(stmt).run();
  return db;
}

// ---------------------------------------------------------------------------
// Fixture: one workspace hosting TWO experiments, plus an empty session for
// the missing-evidence case. Experiment A runs a full-ish chain (ends at
// needs_human_review); experiment B dies in diagnosis.
// ---------------------------------------------------------------------------

const SID_A = 'session-aaa';
const SID_B = 'session-bbb';
const SID_C = 'session-ccc';
const T_CONST = '2026-09-01T10:00:00.000Z'; // seeded task/artifact timestamps

function seedWorkspace() {
  const ws = path.join(root, `ws-${String(++seedCounter).padStart(3, '0')}`);
  const main = path.join(ws, 'main');
  fs.mkdirSync(path.join(main, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(main, '.state'), { recursive: true });
  fs.mkdirSync(path.join(main, '.pd', 'telemetry'), { recursive: true });

  const state = createDb(path.join(main, '.pd', 'state.db'), STATE_DDL);
  const traj = createDb(path.join(main, '.state', 'trajectory.db'), TRAJECTORY_DDL);

  const insTask = state.prepare(
    'INSERT INTO tasks (task_id, task_kind, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  );
  const T = '2026-09-01T10:00:00.000Z';

  // Experiment A: pain → diagnosis → candidate → peer chain (prompt channel)
  traj.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run(SID_A, T, T);
  traj
    .prepare(
      'INSERT INTO pain_events (session_id, source, score, reason, canonical_pain_id, created_at) VALUES (?, ?, 70, ?, ?, ?)',
    )
    .run(SID_A, 'manual', 'real correction A', 'painA', T);
  insTask.run('diagnosis_painA', 'diagnostician', 'succeeded', T, T);
  insTask.run('diag_rootcause-diagnosis_painA', 'diag_rootcause', 'succeeded', T, T);
  insTask.run('diag_distiller-diagnosis_painA', 'diag_distiller', 'succeeded', T, T);
  insTask.run('diag_router-diagnosis_painA', 'diag_router', 'succeeded', T, T);
  state
    .prepare("INSERT INTO principle_candidates (candidate_id, task_id, status, confidence, created_at) VALUES (?, 'diag_router-diagnosis_painA', 'consumed', 0.9, ?)")
    .run('candA', T);
  for (const kind of ['dreamer', 'philosopher', 'scribe', 'artificer']) {
    insTask.run(`${kind}-candA-prompt`, kind, 'succeeded', T, T);
  }
  insTask.run('evaluator-candA-prompt', 'evaluator', 'needs_human_review', T, T);
  state
    .prepare(
      "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, content_json, validation_status, created_at, updated_at) VALUES (?, 'principle', 'philosopher-candA-prompt', '{\"valid\":true}', 'pending', ?, ?)",
    )
    .run('pi-art-A1', T, T);

  // Experiment B: pain captured, diagnosis fails, chain never proceeds.
  const TB = '2026-09-01T18:00:00.000Z';
  traj.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run(SID_B, TB, TB);
  traj
    .prepare(
      'INSERT INTO pain_events (session_id, source, score, reason, canonical_pain_id, created_at) VALUES (?, ?, 70, ?, ?, ?)',
    )
    .run(SID_B, 'manual', 'real correction B', 'painB', TB);
  insTask.run('diagnosis_painB', 'diagnostician', 'failed', TB, TB);
  insTask.run('diag_rootcause-diagnosis_painB', 'diag_rootcause', 'failed', TB, TB);
  state
    .prepare("INSERT INTO runs (run_id, task_id, execution_status, reason, started_at) VALUES ('r1', 'diagnosis_painB', 'failed', '[timeout] LLM request timed out', ?)")
    .run(TB);

  // Experiment C surface: a session with no pain at all.
  traj.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run(SID_C, T, T);

  // Tool calls: 250 rows on session A → toolCalls collection must mark truncation.
  const insTool = traj.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 250; i += 1) insTool.run(SID_A, 'Bash', 'ok', T);

  // Telemetry: 25 adversarial events inside A's window + 1 in B's window.
  const lines = [];
  for (let i = 0; i < 25; i += 1) {
    lines.push(JSON.stringify({ timestamp: '2026-09-01T11:00:00.000Z', eventType: 'evaluator_adversarial_case', payload: { i } }));
  }
  lines.push(JSON.stringify({ timestamp: '2026-09-01T19:00:00.000Z', eventType: 'evaluator_adversarial_case', payload: { exp: 'B' } }));
  lines.push(JSON.stringify({ timestamp: '2026-08-31T00:00:00.000Z', eventType: 'unrelated_event', payload: {} }));
  fs.writeFileSync(path.join(main, '.pd', 'telemetry', 'critical-events.jsonl'), lines.join('\n') + '\n', 'utf8');

  state.close();
  traj.close();
  return ws;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'pd-evidence-test-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('experiment isolation (两个实验数据不能串线)', () => {
  let pkgA: string;
  let pkgB: string;

  beforeAll(async () => {
    const ws = seedWorkspace();
    const mA = path.join(root, 'manifest-A.json');
    const mB = path.join(root, 'manifest-B.json');
    writeJson(mA, manifest({ experimentId: 'EXP-A', sessionIds: [SID_A], startedAt: '2026-09-01T09:00:00.000Z', finishedAt: '2026-09-01T12:00:00.000Z' }));
    writeJson(mB, manifest({ experimentId: 'EXP-B', sessionIds: [SID_B], startedAt: '2026-09-01T17:00:00.000Z', finishedAt: '2026-09-01T20:00:00.000Z' }));
    pkgA = path.join(root, 'pkg-A');
    pkgB = path.join(root, 'pkg-B');
    await runCollector(['--workspace', ws, '--experiment', mA, '--package', pkgA]);
    await runCollector(['--workspace', ws, '--experiment', mB, '--package', pkgB]);
  }, 60_000);

  it('A sees only A chains, B sees only B chains', () => {
    const a = readJson(path.join(pkgA, 'collected.json'));
    const b = readJson(path.join(pkgB, 'collected.json'));
    const corrA = a.chains.map((c: { correlation: string }) => c.correlation).sort();
    const corrB = b.chains.map((c: { correlation: string }) => c.correlation).sort();
    expect(corrA).toEqual(['candA', 'diagnosis_painA']);
    expect(corrB).toEqual(['diagnosis_painB']);
    for (const c of corrB) expect(corrA).not.toContain(c);
  });

  it('pains and candidates do not leak across experiments', () => {
    const a = readJson(path.join(pkgA, 'collected.json'));
    const b = readJson(path.join(pkgB, 'collected.json'));
    expect(a.trajectory.pains.map((p: { canonical_pain_id: string }) => p.canonical_pain_id)).toEqual(['painA']);
    expect(b.trajectory.pains.map((p: { canonical_pain_id: string }) => p.canonical_pain_id)).toEqual(['painB']);
    expect(a.candidates.map((c: { candidate_id: string }) => c.candidate_id)).toEqual(['candA']);
    expect(b.candidates).toEqual([]);
  });

  it('telemetry adversarial events are window-scoped per experiment', () => {
    const a = readJson(path.join(pkgA, 'collected.json'));
    const b = readJson(path.join(pkgB, 'collected.json'));
    // A's window (09:00–12:00) holds 25 events; the returned set is capped…
    expect(a.adversarialEvents.length).toBe(20);
    expect(a.truncation.adversarialEvents).toEqual({ returned: 20, total: 25, truncated: true });
    // …while B's window only ever sees its own event.
    expect(b.adversarialEvents).toHaveLength(1);
    expect(b.adversarialEvents[0].payload).toContain('"exp":"B"');
  });

  it('derives the right claims per experiment', () => {
    const ia = readJson(path.join(pkgA, 'evidence-index.json'));
    const ib = readJson(path.join(pkgB, 'evidence-index.json'));
    const byClaim = (idx: { claims: { claim: string; status: string }[] }, name: string) =>
      idx.claims.find((c) => c.claim === name)?.status;
    expect(byClaim(ia, 'pain_captured')).toBe('CONFIRMED');
    expect(byClaim(ia, 'rule_generated')).toBe('CONFIRMED');
    expect(byClaim(ia, 'replay_executed')).toBe('CONFIRMED');
    expect(byClaim(ia, 'owner_decision')).toBe('BLOCKED'); // needs_human_review task
    expect(byClaim(ia, 'activation')).toBe('UNKNOWN');
    expect(byClaim(ia, 'behavior_change')).toBe('NOT_REACHED'); // no activation → never claim improvement
    expect(byClaim(ib, 'pain_captured')).toBe('CONFIRMED');
    expect(byClaim(ib, 'diagnosis_completed')).toBe('NOT_CONFIRMED');
    expect(byClaim(ib, 'principle_generated')).toBe('UNKNOWN'); // not reached, not failed
  });

  it('metrics never turn missing evidence into PASS', () => {
    const mb = readJson(path.join(pkgB, 'metrics.json'));
    const row = (name: string) => mb.pipeline.find((p: { metric: string }) => p.metric === name)?.status;
    expect(row('pain_captured')).toBe('PASS');
    expect(row('diagnosis_completed')).toBe('FAIL');
    expect(row('principle_generated')).toBe('UNKNOWN');
    // B's own window contains its adversarial telemetry event — telemetry is
    // the replay authority, so this PASS is window-scoped evidence, not a guess.
    expect(row('replay_executed')).toBe('PASS');
    expect(row('owner_decision')).toBe('UNKNOWN');
    expect(row('activation')).toBe('UNKNOWN');
    expect(mb.behavior.status).toBe('NOT_REACHED');
  });
}, 60_000);

describe('missing evidence stays non-PASS (缺失 evidence 时不能 PASS)', () => {
  itSpawn('a session with no pain yields NOT_CONFIRMED capture and UNKNOWN metrics', async () => {
    const ws = seedWorkspace();
    const mC = path.join(root, 'manifest-C.json');
    writeJson(mC, manifest({ experimentId: 'EXP-C', sessionIds: [SID_C] }));
    const pkgDir = path.join(root, 'pkg-C');
    await runCollector(['--workspace', ws, '--experiment', mC, '--package', pkgDir]);
    const collected = readJson(path.join(pkgDir, 'collected.json'));
    expect(collected.trajectory.pains).toEqual([]);
    const idx = readJson(path.join(pkgDir, 'evidence-index.json'));
    const claims = new Map(idx.claims.map((c: { claim: string; status: string }) => [c.claim, c.status]));
    expect(claims.get('pain_captured')).toBe('NOT_CONFIRMED');
    expect(claims.get('pain_admitted')).toBe('NOT_CONFIRMED');
    const metrics = readJson(path.join(pkgDir, 'metrics.json'));
    const painRow = metrics.pipeline.find((p: { metric: string }) => p.metric === 'pain_captured');
    expect(painRow.status).toBe('UNKNOWN');
  });

  itSpawn('rejects an invalid manifest loudly (rc-3)', async () => {
    const ws = seedWorkspace();
    const bad = path.join(root, 'manifest-bad.json');
    writeJson(bad, { experimentId: 'EXP-X' }); // missing scenarioId/host/startedAt/pdCommit
    const r = await runScript('pipeline-evolution/collect-evidence.mjs', ['--workspace', ws, '--experiment', bad, '--json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid experiment manifest/);
    expect(r.stderr).toMatch(/missing required field: scenarioId/);
  });

  itSpawn('declares a missing painId as a binding note instead of guessing', async () => {
    const ws = seedWorkspace();
    const m = path.join(root, 'manifest-ghost.json');
    writeJson(m, manifest({ experimentId: 'EXP-G', sessionIds: [SID_A], painIds: ['painGhost'] }));
    const out = await runCollector(['--workspace', ws, '--experiment', m, '--json']);
    const report = parseCollectorJson(out);
    expect(report.experiment.bindingNotes).toContain('manifest painId painGhost not found in pain_events');
  });
});

describe('truncation marks (截断数据必须标记)', () => {
  itSpawn('marks truncated tool calls and adversarial events with returned/total', async () => {
    const ws = seedWorkspace();
    const m = path.join(root, 'manifest-A2.json');
    writeJson(m, manifest({ experimentId: 'EXP-A', sessionIds: [SID_A] }));
    const out = await runCollector(['--workspace', ws, '--experiment', m, '--json']);
    const report = parseCollectorJson(out);
    expect(report.truncation.toolCalls).toEqual({ returned: 200, total: 250, truncated: true });
    expect(report.trajectory.toolCalls).toHaveLength(200);
    expect(report.truncation.adversarialEvents.truncated).toBe(true);
    expect(report.truncation.pains.truncated).toBe(false);
  });

  itSpawn('marks artifact export capacity truncation (never silently drops)', async () => {
    const ws = seedWorkspace();
    const main = path.join(ws, 'main');
    const m = path.join(root, 'manifest-A3.json');
    writeJson(m, manifest({ experimentId: 'EXP-A', sessionIds: [SID_A] }));
    // 3 more in-scope artifacts (same chain, distinct artificer repair tasks are
    // not needed — three artifacts sourced from existing chain tasks suffice).
    const db = new Database(path.join(main, '.pd', 'state.db'));
    const ins = db.prepare(
      "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, content_json, validation_status, created_at, updated_at) VALUES (?, 'principle', 'dreamer-candA-prompt', ?, 'pending', ?, ?)",
    );
    for (let i = 0; i < 3; i += 1) {
      ins.run(`pi-art-A-extra-${i}`, JSON.stringify({ valid: true, note: 'x'.repeat(64) }), T_CONST, T_CONST);
    }
    db.close();
    const pkgDir = path.join(root, 'pkg-A3');
    await runCollector(['--workspace', ws, '--experiment', m, '--package', pkgDir]);
    const collected = readJson(path.join(pkgDir, 'collected.json'));
    // 1 seeded + 3 extra = 4 in scope, all exported → not truncated.
    expect(collected.truncation.artifacts).toEqual({ returned: 4, total: 4, truncated: false });
    const exported = fs.readdirSync(path.join(pkgDir, 'artifacts'));
    expect(exported).toHaveLength(4);
  });
});

describe('deterministic reports (同一 JSON 生成相同报告)', () => {
  itSpawn('two package builds produce byte-identical derived files', async () => {
    const ws = seedWorkspace();
    const m = path.join(root, 'manifest-D.json');
    writeJson(m, manifest({ experimentId: 'EXP-A', sessionIds: [SID_A], finishedAt: '2026-09-01T12:00:00.000Z' }));
    const p1 = path.join(root, 'pkg-D1');
    const p2 = path.join(root, 'pkg-D2');
    await runCollector(['--workspace', ws, '--experiment', m, '--package', p1]);
    await runCollector(['--workspace', ws, '--experiment', m, '--package', p2]);
    for (const f of ['report.md', 'evidence-index.json', 'metrics.json', 'pipeline-trace.json', 'manifest.json']) {
      expect(fs.readFileSync(path.join(p2, f), 'utf8')).toBe(fs.readFileSync(path.join(p1, f), 'utf8'));
    }
  });

  itSpawn('renderOwnerReview is a pure function of the package data', async () => {
    const libPath = path.join(REPO_ROOT, 'scripts', 'dev', 'pipeline-evolution', 'lib', 'evidence-package.mjs');
    const { renderOwnerReview } = (await import(`file://${libPath.replace(/\\/g, '/')}`)) as {
      renderOwnerReview: (pkg: unknown) => string;
    };
    const ws = seedWorkspace();
    const m = path.join(root, 'manifest-E.json');
    writeJson(m, manifest({ experimentId: 'EXP-A', sessionIds: [SID_A] }));
    const p = path.join(root, 'pkg-E');
    await runCollector(['--workspace', ws, '--experiment', m, '--package', p]);
    const pkgData = {
      manifest: readJson(path.join(p, 'manifest.json')),
      evidenceIndex: readJson(path.join(p, 'evidence-index.json')),
      metrics: readJson(path.join(p, 'metrics.json')),
    };
    const rendered = renderOwnerReview(pkgData);
    expect(rendered).toBe(fs.readFileSync(path.join(p, 'report.md'), 'utf8').replace(/\n$/, ''));
  });
});

describe('manifest initializer', () => {
  itSpawn('creates a valid manifest with the repo commit and refuses overwrite', async () => {
    const out = path.join(root, 'init', 'experiment-manifest.json');
    const args = ['--out', out, '--experiment', 'PRI653-R3-S001', '--scenario', 'S001', '--session', 'sid-1'];
    const r1 = await runScript('pipeline-evolution/init-experiment.mjs', args);
    expect(r1.code).toBe(0);
    const m = readJson(out);
    expect(m.experimentId).toBe('PRI653-R3-S001');
    expect(m.pdCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.sessionIds).toEqual(['sid-1']);
    const r2 = await runScript('pipeline-evolution/init-experiment.mjs', args);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/already exists/);
  });
});

describe('real PRI-653 lab data (AC5 — skips when lab dir is absent)', () => {
  it.skipIf(!fs.existsSync(path.join(REAL_LAB, 'experiment-manifest.json')))(
    'migrates pri653-e1 into a recomputable evidence package',
    async () => {
      const manifestFile = path.join(REAL_LAB, 'experiment-manifest.json');
      const tmpPkg = path.join(root, 'pkg-real');
      await runCollector(['--workspace', path.join(REAL_LAB, 'ws'), '--experiment', manifestFile, '--package', tmpPkg]);
      const idx = readJson(path.join(tmpPkg, 'evidence-index.json'));
      const byClaim = new Map(idx.claims.map((c: { claim: string; status: string }) => [c.claim, c.status]));
      // Ground truth from the first-run report: mechanism reached rollout +
      // adversarial replay; owner decisions happened outside the approvals
      // table (pre-PRI-634 era) → store-derived claim must stay UNKNOWN.
      expect(byClaim.get('replay_executed')).toBe('CONFIRMED');
      expect(byClaim.get('owner_decision')).toBe('UNKNOWN');
      expect(byClaim.get('activation')).toBe('UNKNOWN');
      expect(byClaim.get('behavior_change')).toBe('NOT_REACHED');
      expect(idx.evidenceIntegrity.status).toBe('VALID');
      const collected = readJson(path.join(tmpPkg, 'collected.json'));
      expect(collected.chains.length).toBeGreaterThanOrEqual(5);
      const metrics = readJson(path.join(tmpPkg, 'metrics.json'));
      expect(metrics.governance.needsRevisionTriggered).toBeGreaterThan(0);
    },
  );
});
