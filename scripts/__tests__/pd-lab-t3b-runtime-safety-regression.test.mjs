/**
 * PD-Lab v0.3 T3b r2 (PRI-1254 review round 2) — runtime-safety regression
 * suite for the 7 review findings. Complements (never replaces)
 * pd-lab-t3b-harness-wiring.test.mjs; every group drives REAL entries:
 *
 *   runId fencing      — every read/write consumer refuses '.'/'..'/escape/
 *                        absolute/symlink/junction BEFORE any read (P1-01);
 *   host attribution   — the REAL pd-cli pain-record entry on isolated
 *                        workspaces with REAL schema-bootstrapped trajectory
 *                        databases (no model: async ingress only) (P1-02);
 *   lab:run preflight  — ab-grid runs the FULL preflight before ANY side
 *                        effect (no run dir, no manifest, no shard) (P1-03);
 *   config forwarding  — ab-grid passes the normalized config FILE path to
 *                        shards; children re-load the SAME config (P1-04);
 *   terminal recovery  — the closed completed-terminal set resumes
 *                        idempotently; failed/incomplete re-execute (P1-05);
 *   arm schema         — loadArmRuntime resolves each arm's OWN dist modules
 *                        (real ESM loading boundary) (P2-06);
 *   manifest identity  — downstream consumers refuse runs whose manifests do
 *                        not match the current config (P2-07);
 *   legacy compat      — legacy batches keep reading old-format manifests
 *                        under the legacy rules (NOT_APPLICABLE_LEGACY).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runRepoScript } from './helpers/pd-lab-t3b-run-entry.mjs';
import {
  realPdCliPath, realCliAvailable, runRealPd, bootstrapTrajectoryWorkspaceAsync, queryPainEvents,
} from './helpers/pd-lab-t3b-real-cli.mjs';
import {
  useExperimentConfig, loadExperimentConfig, validateRunId, buildIngressArgs,
  decideHostArg, armWorktree,
} from '../../experiment/prompt-v2/scripts/ab/ab-lib.mjs';
import { loadArmRuntime, clearArmRuntimeCache } from '../../experiment/prompt-v2/scripts/ab/arm-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const AB = path.join(repoRoot, 'experiment', 'prompt-v2', 'scripts', 'ab');
const ANALYSIS = path.join(repoRoot, 'experiment', 'prompt-v2', 'scripts', 'analysis');
const HISTORICAL_CONFIGS = path.join(repoRoot, 'experiment', 'prompt-v2', 'configs');

const ENTRY_AB_RUN = path.join(AB, 'ab-run.mjs');
const ENTRY_AB_GRID = path.join(AB, 'ab-grid.mjs');
const ENTRY_AB_STAGE = path.join(AB, 'ab-stage.mjs');
const ENTRY_AB_PREFLIGHT = path.join(AB, 'ab-preflight.mjs');
const ENTRY_AB_METRICS = path.join(AB, 'ab-metrics.mjs');
const ENTRY_AB_BLINDPACK = path.join(AB, 'ab-blindpack.mjs');
const ENTRY_AB_BLINDPACK_PAIRED = path.join(AB, 'ab-blindpack-paired.mjs');
const ENTRY_AB_DREAMER_PAIRED = path.join(AB, 'ab-dreamer-paired.mjs');
const ENTRY_AB_EVAL = path.join(AB, 'ab-eval.mjs');
const ENTRY_AB_BLIND_SUMMARY = path.join(AB, 'ab-blind-summary.mjs');
const ENTRY_AB_DIVERSITY_EVAL = path.join(AB, 'ab-diversity-eval.mjs');
const ENTRY_PAIRED_ANALYSIS = path.join(ANALYSIS, 'paired-analysis.mjs');
const ENTRY_OWNER_SPOTCHECK = path.join(ANALYSIS, 'owner-spotcheck-list.mjs');

const sha256Text = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const MODEL_ENV_SENTINEL = 'PD_LAB_T3B_KEY';
if (process.env[MODEL_ENV_SENTINEL] === undefined) process.env[MODEL_ENV_SENTINEL] = 'synthetic-present';

// ---------------------------------------------------------------------------
// Shared fixture: arms carry BOTH a stub pd-cli dist (harness runs) AND stub
// principles-core dist modules with PER-ARM markers (arm-runtime group).
// ---------------------------------------------------------------------------

const BASE_CONFIG_YAML = `version: 1
workspace:
  default: D:/production/workspace
features:
  prompt:
    category: core
    enabled: true
  diagnostician_async_cli:
    category: quiet
    enabled: false
  intent_engineering:
    category: quiet
    enabled: false
internalAgents:
  defaultRuntime: pi-ai.amd-ds-vision
  agents:
    diagnostician:
      enabled: true
      runtimeProfile: pi-ai.amd-ds-vision
ui:
  diagnostics: true
feedback:
  maintainer_email: owner@example.invalid
  ingest_token: SECRET-MUST-BE-DROPPED
runtimeProfiles:
  pi-ai.amd-ds-vision:
    model: amd
  pi-ai.glm:
    model: glm
`;

const STUB_CLI = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  'const path = require(\'node:path\');',
  'const args = process.argv.slice(2);',
  'const wsIndex = args.indexOf(\'--workspace\');',
  'if (wsIndex >= 0 && wsIndex + 1 < args.length) {',
  "  const log = path.join(path.dirname(String(args[wsIndex + 1])), 'stub-cli.log');",
  "  fs.appendFileSync(log, JSON.stringify({ cmd: args.slice(0, 2).join(' '), args, at: new Date().toISOString() }) + '\\n');",
  '}',
  "if (args[0] === 'pain' && args[1] === 'record') {",
  "  const i = args.indexOf('--reason');",
  "  const reason = i >= 0 ? String(args[i + 1]) : '';",
  "  if (reason.includes('T3B_BINDING_FAIL_SENTINEL')) { process.stdout.write('{\"error\":\"session_not_found\"}'); process.exit(1); }",
  "  if (reason.length > 500) { process.stderr.write('--reason exceeds MAX_REASON_LENGTH=500'); process.exit(1); }",
  "  const s = args.indexOf('--session');",
  '  const sid = s >= 0 ? args[s + 1] : null;',
  "  process.stdout.write(JSON.stringify({ ok: true, taskId: 'diagnosis_' + (sid ?? 'unbound'), sessionId: sid }));",
  '  process.exit(0);',
  '}',
  "process.stdout.write('{}');",
  'process.exit(0);',
].join('\n');

/**
 * ESM stub core-dist modules for P2-06 — CONSTANT source text (CodeQL
 * js/bad-code-sanitization alert 1039): the per-arm marker is DATA, not
 * code, so it lives in `arm-marker.json` beside the dist tree and every
 * stub module reads it at import time. No value is ever interpolated into
 * generated code; the module sources below are fixed literals and the
 * per-arm variation flows entirely through the data file.
 */
