// PRI-1150 review fix 1/3: REAL CLI tests for compute-metrics.mjs.
//
// Spawns `node scripts/dev/pain-real-llm-bdd/compute-metrics.mjs` as a child
// process against SELF-CONTAINED temp results roots and asserts, per scenario:
// exit code, stdout JSON verdict, the on-disk metrics-summary.json, and the
// presence/absence of the evidence export. No pure-function-only assertions;
// startup crashes are NOT treated as valid rejections (a ReferenceError exit
// fails these tests).
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'pain-real-llm-bdd', 'compute-metrics.mjs');
const datasetPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'pain-real-llm-bdd', 'golden-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

let repoRoot;
let tempRoot;
let evidenceRoot;

beforeAll(() => {
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-1147-cli-test-'));
  evidenceRoot = path.join(tempRoot, 'evidence');
});

afterAll(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

const FROZEN_SHA = crypto.createHash('sha256').update(fs.readFileSync(datasetPath, 'utf8')).digest('hex');

function frozenSample(sampleId) {
  return dataset.samples.find((s) => s.sample_id === sampleId);
}

/** Build one realistic chain row for a sample (frozen-derived expected). */
function chainRow(sampleId, overrides = {}) {
  const frozen = frozenSample(sampleId);
  const finalOutcome = frozen.expected_final === 'admitted' ? 'admitted' : 'resolved_none';
  return {
    run_id: 'run-cli',
    sample_id: sampleId,
    category: frozen.category ?? 'A',
    expected: {
      label: frozen.expected_label,
      stage: frozen.expected_stage,
      final: frozen.expected_final,
    },
    pending_pre_stage2: frozen.expected_stage === 'stage2_via_pending',
    pain_created: frozen.expected_final === 'admitted',
    final_outcome: finalOutcome,
    final_outcome_reason: null,
    stage1: { marker_decision_pre: 'pending_llm_review', marker_reason_pre: null, observation_persisted: true },
    stage2_result: {
      marker_decision_post: finalOutcome,
      attempts: 1,
      confidence: 0.9,
      verdict: finalOutcome === 'admitted' ? 'correction' : 'none',
    },
    llm_calls: [{ latency_ms: 100, status: 'ok', verdict: { type: frozen.expected_label, confidence: 0.9 } }],
    input_hash: `hash-${sampleId}`,
    provider_status: 'ok',
    latency_ms: 100,
    attempts: 1,
    ...overrides,
  };
}

/** Full 45-row clean chain (all samples, frozen-derived expectations). */
function cleanChainRows() {
  return dataset.samples.map((s) => chainRow(s.sample_id));
}

function writeRunDir(root, runId, files) {
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(runDir, name);
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return runDir;
}

function validDistFingerprint() {
  return {
    'signal-collector-host.js': `sha256:${'a'.repeat(64)}`,
    'trajectory.js': `sha256:${'b'.repeat(64)}`,
    'evolution-reducer.js': `sha256:${'c'.repeat(64)}`,
    'signal-keyword-store.js': `sha256:${'d'.repeat(64)}`,
  };
}

function baseRunFiles(runId, chainRows, { datasetSha = FROZEN_SHA } = {}) {
  // Rows are stamped with THIS run's id (the real chain runner derives it from
  // --run-id); keeps foreign-run scenarios expressible without ambiguity.
  const stamped = chainRows.map((r) => ({ ...r, run_id: runId }));
  return {
    'run-meta.json': {
      run_id: runId,
      dataset_sha256: datasetSha,
      git_commit_sha: '0'.repeat(40),
      provider: 'test',
      model: 'test-model',
      api_key_env: 'TEST_KEY',
      phases: {},
    },
    'codex-chain.summary.json': { ok: true, run_id: runId, provider: 'test', model: 'test-model', partial_run: false },
    'codex-chain.jsonl': stamped.map((r) => JSON.stringify(r)).join('\n'),
    'd6-pending.summary.json': { ok: true, run_id: runId },
    'fault-injection.summary.json': { ok: true, run_id: runId },
    'openclaw-host.summary.json': { ok: true, run_id: runId, dist_fingerprint: validDistFingerprint() },
  };
}

function runCli(resultsRoot, runId) {
  const result = spawnSync(process.execPath, [scriptPath, '--run-id', runId, '--results-root', resultsRoot, '--evidence-root', evidenceRoot], {
    encoding: 'utf8',
    cwd: tempRoot, // never the real repo .tmp
  });
  let stdoutJson = null;
  try { stdoutJson = JSON.parse(result.stdout); } catch { /* startup crash or non-JSON stdout */ }
  return { result, stdoutJson };
}

function readSummary(resultsRoot, runId) {
  const p = path.join(resultsRoot, 'runs', runId, 'metrics-summary.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

describe('compute-metrics REAL CLI (spawns node, temp results roots)', () => {
  it('positive: clean 45-row run → exit 0, ok=true everywhere, evidence published', () => {
    const root = path.join(tempRoot, 'positive');
    const runId = 'run-cli-positive';
    writeRunDir(root, runId, baseRunFiles(runId, cleanChainRows()));
    const { result, stdoutJson } = runCli(root, runId);
    // Not a startup crash: stdout MUST parse as the verdict JSON.
    expect(stdoutJson).not.toBeNull();
    expect(result.status).toBe(0);
    expect(stdoutJson.ok).toBe(true);
    expect(stdoutJson.integrity_ok).toBe(true);
    expect(stdoutJson.gates.overall_ok).toBe(true);
    const summary = readSummary(root, runId);
    expect(summary?.ok).toBe(true);
    expect(summary.integrity.dataset_sha256_matches).toBe(true);
    // Evidence published for the passing run.
    const evidenceDir = path.join(evidenceRoot, `pri-1147-${runId}`);
    expect(fs.existsSync(path.join(evidenceDir, 'per-sample.json'))).toBe(true);
    const perSample = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'per-sample.json'), 'utf8'));
    expect(perSample.run_id).toBe(runId);
    expect(perSample.dataset_sha256_matches).toBe(true);
    expect(summary.integrity.openclaw_dist_fingerprint_ok).toBe(true);
    expect(summary.phase_summaries.openclaw_host.dist_fingerprint).toEqual(validDistFingerprint());
    expect(perSample.openclaw_dist_fingerprint).toEqual(validDistFingerprint());
    const stage2 = perSample.samples.filter((sample) => sample.expected_stage === 'stage2_via_pending');
    expect(stage2).toHaveLength(25);
    expect(stage2.every((sample) => Number.isInteger(sample.observed_stage2?.attempts)
      && sample.observed_stage2.attempts > 0
      && ['correction', 'none'].includes(sample.observed_stage2.verdict)
      && typeof sample.observed_stage2.confidence === 'number')).toBe(true);
    expect(perSample.desensitization_note).toContain('final_outcome_reason');
    expect(perSample.desensitization_note).toContain('一句话判定理由');
  });

  it('missing OpenClaw dist fingerprint → exit 1, ok=false, NO evidence published', () => {
    const root = path.join(tempRoot, 'missing-dist-fingerprint');
    const runId = 'run-cli-dist-fingerprint';
    const files = baseRunFiles(runId, cleanChainRows());
    files['openclaw-host.summary.json'].dist_fingerprint['signal-collector-host.js'] = 'missing';
    writeRunDir(root, runId, files);
    const { result, stdoutJson } = runCli(root, runId);
    expect(stdoutJson).not.toBeNull();
    expect(result.status).toBe(1);
    expect(stdoutJson.ok).toBe(false);
    expect(stdoutJson.integrity.openclaw_dist_fingerprint_ok).toBe(false);
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });

  it('metrics refuses to run while another phase holds the same run_id lock', () => {
    const root = path.join(tempRoot, 'active-run-lock');
    const runId = 'run-cli-active-lock';
    const runDir = writeRunDir(root, runId, baseRunFiles(runId, cleanChainRows()));
    fs.writeFileSync(path.join(runDir, '.active-run.lock'), JSON.stringify({
      schema: 'pri-1147-run-lock/1',
      run_id: runId,
      phase: 'codex_chain',
      pid: 12345,
      started_at: new Date().toISOString(),
      token: 'test-lock-token',
    }));
    const { result } = runCli(root, runId);
    let stderrJson = null;
    try { stderrJson = JSON.parse(result.stderr); } catch { /* malformed failure output is itself a test failure */ }
    expect(result.status).toBe(1);
    expect(stderrJson?.reason).toBe('run_already_active');
    expect(fs.existsSync(path.join(runDir, 'metrics-summary.json'))).toBe(false);
  });

  it('wrong dataset SHA in run-meta → exit 1, ok=false, NO evidence published', () => {
    const root = path.join(tempRoot, 'wrong-sha');
    const runId = 'run-cli-sha';
    writeRunDir(root, runId, baseRunFiles(runId, cleanChainRows(), { datasetSha: 'f'.repeat(64) }));
    const { result, stdoutJson } = runCli(root, runId);
    expect(stdoutJson).not.toBeNull(); // ReferenceError would leave stdout unparseable
    expect(result.status).toBe(1);
    expect(stdoutJson.ok).toBe(false);
    expect(stdoutJson.integrity.dataset_sha256_matches).toBe(false);
    const summary = readSummary(root, runId);
    expect(summary?.ok).toBe(false);
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });

  it('foreign run_id rows → exit 1, foreign ids recorded, NO evidence published', () => {
    const root = path.join(tempRoot, 'foreign-run');
    const runId = 'run-cli-foreign';
    const runDir = writeRunDir(root, runId, baseRunFiles(runId, cleanChainRows()));
    // baseRunFiles stamps rows with the run id; re-write the jsonl so A1
    // carries a FOREIGN id (the scenario under test).
    const rows = cleanChainRows().map((r) => ({ ...r, run_id: runId }));
    rows[0].run_id = 'FOREIGN-RUN';
    fs.writeFileSync(path.join(runDir, 'codex-chain.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
    const { result, stdoutJson } = runCli(root, runId);
    expect(stdoutJson).not.toBeNull();
    expect(result.status).toBe(1);
    expect(stdoutJson.ok).toBe(false);
    expect(stdoutJson.integrity.foreign_run_id_rows).toContain('A1');
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });

  it('missing expected block → exit 1 with expected_block_missing (not a startup crash, not silent)', () => {
    const root = path.join(tempRoot, 'missing-expected');
    const runId = 'run-cli-exp';
    const rows = cleanChainRows();
    delete rows[0].expected;
    writeRunDir(root, runId, baseRunFiles(runId, rows));
    const { result, stdoutJson } = runCli(root, runId);
    expect(stdoutJson).not.toBeNull();
    expect(result.status).toBe(1);
    expect(stdoutJson.ok).toBe(false);
    const kinds = (stdoutJson.dataset_problems ?? []).map((p) => p.kind);
    expect(kinds).toContain('expected_block_missing');
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });

  it('frozen label contradiction (A1 correction → none) → exit 1 and contradiction recorded', () => {
    const root = path.join(tempRoot, 'label-contra');
    const runId = 'run-cli-label';
    const rows = cleanChainRows();
    rows[0].expected.label = 'none';
    writeRunDir(root, runId, baseRunFiles(runId, rows));
    const { result, stdoutJson } = runCli(root, runId);
    expect(stdoutJson).not.toBeNull();
    expect(result.status).toBe(1);
    expect(stdoutJson.ok).toBe(false);
    const kinds = (stdoutJson.dataset_problems ?? []).map((p) => p.kind);
    expect(kinds).toContain('expected_field_rejected');
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });

  it('missing phase summary → exit 1, ok=false, missing phase named', () => {
    const root = path.join(tempRoot, 'missing-phase');
    const runId = 'run-cli-phase';
    const files = baseRunFiles(runId, cleanChainRows());
    delete files['openclaw-host.summary.json'];
    writeRunDir(root, runId, files);
    const { result, stdoutJson } = runCli(root, runId);
    expect(stdoutJson).not.toBeNull();
    expect(result.status).toBe(1);
    expect(stdoutJson.ok).toBe(false);
    expect(stdoutJson.gates.openclaw_ok).toBe(false);
    expect(stdoutJson.missing_phases).toContain('openclaw_host');
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });

  it('failed run keeps marked rejected diagnostics in the run dir (not in evidence root)', () => {
    const root = path.join(tempRoot, 'rejected-diag');
    const runId = 'run-cli-rejected';
    const rows = cleanChainRows();
    rows[0].expected.label = 'none';
    writeRunDir(root, runId, baseRunFiles(runId, rows));
    runCli(root, runId);
    const rejectedPath = path.join(root, 'runs', runId, 'rejected-evidence.json');
    expect(fs.existsSync(rejectedPath)).toBe(true);
    const rejected = JSON.parse(fs.readFileSync(rejectedPath, 'utf8'));
    expect(rejected.rejected).toBe(true);
    expect(rejected.gates).toBeDefined();
    expect(fs.existsSync(path.join(evidenceRoot, `pri-1147-${runId}`))).toBe(false);
  });
});