const MARKER_JSON_NAME = 'arm-marker.json';
const ARM_CORE_DIST_SOURCES = {
  'runtime/store/sqlite-connection.js': [
    "import { readFileSync } from 'node:fs';",
    "const marker = JSON.parse(readFileSync(new URL('../../" + MARKER_JSON_NAME + "', import.meta.url), 'utf8')).marker;",
    "export class SqliteConnection { static ARM_MARKER = marker; constructor(opts) { this.opts = opts; } getDb() { throw new Error('stub'); } }",
    'export default SqliteConnection;',
  ].join('\n') + '\n',
  'runtime/diagnostician-output.js': [
    "import { readFileSync } from 'node:fs';",
    "const marker = JSON.parse(readFileSync(new URL('../" + MARKER_JSON_NAME + "', import.meta.url), 'utf8')).marker;",
    "export function readDiagnosticianOutputFromEnvelope(parsed) { return { __marker: marker, parsed }; }",
  ].join('\n') + '\n',
  'runtime/diagnostician/diag-distiller-output.js': [
    "import { readFileSync } from 'node:fs';",
    "const marker = JSON.parse(readFileSync(new URL('../../" + MARKER_JSON_NAME + "', import.meta.url), 'utf8')).marker;",
    "export const DiagDistillerOutputV1Schema = { __marker: marker };",
  ].join('\n') + '\n',
  'runtime/internalization/dreamer-output.js': [
    "import { readFileSync } from 'node:fs';",
    "const marker = JSON.parse(readFileSync(new URL('../../" + MARKER_JSON_NAME + "', import.meta.url), 'utf8')).marker;",
    "export const DreamerOutputV1Schema = { __marker: marker };",
  ].join('\n') + '\n',
  'runtime/internalization/philosopher-output.js': [
    "import { readFileSync } from 'node:fs';",
    "const marker = JSON.parse(readFileSync(new URL('../../" + MARKER_JSON_NAME + "', import.meta.url), 'utf8')).marker;",
    "export const PhilosopherOutputV1Schema = { __marker: marker };",
  ].join('\n') + '\n',
  'runtime/internalization/scribe-output.js': [
    "import { readFileSync } from 'node:fs';",
    "const marker = JSON.parse(readFileSync(new URL('../../" + MARKER_JSON_NAME + "', import.meta.url), 'utf8')).marker;",
    "export const ScribeOutputV1Schema = { __marker: marker };",
  ].join('\n') + '\n',
};

function sample(sid, over) {
  return {
    experimentPainId: sid,
    originalPainId: `orig-${sid}`,
    inputDigest: sha256Text(`digest-${sid}`),
    painEvent: {
      id: `pe-${sid}`,
      session_id: null,
      source: 'agent_report',
      score: 80,
      reason: `pain reason for ${sid}`,
      severity: 'medium',
      origin: 'agent',
      confidence: 41,
      text: `pain text for ${sid}`,
      host_kind: 'openclaw',
      ...over,
    },
  };
}

const DATASET = {
  spec: 'pd-lab-t3b-r2-synthetic',
  frozenAt: '2026-11-19T00:00:00.000Z',
  samples: [
    sample('S01', { session_id: 'sess-01', score: 73, host_kind: 'openclaw' }),
    sample('S02', { session_id: null, host_kind: '', reason: 'T3B-long-reason-' + 'x'.repeat(600) }),
    sample('S03', { session_id: 'sess-03', host_kind: 'openclaw', reason: 'T3B_BINDING_FAIL_SENTINEL pain reason for S03' }),
    sample('S04', { session_id: null, host_kind: 'codex', score: null, confidence: 9 }),
    sample('S05', { session_id: 'sess-05', host_kind: '' }),
    sample('S06', { session_id: 'sess-06', host_kind: 'codex' }),
  ],
  repeatRunPicks: [],
};

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lab-t3b-r2-'));
const experimentRoot = path.join(fixtureRoot, 'exp');
const PREREG_FILE = path.join(fixtureRoot, 'PREREG.md');
const BASE_CONFIG_FILE = path.join(fixtureRoot, 'base-config.yaml');
const WT_BASE = path.join(fixtureRoot, 'arms', 'wtbase');
const WT_CAND = path.join(fixtureRoot, 'arms', 'wtcand');
const CONFIG_FILE = path.join(fixtureRoot, 'experiment-config.json');

function initArmWorktree(dir, marker) {
  fs.mkdirSync(path.join(dir, 'packages', 'pd-cli', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'pd-cli', 'dist', 'index.js'), STUB_CLI, 'utf8');
  // The per-arm marker is DATA: written as JSON beside the dist tree and read
  // by the CONSTANT stub modules at import time (never interpolated into code).
  const distRoot = path.join(dir, 'packages', 'principles-core', 'dist');
  fs.mkdirSync(distRoot, { recursive: true });
  fs.writeFileSync(path.join(distRoot, MARKER_JSON_NAME), `${JSON.stringify({ marker })}\n`, 'utf8');
  for (const [rel, src] of Object.entries(ARM_CORE_DIST_SOURCES)) {
    const full = path.join(dir, 'packages', 'principles-core', 'dist', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, src, 'utf8');
  }
  // The stub dist modules are ESM — mark the dist tree exactly like the real
  // core dist tree is marked, so loadArmRuntime's file:// imports resolve.
  fs.writeFileSync(path.join(dir, 'packages', 'principles-core', 'dist', 'package.json'), '{"type":"module"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), `arm ${marker}\n`, 'utf8');
  const res = runRepoScript(path.join(here, 'fixtures', 'pd-lab-t3b-init-arm.mjs'), [], { input: JSON.stringify({ armDir: dir, stubCliSource: path.join(here, 'fixtures', 'pd-lab-t3b-stub-cli.mjs') }) });
  if (res.status !== 0) {
    // Fall back to a plain stub dist copy when git is unavailable in the env.
    fs.writeFileSync(path.join(dir, 'packages', 'pd-cli', 'dist', 'index.js'), STUB_CLI, 'utf8');
    return 'f'.repeat(40);
  }
  return res.stdout.trim();
}

beforeAll(() => {
  fs.mkdirSync(experimentRoot, { recursive: true });
  fs.writeFileSync(path.join(experimentRoot, 'dataset.json'), JSON.stringify(DATASET, null, 2), 'utf8');
  const snap = path.join(experimentRoot, 'snap');
  fs.mkdirSync(path.join(snap, 'blobs'), { recursive: true });
  const blobBody = 'r2 blob body';
  fs.writeFileSync(path.join(snap, 'blobs', 'b1.txt'), blobBody, 'utf8');
  fs.writeFileSync(path.join(snap, 'state.db'), 'synthetic state db bytes', 'utf8');
  fs.writeFileSync(path.join(snap, 'trajectory.db'), 'synthetic trajectory db bytes', 'utf8');
  fs.writeFileSync(path.join(snap, 'blob-manifest.json'), `${JSON.stringify({
    schema: 'pd-lab-blob-manifest.v1', generatedAt: '2026-11-19T00:00:00.000Z', sourceWorkspace: 'synthetic',
    blobDir: 'blobs', ok: true, consistencyStatus: 'CONSISTENT_WITHIN_WINDOW', consistencyReasons: [],
    files: [{ path: 'blobs/b1.txt', ref: 'b1.txt', bytes: Buffer.byteLength(blobBody, 'utf8'), sha256: sha256Text(blobBody), referenceCount: 1, referencedBy: ['assistant_turns'] }],
    counts: { referencedDistinct: 1, referencedRows: 1, copied: 1, orphansNotCopied: 0 },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(PREREG_FILE, '---\nexperimentId: t3b-r2-synth\nplan: synthetic fixture\n---\n\n# Preregistration (synthetic)\n', 'utf8');
  fs.writeFileSync(BASE_CONFIG_FILE, BASE_CONFIG_YAML, 'utf8');
  initArmWorktree(WT_BASE, 'BASELINE-A');
  initArmWorktree(WT_CAND, 'CANDIDATE-B');
});

const datasetFile = path.join(experimentRoot, 'dataset.json');
const snapDir = path.join(experimentRoot, 'snap');

const rawConfig = () => ({
  schema: 'pd-lab-experiment-config.v1',
  experimentId: 't3b-r2-synth',
  preregistration: { file: PREREG_FILE, sha256: sha256File(PREREG_FILE) },
  baselineArm: 'wtbase',
  candidateArm: 'wtcand',
  experimentRoot,
  additionalForbiddenRoots: [],
  dataset: { file: datasetFile, sha256: sha256File(datasetFile) },
  snapshot: {
    dir: snapDir,
    sha256: {
      state: sha256File(path.join(snapDir, 'state.db')),
      trajectory: sha256File(path.join(snapDir, 'trajectory.db')),
      blobManifest: sha256File(path.join(snapDir, 'blob-manifest.json')),
    },
  },
  baseConfigFile: BASE_CONFIG_FILE,
  profileRebind: { from: 'pi-ai.amd-ds-vision', to: 'pi-ai.glm' },
  arms: {
    wtbase: { worktree: WT_BASE, expectedHead: headOf(WT_BASE), featureOverrides: { diagnostician_async_cli: true } },
    wtcand: { worktree: WT_CAND, expectedHead: headOf(WT_CAND), featureOverrides: { diagnostician_async_cli: true, intent_engineering: true } },
  },
  modelEnv: [MODEL_ENV_SENTINEL],
});

function headOf(wt) {
  // The init fixture committed via git when available; the head is stored in
  // .git HEAD resolution — but tests only need a STABLE value that matches
  // what ab-run's manifest will record via gitHead(). Use git when present.
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'f'.repeat(40);
  }
}

function writeConfig(mutate) {
  const raw = rawConfig();
  if (mutate) mutate(raw);
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return CONFIG_FILE;
}

function stubLogPath() {
  return path.join(experimentRoot, 'workspaces', 'stub-cli.log');
}
function readStubLog() {
  const p = stubLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}
function resetStubLog() {
  try { fs.rmSync(stubLogPath(), { force: true }); } catch { /* absent */ }
}

// ---------------------------------------------------------------------------
// Group 1 — runId path fencing (P1-01)
// ---------------------------------------------------------------------------

describe('P1-01 runId path fencing — every consumer refuses before any read', () => {
  // A manifest-verified legal run the multi-input tests can point --run-id
  // at while the SECOND run id carries the malicious value.
  const LEGAL_RUN = 'r2-pa-base';
  beforeAll(() => {
    const cfg = writeConfig();
    const configSha = sha256File(cfg);
    const runDir = path.join(experimentRoot, 'runs', LEGAL_RUN);
    fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'records', 'S01.wtbase.json'), `${JSON.stringify({ experimentPainId: 'S01', arm: 'wtbase', rep: 0, status: 'failed', newTaskId: 'x' })}
`, 'utf8');
    fs.writeFileSync(path.join(runDir, 'run-manifest.pabase.json'), `${JSON.stringify({
      runId: LEGAL_RUN,
      experimentId: 't3b-r2-synth',
      configSha256: configSha,
      preregistrationStatus: 'VERIFIED',
      preregistrationSha256: sha256File(PREREG_FILE),
      roles: { baseline: 'wtbase', candidate: 'wtcand' },
      datasetSha256: sha256File(datasetFile),
      snapshot: { dir: snapDir, sha256: rawConfig().snapshot.sha256 },
      arms: {
        wtbase: { head: headOf(WT_BASE), expectedHead: headOf(WT_BASE) },
        wtcand: { head: headOf(WT_CAND), expectedHead: headOf(WT_CAND) },
      },
    }, null, 2)}
`, 'utf8');
  });

  const MALICIOUS = [
    ['dot', '.', /dot_only/],
    ['dotdot', '..', /dot_only/],
    ['escape', '../escape', /pattern|strictly under/],
    ['slash', 'a/b', /pattern/],
    ['absolute', 'D:/abs-run', /pattern/],
    ['drive', 'C:\\abs-run', /pattern/],
  ];

  // Full matrix on the canonical read consumer (ab-metrics).
  it.each(MALICIOUS)('ab-metrics refuses %s runId', (_name, bad, re) => {
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', bad]);
    expect(res.status, `metrics must reject ${JSON.stringify(bad)}`).toBe(1);
    expect(res.stderr).toMatch(/runId rejected/);
    expect(res.stderr).toMatch(re);
  });

  // Representative malicious values on EVERY other runId consumer.
  const OTHER_READERS = [
    ['ab-blindpack.mjs', (cfg, rid) => [ENTRY_AB_BLINDPACK, ['--config', cfg, '--run-id', rid]]],
    ['ab-blindpack-paired.mjs', (cfg, rid) => [ENTRY_AB_BLINDPACK_PAIRED, ['--config', cfg, '--run-id', rid]]],
    ['ab-eval.mjs', (cfg, rid) => [ENTRY_AB_EVAL, ['--config', cfg, '--run-id', rid]]],
    ['ab-blind-summary.mjs', (cfg, rid) => [ENTRY_AB_BLIND_SUMMARY, ['--config', cfg, '--run-id', rid]]],
    ['analysis/paired-analysis.mjs', (cfg, rid) => [ENTRY_PAIRED_ANALYSIS, ['--config', cfg, '--run-id', rid]]],
    ['ab-stage.mjs', (cfg, rid) => [ENTRY_AB_STAGE, ['--config', cfg, '--run-id', rid, '--stage', 'distiller']]],
    ['ab-dreamer-paired.mjs', (cfg, rid) => [ENTRY_AB_DREAMER_PAIRED, ['--config', cfg, '--run-id', rid]]],
  ];
  for (const [name, mk] of OTHER_READERS) {
    it(`${name} refuses '.'`, () => {
      const [entry, args] = mk(writeConfig(), '.');
      const res = runRepoScript(entry, args);
      expect(res.status, `${name} must reject '.'`).toBe(1);
      expect(res.stderr).toMatch(/runId rejected|dot_only/);
    });
    it(`${name} refuses '..'`, () => {
      const [entry, args] = mk(writeConfig(), '..');
      const res = runRepoScript(entry, args);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/runId rejected|dot_only/);
    });
    it(`${name} refuses '../escape'`, () => {
      const [entry, args] = mk(writeConfig(), '../escape');
      const res = runRepoScript(entry, args);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/runId rejected/);
    });
    it(`${name} refuses an absolute path`, () => {
      const [entry, args] = mk(writeConfig(), 'D:/abs-run');
      const res = runRepoScript(entry, args);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/runId rejected/);
    });
  }

  it('ab-blindpack refuses a malicious --pa-run-id (multi-run inputs validated per run)', () => {
    const res = runRepoScript(ENTRY_AB_BLINDPACK, ['--config', writeConfig(), '--run-id', LEGAL_RUN, '--pa-run-id', '../escape']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/runId rejected/);
  });

  it('owner-spotcheck-list refuses a malicious entry in its multi-run list', () => {
    const res = runRepoScript(ENTRY_OWNER_SPOTCHECK, ['--config', writeConfig(), '--runs', `${LEGAL_RUN},..`]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/runId rejected|dot_only/);
  });

  it('a junction planted AT the run directory is refused (reparse fence, before any read)', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-t3b-r2-runlink-'));
    const runDir = path.join(experimentRoot, 'runs', 'r2-junctioned');
    fs.mkdirSync(path.join(experimentRoot, 'runs'), { recursive: true });
    try {
      fs.symlinkSync(target, runDir, process.platform === 'win32' ? 'junction' : 'dir');
      const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', 'r2-junctioned']);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/reparse_point/);
    } finally {
      fs.rmSync(runDir, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('validation never CREATES the run directory for a read-only consumer', () => {
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', 'r2-never-created']);
    expect(res.status).toBe(1); // rejected: no manifest for a nonexistent run
    expect(fs.existsSync(path.join(experimentRoot, 'runs', 'r2-never-created'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — host attribution against the REAL pd-cli (P1-02)
// ---------------------------------------------------------------------------

describe('P1-02 host attribution — REAL pd-cli on isolated workspaces', () => {
  function makeWs(name) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), `pd-t3b-r2-host-${name}-`));
    const cfg = `version: 1
features:
  prompt: { category: core, enabled: true }
  diagnostician_async_cli: { category: quiet, enabled: true }
workspace:
  default: ${ws.split(path.sep).join('/')}
internalAgents:
  defaultRuntime: pi-ai.probe
  agents:
    diagnostician: { enabled: true, runtimeProfile: pi-ai.probe }
runtimeProfiles:
  pi-ai.probe:
    type: pi-ai
    provider: lmstudio
    model: qwen3.6-27b-mtp
    apiKeyEnv: LMSTUDIO_API_KEY
    baseUrl: http://localhost:1234/v1
`;
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), cfg, 'utf8');
    return ws;
  }

  it('openclaw + session → the harness argv records host_kind=openclaw with the session (REAL CLI, REAL DB)', async () => {
    const ws = makeWs('oc');
    try {
      await bootstrapTrajectoryWorkspaceAsync(ws, 'oc-sess-1');
      const { argv } = buildIngressArgs({ source: 'manual', score: 70, reason: 'oc probe', session_id: 'oc-sess-1', host_kind: 'openclaw' });
      expect(argv).toContain('--host');
      expect(argv[argv.indexOf('--host') + 1]).toBe('openclaw');
      const res = runRealPd([...argv, '--workspace', ws, '--json']);
      expect(res.status, `real CLI failed: ${res.stderr.slice(0, 300)}`).toBe(0);
      const rows = queryPainEvents(ws);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe('oc-sess-1');
      expect(rows[0].host_kind).toBe('openclaw');
      expect(rows[0].canonical_pain_id).toBeTruthy();
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('PRE-FIX DANGER CONTROL: raw CLI session + NO --host writes host_kind=openclaw (why fail-closed exists)', async () => {
    const ws = makeWs('danger');
    try {
      await bootstrapTrajectoryWorkspaceAsync(ws, 'danger-sess');
      const res = runRealPd(['pain', 'record', '--reason', 'danger probe', '--source', 'manual', '--session', 'danger-sess', '--workspace', ws, '--json']);
      expect(res.status).toBe(0);
      const rows = queryPainEvents(ws);
      expect(rows).toHaveLength(1);
      // The REAL CLI silently attributes openclaw when --host is omitted —
      // this is the exact hazard the harness now refuses to trigger.
      expect(rows[0].host_kind).toBe('openclaw');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('codex + session → the harness FAILS CLOSED (no --host, no CLI invocation, no openclaw attribution)', () => {
    const { hostArg, decision } = decideHostArg({ session_id: 'cx-sess', host_kind: 'codex' });
    expect(hostArg).toEqual([]);
    expect(decision.failClosed).toBe(true);
    expect(decision.basis).toMatch(/codex/);
  });

  it('unknown host + session → the harness FAILS CLOSED (basis names the openclaw default hazard)', () => {
    const { hostArg, decision } = decideHostArg({ session_id: 'unk-sess', host_kind: '' });
    expect(hostArg).toEqual([]);
    expect(decision.failClosed).toBe(true);
    expect(decision.basis).toMatch(/would default to openclaw/);
  });

  it('unbound (no session) → real CLI accepts with NO host attribution in the trajectory DB', async () => {
    const ws = makeWs('unbound');
    try {
      await bootstrapTrajectoryWorkspaceAsync(ws, 'unused-sess');
      const { argv, evidence } = buildIngressArgs({ source: 'manual', reason: 'unbound probe', host_kind: '' });
      expect(evidence.hostDecision.failClosed).toBe(false);
      expect(argv).not.toContain('--host');
      expect(argv).not.toContain('--session');
      const res = runRealPd([...argv, '--workspace', ws, '--json']);
      expect(res.status).toBe(0);
      // No session-bound pain row ⇒ no host attribution anywhere.
      expect(queryPainEvents(ws)).toHaveLength(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('session does not exist → REAL CLI refuses (session_not_found), no row — the ingress_binding_failed precondition', async () => {
    const ws = makeWs('ghost');
    try {
      await bootstrapTrajectoryWorkspaceAsync(ws, 'other-sess');
      const res = runRealPd(['pain', 'record', '--reason', 'ghost probe', '--source', 'manual', '--session', 'ghost-sess', '--workspace', ws, '--json']);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/session_not_found/);
      expect(queryPainEvents(ws)).toHaveLength(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Group 3 — lab:run (ab-grid) preflight BEFORE any side effect (P1-03)
// ---------------------------------------------------------------------------

describe('P1-03 lab:run preflight — ab-grid refuses before ANY side effect', () => {
  // Each case mutates the config/preregistration to trip ONE preflight check.
  const CASES = [
    ['expectedHead mismatch', (raw) => { raw.arms.wtbase.expectedHead = 'f'.repeat(40); }, /arm-head-matches-expected/],
    ['experimentId mismatch (front matter)', (raw) => {
      fs.writeFileSync(PREREG_FILE, '---\nexperimentId: some-other-experiment\nplan: x\n---\nbody\n', 'utf8');
      (raw.preregistration).sha256 = sha256File(PREREG_FILE);
    }, /experiment_id_mismatch/],
    ['modelEnv missing', (raw) => { raw.modelEnv = ['PD_LAB_T3B_MISSING_XYZ']; }, /model-env-present/],
    ['blob manifest digest wrong', (raw) => { raw.snapshot.sha256.blobManifest = 'a'.repeat(64); }, /digest_mismatch|blobManifest/],
    ['derived preflight: dataset digest wrong', (raw) => { raw.dataset.sha256 = 'b'.repeat(64); }, /digest_mismatch|dataset/],
  ];

  it.each(CASES)('%s → grid exits non-zero with NO run dir, NO manifest, NO shard', (_name, mutate, re) => {
    // Restore the preregistration between cases (the experimentId case rewrites it).
    fs.writeFileSync(PREREG_FILE, '---\nexperimentId: t3b-r2-synth\nplan: synthetic fixture\n---\n\n# Preregistration (synthetic)\n', 'utf8');
    const cfg = writeConfig(mutate);
    const runId = `r2-grid-reject-${_name.replace(/\W+/g, '-').toLowerCase()}`;
    resetStubLog();
    const res = runRepoScript(ENTRY_AB_GRID, ['--config', cfg, '--run-id', runId, '--parallel', '1']);
    expect(res.status, `${_name}: grid must fail (stderr=${res.stderr.slice(0, 300)})`).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(re);
    expect(fs.existsSync(path.join(experimentRoot, 'runs', runId)), 'no run directory may be created').toBe(false);
    expect(readStubLog(), 'no shard child may start').toEqual([]);
  });

  it('preregistration tampered AFTER config write → grid refuses before any side effect (CF-16 at grid level)', () => {
    const cfg = writeConfig();
    fs.appendFileSync(PREREG_FILE, '\n<!-- r2 grid tamper -->\n', 'utf8');
    const runId = 'r2-grid-prereg-tamper';
    resetStubLog();
    const res = runRepoScript(ENTRY_AB_GRID, ['--config', cfg, '--run-id', runId, '--parallel', '1']);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/preregistration/);
    expect(fs.existsSync(path.join(experimentRoot, 'runs', runId))).toBe(false);
    expect(readStubLog()).toEqual([]);
    fs.writeFileSync(PREREG_FILE, '---\nexperimentId: t3b-r2-synth\nplan: synthetic fixture\n---\n\n# Preregistration (synthetic)\n', 'utf8');
  });
});

// ---------------------------------------------------------------------------
// Group 4 — config forwarding (P1-04): real grid success run
// ---------------------------------------------------------------------------

describe('P1-04 config forwarding — ab-grid passes the config FILE path; children re-load the SAME config', () => {
  let gridRunId = null;
  let gridConfigSha = null;

  it('real ab-grid run succeeds: shard starts, records produced, manifests written', () => {
    const cfg = writeConfig();
    gridConfigSha = sha256File(cfg);
    gridRunId = 'r2-grid-ok';
    resetStubLog();
    const res = runRepoScript(ENTRY_AB_GRID, ['--config', cfg, '--run-id', gridRunId, '--parallel', '1']);
    expect(res.status, `grid must succeed (stderr=${res.stderr.slice(0, 400)}; stdout tail=${res.stdout.slice(-400)})`).toBe(0);
    const runDir = path.join(experimentRoot, 'runs', gridRunId);
    expect(fs.existsSync(path.join(runDir, 'grid-manifest.json'))).toBe(true);
    const shardManifests = fs.readdirSync(runDir).filter((f) => f.startsWith('run-manifest.'));
    expect(shardManifests.length).toBeGreaterThanOrEqual(1);
    // The shard child RE-LOADED the same config file: its manifest carries
    // the same config digest the parent computed.
    const shard = JSON.parse(fs.readFileSync(path.join(runDir, shardManifests[0]), 'utf8'));
    expect(shard.configSha256).toBe(gridConfigSha);
    expect(shard.experimentId).toBe('t3b-r2-synth');
    expect(shard.roles).toEqual({ baseline: 'wtbase', candidate: 'wtcand' });
    // Children executed: the stub CLI logged pain-record invocations
    // (S05/S06 never reach the CLI — host fail-closed).
    const painCalls = readStubLog().filter((l) => l.cmd === 'pain record');
    expect(painCalls.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(runDir, 'records'))).toBe(true);
  });

  it('the forwarded --config value is a STRING file path (the object was the pre-fix defect)', () => {
    // Behavioral proof: the shard child successfully loaded its config —
    // pre-fix it received `[object Object]` and every shard failed config
    // loading with no manifests. The manifest equality above is the
    // observable contract; this test pins it explicitly.
    const runDir = path.join(experimentRoot, 'runs', gridRunId);
    const shardManifests = fs.readdirSync(runDir).filter((f) => f.startsWith('run-manifest.'));
    for (const f of shardManifests) {
      const shard = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
      expect(typeof shard.configSha256).toBe('string');
      expect(shard.configSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('ab-metrics reads the grid-produced run (legal runId + manifest identity still pass)', () => {
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', gridRunId]);
    expect(res.status, `metrics on a legal run must pass (stderr=${res.stderr.slice(0, 300)})`).toBe(0);
    expect(fs.existsSync(path.join(experimentRoot, 'runs', gridRunId, 'layer1-metrics.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — terminal recovery closed set (P1-05)
// ---------------------------------------------------------------------------

describe('P1-05 terminal recovery — the closed completed set resumes; failures re-execute', () => {
  function plantRecord(runId, sid, arm, status) {
    const recordsDir = path.join(experimentRoot, 'runs', runId, 'records');
    fs.mkdirSync(recordsDir, { recursive: true });
    const rec = {
      experimentPainId: sid, arm, armRole: arm === 'wtbase' ? 'baseline' : 'candidate', rep: 0, shardId: '0',
      status,
      newTaskId: `diagnosis_planted_${sid}_${arm}`,
      verification: { ok: status === 'failed' ? false : true, checks: {}, errors: [] },
      plantedMarker: `${sid}.${arm}.${status}`,
    };
    const p = path.join(recordsDir, `${sid}.${arm}.json`);
    fs.writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
    return { path: p, sha: sha256File(p) };
  }

  // PRI-1256 r4-A3: the 'done-no-candidate' row below is a SYNTHETIC
  // legacy-shaped compatibility fixture, not a real historical record —
  // git history shows the status was introduced by this PR and the
  // classifier no longer produces it. It exercises ONLY the resume path:
  // a persisted record in the completed set must be honored without
  // re-execution. New executions can never emit this status.
  it.each([
    ['done', 'R2D1'],
    ['done-admission-refused', 'R2D2'],
    ['done-no-candidate', 'R2D3'], // synthetic legacy-shaped compat fixture
    ['done-deferred', 'R2D4'],
  ])('%s + verification.ok=true resumes WITHOUT any CLI invocation (record untouched)', (status, sid) => {
    const planted = plantRecord(`r2-resume-${sid}`, sid, 'wtbase', status);
    resetStubLog();
    const res = runRepoScript(ENTRY_AB_RUN, ['--config', writeConfig(), '--run-id', `r2-resume-${sid}`, '--shard-id', '0', '--samples', sid]);
    expect(res.status, `resume run must succeed (stderr=${res.stderr.slice(0, 300)})`).toBe(0);
    expect(readStubLog(), `${status} record must resume without any child invocation`).toEqual([]);
    expect(sha256File(planted.path)).toBe(planted.sha); // record content unchanged
  });

  it.each([
    ['failed', 'S01'],
    ['incomplete', 'S02'],
  ])('%s record re-executes (ingress re-attempted through the stub CLI)', (status, sid) => {
    plantRecord(`r2-rerun-${status}`, sid, 'wtbase', status);
    resetStubLog();
    const res = runRepoScript(ENTRY_AB_RUN, ['--config', writeConfig(), '--run-id', `r2-rerun-${status}`, '--shard-id', '0', '--samples', sid]);
    expect(res.status).toBe(0);
    const painCalls = readStubLog().filter((l) => l.cmd === 'pain record');
    expect(painCalls.length, `${status} record must be re-executed`).toBeGreaterThanOrEqual(1);
  });

  it('a done record with verification.ok=false is NOT resumed (re-executes)', () => {
    const sid = 'S04';
    const recordsDir = path.join(experimentRoot, 'runs', 'r2-okfalse', 'records');
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.writeFileSync(path.join(recordsDir, `${sid}.wtbase.json`), `${JSON.stringify({
      experimentPainId: sid, arm: 'wtbase', rep: 0, status: 'done', newTaskId: 'diagnosis_planted_r2f3',
      verification: { ok: false, checks: {}, errors: ['stale'] },
    }, null, 2)}\n`, 'utf8');
    resetStubLog();
    const res = runRepoScript(ENTRY_AB_RUN, ['--config', writeConfig(), '--run-id', 'r2-okfalse', '--shard-id', '0', '--samples', sid]);
    expect(res.status).toBe(0);
    expect(readStubLog().some((l) => l.cmd === 'pain record'), 'ok=false done must re-execute').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 6 — per-arm runtime (P2-06): the REAL loading boundary
// ---------------------------------------------------------------------------

describe('P2-06 arm runtime — each arm loads its OWN dist modules (real ESM boundary)', () => {
  beforeAll(() => {
    const configFile = writeConfig();
    useExperimentConfig(loadExperimentConfig(configFile));
  });

  it('baseline resolves BASELINE-A modules; candidate resolves CANDIDATE-B modules', async () => {
    clearArmRuntimeCache();
    const base = await loadArmRuntime('wtbase');
    const cand = await loadArmRuntime('wtcand');
    expect(base.SqliteConnection.ARM_MARKER).toBe('BASELINE-A');
    expect(cand.SqliteConnection.ARM_MARKER).toBe('CANDIDATE-B');
    expect(base.worktree).toBe(armWorktree('wtbase'));
    expect(cand.worktree).toBe(armWorktree('wtcand'));
    expect(base.schemas.distiller.__marker).toBe('BASELINE-A');
    expect(cand.schemas.dreamer.__marker).toBe('CANDIDATE-B');
    // No cross-validation: the envelope reader is also arm-scoped.
    expect(base.schemas.routerEnvelope({}).__marker).toBe('BASELINE-A');
    expect(cand.schemas.routerEnvelope({}).__marker).toBe('CANDIDATE-B');
  });

  it('per-arm cache returns the SAME module identity per arm (no reload churn)', async () => {
    const a1 = await loadArmRuntime('wtbase');
    const a2 = await loadArmRuntime('wtbase');
    expect(a2).toBe(a1);
  });

  it('an arm whose dist lacks a required module fails LOUD naming the arm and module (no cross-arm fallback)', async () => {
    const broken = path.join(fixtureRoot, 'arms', 'wtbroken');
    fs.mkdirSync(path.join(broken, 'packages', 'pd-cli', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'packages', 'pd-cli', 'dist', 'index.js'), STUB_CLI, 'utf8');
    // NO principles-core dist modules.
    const raw = rawConfig();
    // TECH §4.1 allows EXACTLY two arms — wtbroken REPLACES the candidate so
    // the probe config stays loadable while 'wtbroken' is a configured arm.
    raw.candidateArm = 'wtbroken';
    delete raw.arms.wtcand;
    raw.arms.wtbroken = { worktree: broken, expectedHead: 'a'.repeat(40) };
    // Install a THROWAWAY config in a CHILD process instead of this one
    // (one process = one experiment identity): drive loadArmRuntime through
    // a subprocess that installs the extended config itself.
    const cfgFile = path.join(fixtureRoot, 'wtbroken-config.json');
    fs.writeFileSync(cfgFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const probeScript = path.join(fixtureRoot, 'wtbroken-probe.mjs');
    // Windows paths must enter ESM as file:// URLs — dynamic imports only.
    fs.writeFileSync(probeScript, [
      "import { pathToFileURL } from 'node:url';",
      "const abLib = await import(pathToFileURL(" + JSON.stringify(path.join(repoRoot, 'experiment/prompt-v2/scripts/ab/ab-lib.mjs')) + ").href);",
      "const armRuntime = await import(pathToFileURL(" + JSON.stringify(path.join(AB, 'arm-runtime.mjs')) + ").href);",
      "const cfg = abLib.useExperimentConfig(abLib.loadExperimentConfig(" + JSON.stringify(cfgFile) + "));",
      "try { await armRuntime.loadArmRuntime('wtbroken'); console.log('UNEXPECTED-OK'); process.exit(0); }",
      "catch (e) { console.log('REJECTED: ' + String(e.message).slice(0, 300)); process.exit(3); }",
    ].join('\n'), 'utf8');
    const res = runRepoScript(probeScript, []);
    expect(res.status).toBe(3);
    expect(res.stdout).toMatch(/REJECTED: arm runtime for "wtbroken"/);
    expect(res.stdout).toMatch(/sqlite-connection/);
    // The config used here is IDENTICAL to the shared one except the extra
    // arm → the subprocess also proves the shared fixture config still loads.
    expect(res.stdout).not.toMatch(/UNEXPECTED-OK/);
  });
});

// ---------------------------------------------------------------------------
// Group 7 — manifest provenance (P2-07): downstream refuses identity mismatch
// ---------------------------------------------------------------------------

describe('P2-07 manifest provenance — consumers refuse runs from a DIFFERENT config', () => {
  const RUN = 'r2-grid-ok'; // produced by the group-4 success run

  function tamperManifest(runId, mutate) {
    const runDir = path.join(experimentRoot, 'runs', runId);
    const file = fs.readdirSync(runDir).find((f) => f.startsWith('run-manifest.'));
    const backup = fs.readFileSync(path.join(runDir, file), 'utf8');
    const manifest = JSON.parse(backup);
    mutate(manifest);
    fs.writeFileSync(path.join(runDir, file), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return () => fs.writeFileSync(path.join(runDir, file), backup, 'utf8');
  }

  it('ab-metrics refuses a run whose manifest configSha256 differs from the current config', () => {
    const restore = tamperManifest(RUN, (m) => { m.configSha256 = 'c'.repeat(64); });
    try {
      const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', RUN]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/configSha256.*current config|NOT produced from the current config/s);
    } finally { restore(); }
  });

  it('ab-metrics refuses a run whose dataset digest differs', () => {
    const restore = tamperManifest(RUN, (m) => { m.datasetSha256 = 'd'.repeat(64); });
    try {
      const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', RUN]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/datasetSha256/);
    } finally { restore(); }
  });

  it('ab-metrics refuses a run whose roles differ (arm identity mismatch)', () => {
    const restore = tamperManifest(RUN, (m) => { m.roles = { baseline: 'wtcand', candidate: 'wtbase' }; });
    try {
      const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', RUN]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/roles/);
    } finally { restore(); }
  });

  it('ab-metrics refuses a run whose recorded arm head differs from the config expectedHead', () => {
    const restore = tamperManifest(RUN, (m) => { m.arms.wtbase.head = 'e'.repeat(40); });
    try {
      const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', RUN]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/arms\.wtbase\.head/);
    } finally { restore(); }
  });

  it('a run directory with NO manifest at all is refused (identity unprovable)', () => {
    const runId = 'r2-no-manifest';
    fs.mkdirSync(path.join(experimentRoot, 'runs', runId, 'records'), { recursive: true });
    fs.writeFileSync(path.join(experimentRoot, 'runs', runId, 'records', 'S01.wtbase.json'), '{}\n', 'utf8');
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', writeConfig(), '--run-id', runId]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/run-manifest identity verification failed|no run-manifest/);
  });
});

// ---------------------------------------------------------------------------
// Group 8 — legacy compatibility (old-format manifests under legacy rules)
// ---------------------------------------------------------------------------

describe('legacy compatibility — old-format manifests stay readable under legacy rules', () => {
  function writeLegacyBatchConfig() {
    const raw = rawConfig();
    delete raw.preregistration;
    raw.legacy = { batch: 'dreamer-v21-round2' };
    const cfgFile = path.join(fixtureRoot, 'legacy-config.json');
    fs.writeFileSync(cfgFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return cfgFile;
  }

  function plantLegacyRun(runId, { datasetSha256, heads, experimentId }) {
    const runDir = path.join(experimentRoot, 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'records', 'S01.wtbase.json'), `${JSON.stringify({ experimentPainId: 'S01', arm: 'wtbase', rep: 0, status: 'failed', newTaskId: 'x1' })}\n`, 'utf8');
    fs.writeFileSync(path.join(runDir, 'records', 'S01.wtcand.json'), `${JSON.stringify({ experimentPainId: 'S01', arm: 'wtcand', rep: 0, status: 'failed', newTaskId: 'x2' })}\n`, 'utf8');
    const manifest = { runId, shard: ['S01'], shardId: '0', heads };
    if (experimentId !== undefined) manifest.experimentId = experimentId;
    if (datasetSha256 !== undefined) manifest.datasetSha256 = datasetSha256;
    fs.writeFileSync(path.join(runDir, 'run-manifest.abc.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return runDir;
  }

  it('old-format manifest (no identity fields) + legacy config → metrics READS it (historical capability preserved)', () => {
    const cfg = writeLegacyBatchConfig();
    plantLegacyRun('r2-legacy-old', {
      datasetSha256: sha256File(datasetFile),
      heads: { wtbase: headOf(WT_BASE), wtcand: headOf(WT_CAND) },
    });
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', cfg, '--run-id', 'r2-legacy-old']);
    expect(res.status, `legacy read must pass (stderr=${res.stderr.slice(0, 300)})`).toBe(0);
    expect(fs.existsSync(path.join(experimentRoot, 'runs', 'r2-legacy-old', 'layer1-metrics.json'))).toBe(true);
  });

  it('old-format manifest with a WRONG dataset digest → legacy read fails closed', () => {
    const cfg = writeLegacyBatchConfig();
    plantLegacyRun('r2-legacy-wrong', {
      datasetSha256: 'e'.repeat(64),
      heads: { wtbase: headOf(WT_BASE), wtcand: headOf(WT_CAND) },
    });
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', cfg, '--run-id', 'r2-legacy-wrong']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/datasetSha256/);
  });

  it('NEW-format manifest with NOT_APPLICABLE_LEGACY + null prereg digest → legacy read passes (no forged VERIFIED)', () => {
    const cfg = writeLegacyBatchConfig();
    const runDir = plantLegacyRun('r2-legacy-new', {
      datasetSha256: sha256File(datasetFile),
      heads: { wtbase: headOf(WT_BASE), wtcand: headOf(WT_CAND) },
      experimentId: 't3b-r2-synth',
    });
    const file = fs.readdirSync(runDir).find((f) => f.startsWith('run-manifest.'));
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf8'));
    manifest.configSha256 = sha256File(path.join(fixtureRoot, 'legacy-config.json'));
    manifest.preregistrationStatus = 'NOT_APPLICABLE_LEGACY';
    manifest.preregistrationSha256 = null;
    manifest.roles = { baseline: 'wtbase', candidate: 'wtcand' };
    fs.writeFileSync(path.join(runDir, file), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', cfg, '--run-id', 'r2-legacy-new']);
    expect(res.status, `legacy new-format read must pass (stderr=${res.stderr.slice(0, 300)})`).toBe(0);
  });

  it('a PREREGISTERED config reading an identity-less manifest fails closed (identity unprovable)', () => {
    const cfg = writeConfig();
    plantLegacyRun('r2-identless-prereg', {
      datasetSha256: sha256File(datasetFile),
      heads: { wtbase: headOf(WT_BASE), wtcand: headOf(WT_CAND) },
    });
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', cfg, '--run-id', 'r2-identless-prereg']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no experimentId\/configSha256 identity fields/);
  });

  it('the two committed historical configs still fail preflight itemized (unchanged from round 1)', () => {
    for (const cfg of ['prompt-v2-round1.json', 'dreamer-v21-round2.json']) {
      const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', path.join(HISTORICAL_CONFIGS, cfg)]);
      expect(res.status, `${cfg} must fail closed on this machine (pre-v0.3 layout)`).toBe(1);
      expect(res.stderr).toMatch(/experiment config rejected/);
      expect(res.stderr.split('\n').filter((l) => l.trim().startsWith('- [')).length).toBeGreaterThanOrEqual(3);
      expect(res.stderr).not.toMatch(/at Object\.|at process\./);
    }
  });
});
