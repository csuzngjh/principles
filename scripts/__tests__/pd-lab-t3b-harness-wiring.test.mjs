/**
 * PD-Lab v0.3 T3b (PRI-1254) — harness config wiring, two-arm identity and
 * ingress contract, exercised at the REAL entry boundaries.
 *
 * Two evidence layers (TECH §9: CLI tests run the real parsing entry as a
 * subprocess and assert exit codes and output):
 *  1. in-process — the shared ab-lib surface against ONE installed synthetic
 *     config (structured derivation, declared-only diff, runId path safety,
 *     all-sample redaction, terminal classification);
 *  2. subprocess (helpers/pd-lab-t3b-run-entry.mjs) — the real CLI entries
 *     against per-test fixture configs, with the deterministic stub pd-cli
 *     fixture (fixtures/pd-lab-t3b-stub-cli.mjs, installed per arm worktree
 *     by fixtures/pd-lab-t3b-init-arm.mjs) capturing the exact child argv.
 *
 * Coverage: CF-01, CF-04, CF-06, CF-07, CF-09, CF-10, CF-12, CF-13, CF-14,
 * CF-15, CF-16, PT-05, ingress contract (score/reason/session/digest) and
 * the TECH §7 run-manifest digest set.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runRepoScript } from './helpers/pd-lab-t3b-run-entry.mjs';
import {
  useExperimentConfig, loadDataset, validateRunId, runDir,
  deriveExperimentConfigObject, deriveExperimentConfig, diffArmConfigs,
  classifyTerminal, detectDeferOnly, verifyCandidateLinkage, buildIngressArgs, decideHostArg,
  materializeWorkspace, armWorkspaceDir, experimentRoot, loadExperimentConfig,
} from '../../experiment/prompt-v2/scripts/ab/ab-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const AB = path.join(repoRoot, 'experiment', 'prompt-v2', 'scripts', 'ab');
const ANALYSIS = path.join(repoRoot, 'experiment', 'prompt-v2', 'scripts', 'analysis');
const INIT_ARM_SRC = path.join(here, 'fixtures', 'pd-lab-t3b-init-arm.mjs');
const STUB_CLI_SRC = path.join(here, 'fixtures', 'pd-lab-t3b-stub-cli.mjs');
const HISTORICAL_CONFIGS = path.join(repoRoot, 'experiment', 'prompt-v2', 'configs');

/** Full paths of EVERY migrated entry (module constants). */
const ENTRY_AB_RUN = path.join(AB, 'ab-run.mjs');
const ENTRY_AB_GRID = path.join(AB, 'ab-grid.mjs');
const ENTRY_AB_STAGE = path.join(AB, 'ab-stage.mjs');
const ENTRY_AB_PREFLIGHT = path.join(AB, 'ab-preflight.mjs');
const ENTRY_AB_PREFLIGHT_V21 = path.join(AB, 'ab-preflight-v21.mjs');
const ENTRY_AB_METRICS = path.join(AB, 'ab-metrics.mjs');
const ENTRY_AB_BLINDPACK = path.join(AB, 'ab-blindpack.mjs');
const ENTRY_AB_BLINDPACK_PAIRED = path.join(AB, 'ab-blindpack-paired.mjs');
const ENTRY_AB_DREAMER_PAIRED = path.join(AB, 'ab-dreamer-paired.mjs');
const ENTRY_AB_EVAL = path.join(AB, 'ab-eval.mjs');
const ENTRY_AB_BLIND_SUMMARY = path.join(AB, 'ab-blind-summary.mjs');
const ENTRY_AB_DIVERSITY_EVAL = path.join(AB, 'ab-diversity-eval.mjs');
const ENTRY_PAIRED_ANALYSIS = path.join(ANALYSIS, 'paired-analysis.mjs');
const ENTRY_OWNER_SPOTCHECK = path.join(ANALYSIS, 'owner-spotcheck-list.mjs');
const ENTRY_GATE0 = path.join(repoRoot, 'experiment', 'prompt-v2', 'scripts', 'gate0-failclosed.mjs');

const sha256Text = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// The config's modelEnv names this sentinel; it must EXIST for preflight.
// Planted once at module scope (children inherit it) and restored after all.
const MODEL_ENV_SENTINEL = 'PD_LAB_T3B_KEY';
const savedSentinel = process.env[MODEL_ENV_SENTINEL];
process.env[MODEL_ENV_SENTINEL] = 'synthetic-present';
afterAll(() => {
  if (savedSentinel === undefined) delete process.env[MODEL_ENV_SENTINEL];
  else process.env[MODEL_ENV_SENTINEL] = savedSentinel;
});

// ---------------------------------------------------------------------------
// Fixture: a complete, loader-valid synthetic experiment
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
    dreamer:
      enabled: true
      runtimeProfile: pi-ai.amd-ds-vision
    artificer:
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

function buildDataset() {
  return {
    spec: 'pd-lab-t3b-synthetic',
    frozenAt: '2026-11-19T00:00:00.000Z',
    samples: [
      sample('S01', { session_id: 'sess-01', score: 73, host_kind: 'openclaw' }),
      // r2 (P1-02): S02 is UNBOUND with a long reason — keeps the reason
      // truncation + no-host proof on the unbound path (no attribution).
      sample('S02', { session_id: null, host_kind: '', reason: 'T3B-long-reason-' + 'x'.repeat(600) }),
      sample('S03', { session_id: 'sess-03', host_kind: 'openclaw', reason: 'T3B_BINDING_FAIL_SENTINEL pain reason for S03' }),
      sample('S04', { session_id: null, host_kind: 'codex', score: null, confidence: 9 }),
      // r2 (P1-02): session-bound samples whose host cannot be SAFELY
      // expressed on the real CLI (empty host_kind / codex without rollout
      // lineage) must FAIL CLOSED before any CLI invocation — omitting
      // --host would hard-default the CLI to openclaw.
      sample('S05', { session_id: 'sess-05', host_kind: '' }),
      sample('S06', { session_id: 'sess-06', host_kind: 'codex' }),
    ],
    repeatRunPicks: [],
  };
}

/**
 * Initialize one synthetic arm worktree via the init fixture. The temp-dir
 * paths travel on STDIN (the subprocess command line stays literal-only);
 * the fixture answers with the fresh commit HEAD on stdout.
 */
function initArmWorktree(dir) {
  const res = runRepoScript(INIT_ARM_SRC, [], { input: JSON.stringify({ armDir: dir, stubCliSource: STUB_CLI_SRC }) });
  expect(res.status, `arm init failed: ${res.stderr}`).toBe(0);
  return res.stdout.trim();
}

function buildFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pd-lab-t3b-${label}-`));
  const experimentRoot = path.join(root, 'exp');
  fs.mkdirSync(experimentRoot, { recursive: true });

  const datasetFile = path.join(experimentRoot, 'dataset.json');
  fs.writeFileSync(datasetFile, JSON.stringify(buildDataset(), null, 2), 'utf8');

  const snapshotDir = path.join(experimentRoot, 'snap');
  fs.mkdirSync(path.join(snapshotDir, 'blobs'), { recursive: true });
  const blobBody = 'synthetic blob body 0001';
  fs.writeFileSync(path.join(snapshotDir, 'blobs', 'b1.txt'), blobBody, 'utf8');
  fs.writeFileSync(path.join(snapshotDir, 'state.db'), 'synthetic state db bytes', 'utf8');
  fs.writeFileSync(path.join(snapshotDir, 'trajectory.db'), 'synthetic trajectory db bytes', 'utf8');
  fs.writeFileSync(path.join(snapshotDir, 'blob-manifest.json'), `${JSON.stringify({
    schema: 'pd-lab-blob-manifest.v1', generatedAt: '2026-11-19T00:00:00.000Z', sourceWorkspace: 'synthetic',
    blobDir: 'blobs', ok: true, consistencyStatus: 'CONSISTENT_WITHIN_WINDOW', consistencyReasons: [],
    files: [{ path: 'blobs/b1.txt', ref: 'b1.txt', bytes: Buffer.byteLength(blobBody, 'utf8'), sha256: sha256Text(blobBody), referenceCount: 1, referencedBy: ['assistant_turns'] }],
    counts: { referencedDistinct: 1, referencedRows: 1, copied: 1, orphansNotCopied: 0 },
  }, null, 2)}\n`, 'utf8');

  const headBase = initArmWorktree(path.join(root, 'arms', 'wtbase'));
  const headCand = initArmWorktree(path.join(root, 'arms', 'wtcand'));

  const preregFile = path.join(root, 'PREREG.md');
  fs.writeFileSync(preregFile, '---\nexperimentId: t3b-synth\nplan: synthetic fixture\n---\n\n# Preregistration (synthetic)\n', 'utf8');
  const baseConfigFile = path.join(root, 'base-config.yaml');
  fs.writeFileSync(baseConfigFile, BASE_CONFIG_YAML, 'utf8');
  const wsSource = path.join(root, 'INTENT.synth.md');
  fs.writeFileSync(wsSource, '# synthetic intent document\n', 'utf8');

  const configFile = path.join(root, 'experiment-config.json');
  const rawConfig = () => ({
    schema: 'pd-lab-experiment-config.v1',
    experimentId: 't3b-synth',
    preregistration: { file: preregFile, sha256: sha256File(preregFile) },
    baselineArm: 'wtbase',
    candidateArm: 'wtcand',
    experimentRoot,
    additionalForbiddenRoots: [],
    dataset: { file: datasetFile, sha256: sha256File(datasetFile) },
    snapshot: {
      dir: snapshotDir,
      sha256: {
        state: sha256File(path.join(snapshotDir, 'state.db')),
        trajectory: sha256File(path.join(snapshotDir, 'trajectory.db')),
        blobManifest: sha256File(path.join(snapshotDir, 'blob-manifest.json')),
      },
    },
    baseConfigFile,
    profileRebind: { from: 'pi-ai.amd-ds-vision', to: 'pi-ai.glm' },
    arms: {
      wtbase: { worktree: path.join(root, 'arms', 'wtbase'), expectedHead: headBase, featureOverrides: { diagnostician_async_cli: true } },
      wtcand: {
        worktree: path.join(root, 'arms', 'wtcand'),
        expectedHead: headCand,
        featureOverrides: { diagnostician_async_cli: true, intent_engineering: true },
        workspaceFiles: [{ source: wsSource, target: '.principles/INTENT.synth.md', sha256: sha256File(wsSource) }],
      },
    },
    modelEnv: [MODEL_ENV_SENTINEL],
  });
  const writeConfig = (mutate) => {
    const raw = rawConfig();
    if (mutate) mutate(raw);
    fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return configFile;
  };

  return { root, experimentRoot, datasetFile, snapshotDir, preregFile, baseConfigFile, wsSource, headBase, headCand, rawConfig, writeConfig };
}

/** The stub CLI logs every invocation next to the workspaces dir (per fixture). */
function stubLogPath(fx) {
  return path.join(fx.experimentRoot, 'workspaces', 'stub-cli.log');
}

function readStubLog(fx) {
  const p = stubLogPath(fx);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// In-process layer: ONE installed config for the shared-surface tests
// ---------------------------------------------------------------------------

const sharedFx = buildFixture('shared');
beforeAll(() => {
  const configFile = sharedFx.writeConfig();
  useExperimentConfig(loadExperimentConfig(configFile));
});

describe('T3b §5.2 — structured YAML derivation (declared sections only)', () => {
  it('modifies ONLY the declared sections and keeps everything else key-for-key equal to the template', () => {
    const obj = deriveExperimentConfigObject(armWorkspaceDir('wtcand'), 'wtcand');
    expect(obj.workspace.default).toBe(armWorkspaceDir('wtcand'));
    expect(obj.ui).toBeUndefined();
    expect(obj.feedback).toBeUndefined();
    expect(JSON.stringify(obj)).not.toContain('SECRET-MUST-BE-DROPPED');
    expect(obj.features.diagnostician_async_cli.enabled).toBe(true);
    expect(obj.features.intent_engineering.enabled).toBe(true);
    expect(obj.features.prompt).toEqual({ category: 'core', enabled: true }); // untouched
    expect(obj.internalAgents.defaultRuntime).toBe('pi-ai.glm');
    expect(obj.internalAgents.agents.diagnostician.runtimeProfile).toBe('pi-ai.glm');
    expect(obj.runtimeProfiles['pi-ai.amd-ds-vision']).toEqual({ model: 'amd' }); // definitions stay
    expect(obj.runtimeProfiles['pi-ai.glm']).toEqual({ model: 'glm' });
    expect(obj.trajectoryRetention).toEqual({ enabled: false });
  });

  it('serialized derivation round-trips as YAML', () => {
    const text = deriveExperimentConfig(armWorkspaceDir('wtbase'), 'wtbase');
    const { load } = require(path.join(repoRoot, 'node_modules', 'js-yaml'));
    const obj = load(text.replace(/^#.*\n/gm, ''));
    expect(obj.workspace.default).toBe(armWorkspaceDir('wtbase'));
  });

  it('CF-07: the two derived configs differ ONLY at declared keys (workspace.default / features.*)', () => {
    const a = deriveExperimentConfigObject(armWorkspaceDir('wtbase'), 'wtbase');
    const b = deriveExperimentConfigObject(armWorkspaceDir('wtcand'), 'wtcand');
    const diff = diffArmConfigs(a, b);
    expect(diff.undeclared, `undeclared differences: ${JSON.stringify(diff.undeclared)}`).toEqual([]);
    const changedPaths = diff.differences.map((d) => d.path).sort();
    expect(changedPaths).toContain('.workspace.default');
    expect(changedPaths).toContain('.features.intent_engineering.enabled');
    expect(changedPaths.some((p) => p.startsWith('.internalAgents'))).toBe(false);
    expect(changedPaths.some((p) => p.startsWith('.trajectoryRetention'))).toBe(false);
  });

  it('CF-07 negative: an undeclared difference is reported (not silently accepted)', () => {
    const a = deriveExperimentConfigObject(armWorkspaceDir('wtbase'), 'wtbase');
    const b = deriveExperimentConfigObject(armWorkspaceDir('wtcand'), 'wtcand');
    const bTampered = structuredClone(b);
    bTampered.internalAgents.agents.artificer.enabled = false; // undeclared section
    const diff = diffArmConfigs(a, bTampered);
    expect(diff.ok).toBe(false);
    expect(diff.undeclared.some((d) => d.path === '.internalAgents.agents.artificer.enabled')).toBe(true);
  });
});

describe('T3b §5.6 — runId path safety (pattern + strict under-runs + reparse fence)', () => {
  it("rejects the dot-only values that pass the pattern ('.' and '..')", () => {
    expect(() => validateRunId('..')).toThrow(/dot_only/);
    expect(() => validateRunId('.')).toThrow(/dot_only/);
  });
  it('rejects separators, traversal and absolute injections', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', 'C:/abs', 'a:b', '', 'a b']) {
      expect(() => validateRunId(bad), `runId ${JSON.stringify(bad)} must be rejected`).toThrow();
    }
  });
  it('accepts a safe runId and runDir() creates it strictly under runs/', () => {
    const dir = runDir('t3b-ok.1');
    expect(path.basename(dir)).toBe('t3b-ok.1');
    expect(path.resolve(dir).toLowerCase().startsWith(path.join(experimentRoot(), 'runs').toLowerCase())).toBe(true);
    expect(() => validateRunId('t3b-ok.1')).not.toThrow();
  });
  it('rejects a junction planted at the run directory (reparse fence)', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-t3b-runid-out-'));
    const link = path.join(experimentRoot(), 'runs', 't3b-junctioned');
    fs.mkdirSync(path.join(experimentRoot(), 'runs'), { recursive: true });
    try {
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => validateRunId('t3b-junctioned')).toThrow(/reparse_point/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('T3b §5.11 — full-dataset redaction probe covers EVERY sample', () => {
  it('rejects when ANY sample (not just the first) carries a redaction marker', () => {
    const original = fs.readFileSync(sharedFx.datasetFile, 'utf8');
    const dataset = JSON.parse(original);
    dataset.samples[2].painEvent.text = '«redacted sha256:abc» later-sample redaction';
    fs.writeFileSync(sharedFx.datasetFile, JSON.stringify(dataset, null, 2), 'utf8');
    try {
      expect(() => loadDataset()).toThrow(/sample\[2\]/);
    } finally {
      fs.writeFileSync(sharedFx.datasetFile, original, 'utf8');
    }
  });
  it('accepts the clean synthetic dataset (positive control)', () => {
    const dataset = loadDataset();
    expect(dataset.samples).toHaveLength(6);
  });
});

describe('T3b §5.10 + PRI-1256 r3/r4 — terminal classification: legitimate outcomes vs persistence anomalies', () => {
  const chainTrue = { diagnoseOk: true, routerTaskSucceeded: true, routerRunSucceeded: true, stageArtifactsSchemaValid: true };

  // The classifier requires candidates AND a completed formation loop for
  // EVERY legitimate terminal — `done-no-candidate` is retired as a
  // producible state (historical persisted records still resume; covered
  // by the runtime-safety suite), and a budget-exhausted formation loop
  // falls to `incomplete` (PRI-1284 P1-3), never a done-* certificate.
  it('current: router succeeded + candidates + formation complete → done (ok)', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused: false, deferOnly: false, formationComplete: true });
    expect(t.status).toBe('done');
    expect(t.ok).toBe(true);
    expect(t.legitimateTerminal).toBeNull();
  });
  it('current: router succeeded + NO candidates → incomplete, never done-no-candidate', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: false, admissionRefused: false, deferOnly: false, formationComplete: true });
    expect(t.status).toBe('incomplete');
    expect(t.ok).toBe(false);
    expect(t.legitimateTerminal).toBeNull();
  });
  it('current: router succeeded + all-defer + NO candidates → incomplete (defer cannot rescue missing candidates)', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: false, admissionRefused: false, deferOnly: true, formationComplete: true });
    expect(t.status).toBe('incomplete');
    expect(t.ok).toBe(false);
    expect(t.legitimateTerminal).toBeNull();
  });
  it('current: router succeeded + all-defer + candidates + formation complete → done-deferred', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused: false, deferOnly: true, formationComplete: true });
    expect(t.status).toBe('done-deferred');
    expect(t.ok).toBe(true);
    expect(t.legitimateTerminal).toBe('deferred');
  });
  it('current: router succeeded + admission refused + candidates + formation complete → done-admission-refused (PRI-1222)', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused: true, deferOnly: false, formationComplete: true });
    expect(t.status).toBe('done-admission-refused');
    expect(t.ok).toBe(true);
    expect(t.legitimateTerminal).toBe('admission-refused');
  });
  it('current: router succeeded + admission refused + NO candidates → incomplete (refusal never bypasses the persistence check)', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: false, admissionRefused: true, deferOnly: false, formationComplete: true });
    expect(t.status).toBe('incomplete');
    expect(t.ok).toBe(false);
    expect(t.legitimateTerminal).toBeNull();
  });
  // PRI-1284 P1-3: a budget-exhausted formation loop is NOT a completed
  // unit — it must classify `incomplete` (resumable) even when the chain
  // and the candidate linkage are otherwise perfect.
  it('PRI-1284: budget-exhausted formation loop → incomplete, never a done-* certificate', () => {
    const t = classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused: false, deferOnly: false, formationComplete: false });
    expect(t.status).toBe('incomplete');
    expect(t.ok).toBe(false);
    expect(t.legitimateTerminal).toBeNull();
  });
  it('PRI-1284: formationComplete=false cannot be rescued by defer or admission-refused either', () => {
    for (const admissionRefused of [true, false]) {
      for (const deferOnly of [true, false]) {
        const t = classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused, deferOnly, formationComplete: false });
        expect(t.status).toBe('incomplete');
        expect(t.ok).toBe(false);
        expect(t.legitimateTerminal).toBeNull();
      }
    }
  });
  it('task/run success alone never certifies completion: no check combination yields done-no-candidate', () => {
    for (const candidatesComplete of [true, false]) {
      for (const admissionRefused of [true, false]) {
        for (const deferOnly of [true, false]) {
          for (const stageArtifactsSchemaValid of [true, false]) {
            for (const formationComplete of [true, false]) {
              const t = classifyTerminal({ ...chainTrue, stageArtifactsSchemaValid, candidatesComplete, admissionRefused, deferOnly, formationComplete });
              expect(t.status).not.toBe('done-no-candidate');
              if (!candidatesComplete || !formationComplete) expect(t.ok).toBe(false);
            }
          }
        }
      }
    }
  });
  it('the full success matrix certifies exactly the three legitimate terminals', () => {
    for (const [admissionRefused, deferOnly, expected] of [[false, false, 'done'], [false, true, 'done-deferred'], [true, false, 'done-admission-refused']]) {
      const t = classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused, deferOnly, formationComplete: true });
      expect(t.status).toBe(expected);
      expect(t.ok).toBe(true);
    }
  });
  it('classic outcomes keep their meaning: incomplete / failed', () => {
    expect(classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused: false, deferOnly: false, formationComplete: true, stageArtifactsSchemaValid: false }).status).toBe('incomplete');
    expect(classifyTerminal({ ...chainTrue, candidatesComplete: true, admissionRefused: false, deferOnly: false, formationComplete: true, routerTaskSucceeded: false }).status).toBe('failed');
  });
  it('detectDeferOnly never guesses defer: unparseable/empty/mixed recommendations are false', () => {
    const mk = (content) => [{ source_task_id: 'diag_router-t1', content_json: typeof content === 'string' ? content : JSON.stringify(content) }];
    expect(detectDeferOnly(mk({ recommendations: [{ kind: 'defer' }, { kind: 'defer' }] }))).toBe(true);
    expect(detectDeferOnly(mk({ recommendations: [{ kind: 'defer' }, { kind: 'admit' }] }))).toBe(false);
    expect(detectDeferOnly(mk({ recommendations: [] }))).toBe(false);
    expect(detectDeferOnly(mk({}))).toBe(false);
    expect(detectDeferOnly([{ source_task_id: 'diag_router-t1', content_json: 'not-json' }])).toBe(false);
    expect(detectDeferOnly([])).toBe(false);
  });

  // PRI-1256 r4/r5 — the 1:1 recommendation↔candidate linkage check itself
  // (matrix coverage through REAL ab-grid/ab-run orchestration lives in
  // pd-lab-smoke.test.mjs).
  describe('verifyCandidateLinkage — recommendation↔candidate 1:1', () => {
    // The expected set is read from the COMMITTED artifact (artifacts table,
    // kind diagnostician_output) — the row commitSync persisted atomically
    // with the candidates. The pi_artifact is consulted ONLY for the r5
    // dual-write consistency check — it can never shrink the expected set.
    const recs = ['r0', 'r1', 'r2'].map((ref) => ({ kind: 'principle', recommendationRef: ref, description: 'x' }));
    const commitArt = { artifact_id: 'art-1', run_id: 'run-1', task_id: 'diag_router-t1', content_json: JSON.stringify({ recommendations: recs }) };
    // r5 (P2-01): the dual-write copy + the actually-succeeded router run.
    const ctx = { piArtifact: { content_json: commitArt.content_json }, succeededRouterRunId: 'run-1' };
    const mkCand = (rec, i) => ({
      candidate_id: `cand-${i}`, task_id: 'diag_router-t1', status: 'pending',
      artifact_id: 'art-1', source_run_id: 'run-1', recommendation_kind: rec.kind,
      source_recommendation_json: JSON.stringify(rec),
    });
    const mkRec = (ref) => ({ kind: 'principle', recommendationRef: ref, description: 'x' });
    it('3 committed recommendations / 3 well-linked candidates → complete', () => {
      const r = verifyCandidateLinkage(commitArt, recs.map((rec, i) => mkCand(rec, i)), ctx);
      expect(r.ok).toBe(true);
      expect(r.expected).toBe(3);
      expect(r.actual).toBe(3);
      expect(r.problems).toHaveLength(0);
    });
    it.each([[2], [1], [0]])('3 committed recommendations / %i candidates → incomplete', (keep) => {
      const r = verifyCandidateLinkage(commitArt, recs.slice(0, keep).map((rec, i) => mkCand(rec, i)), ctx);
      expect(r.ok).toBe(false);
      expect(r.expected).toBe(3);
      expect(r.actual).toBe(keep);
    });
    it('3 candidates with a duplicated link (one recommendation unpersisted) → incomplete', () => {
      const r = verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), mkCand(recs[1], 2)], ctx);
      expect(r.ok).toBe(false);
    });
    it('3 candidates but one links a non-existent recommendation → incomplete', () => {
      const r = verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), mkCand(mkRec('rX'), 2)], ctx);
      expect(r.ok).toBe(false);
    });
    it('candidate linked to the wrong artifact / run → incomplete', () => {
      const bad = { ...mkCand(recs[2], 2), artifact_id: 'art-OTHER' };
      expect(verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), bad], ctx).ok).toBe(false);
      const bad2 = { ...mkCand(recs[2], 2), source_run_id: 'run-OTHER' };
      expect(verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), bad2], ctx).ok).toBe(false);
    });
    it('candidate task_id not owned by the commit task → incomplete (P2-01/A)', () => {
      const bad = { ...mkCand(recs[2], 2), task_id: 'diagnosis_t5-parent' };
      const r = verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), bad], ctx);
      expect(r.ok).toBe(false);
      expect(r.problems.join('\n')).toContain('task_id');
    });
    it('commit artifact bound to a different run than the succeeded router run → incomplete (P2-01/C)', () => {
      const cands = recs.map((rec, i) => mkCand(rec, i));
      expect(verifyCandidateLinkage(commitArt, cands, { ...ctx, succeededRouterRunId: 'run-OTHER' }).ok).toBe(false);
      // No succeeded router run at all: the commit artifact cannot be bound.
      expect(verifyCandidateLinkage(commitArt, cands, { ...ctx, succeededRouterRunId: null }).ok).toBe(false);
    });
    it('commit artifact diverges from the router pi_artifact → incomplete (P2-01/B)', () => {
      const cands = recs.map((rec, i) => mkCand(rec, i));
      const thinPi = { content_json: JSON.stringify({ recommendations: [recs[0]] }) };
      expect(verifyCandidateLinkage(commitArt, cands, { ...ctx, piArtifact: thinPi }).ok).toBe(false);
      expect(verifyCandidateLinkage(commitArt, cands, { ...ctx, piArtifact: null }).ok).toBe(false);
      const badPi = { content_json: 'not json' };
      expect(verifyCandidateLinkage(commitArt, cands, { ...ctx, piArtifact: badPi }).ok).toBe(false);
    });
    it('correct recommendationRef over tampered content / kind → incomplete (P2-01 neg3)', () => {
      const tampered = { ...recs[2], description: 'x [tampered]' };
      const bad = { ...mkCand(tampered, 2) }; // same ref, divergent source json
      expect(verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), bad], ctx).ok).toBe(false);
      const badKind = { ...mkCand(recs[2], 2), recommendation_kind: 'defer' };
      expect(verifyCandidateLinkage(commitArt, [mkCand(recs[0], 0), mkCand(recs[1], 1), badKind], ctx).ok).toBe(false);
    });
    it('a candidate linked to a DIFFERENT artifact can never slip through — commit artifact is always required', () => {
      // Devin Review r4 #2: when the commit artifact is missing the check
      // must fail, not silently skip the anchor comparisons.
      expect(verifyCandidateLinkage(null, [mkCand(recs[0], 0)], ctx).ok).toBe(false);
      expect(verifyCandidateLinkage(null, [], ctx).ok).toBe(false);
      // ...and when it is present, counts alone do not suffice.
      const wrongArt = { ...mkCand(recs[0], 0), artifact_id: 'art-OTHER' };
      const loose = { artifact_id: 'art-1', run_id: 'run-1', task_id: 'diag_router-t1', content_json: JSON.stringify({ recommendations: [recs[0]] }) };
      expect(verifyCandidateLinkage(loose, [wrongArt], ctx).ok).toBe(false);
    });
    it('missing commit artifact / unparseable committed payload → incomplete', () => {
      const badJson = { ...commitArt, content_json: 'not json' };
      expect(verifyCandidateLinkage(badJson, [mkCand(recs[0], 0)], ctx).ok).toBe(false);
      const noRef = { ...commitArt, content_json: JSON.stringify({ recommendations: [{ kind: 'principle', description: 'x' }] }) };
      expect(verifyCandidateLinkage(noRef, [], ctx).ok).toBe(false);
    });
  });
});

describe('T3b §5.8 — ingress contract builders (shared, unit layer)', () => {
  it('uses painEvent.score (NEVER confidence) and records the digest', () => {
    const { argv, evidence } = buildIngressArgs({ source: 'agent_report', score: 73, confidence: 41, reason: 'r', session_id: 's1', host_kind: 'openclaw' });
    const i = argv.indexOf('--score');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('73');
    expect(argv).not.toContain('41');
    expect(evidence.inputDigest).toBe(sha256Text(JSON.stringify({
      reason: 'r', source: 'agent_report', score: 73, session_id: 's1', host: 'openclaw',
    })));
  });
  it('truncates reason to <=500 and records the truncation facts', () => {
    const long = 'y'.repeat(600);
    const { argv, evidence } = buildIngressArgs({ source: 'manual', reason: long, host_kind: 'openclaw', session_id: 's' });
    expect(argv[argv.indexOf('--reason') + 1].length).toBe(500);
    expect(evidence.reasonTruncated).toBe(true);
    expect(evidence.reasonOriginalLength).toBe(600);
    expect(evidence.reasonSentLength).toBe(500);
  });
  it('PT-05: an empty host_kind never masquerades as openclaw', () => {
    const { hostArg, decision } = decideHostArg({ host_kind: '', session_id: 's1' });
    expect(hostArg).toEqual([]);
    expect(decision.applicable).toBe(false);
  });
  it('openclaw ingress requires BOTH host_kind=openclaw AND session evidence', () => {
    expect(decideHostArg({ host_kind: 'openclaw', session_id: 's1' }).hostArg).toEqual(['--host', 'openclaw']);
    expect(decideHostArg({ host_kind: 'openclaw', session_id: null }).hostArg).toEqual([]);
    expect(decideHostArg({ host_kind: 'codex', session_id: 's' }).hostArg).toEqual([]);
  });
});

describe('T3b §5.3 — materializeWorkspace lands workspaceFiles with verified digests', () => {
  it('copies the declared file into the candidate arm workspace and nowhere else', () => {
    const cand = materializeWorkspace('wtcand', { shardId: 'mat1' });
    const target = path.join(cand.workspace, '.principles', 'INTENT.synth.md');
    expect(fs.existsSync(target)).toBe(true);
    expect(sha256File(target)).toBe(sha256File(sharedFx.wsSource));
    const base = materializeWorkspace('wtbase', { shardId: 'mat1' });
    expect(fs.existsSync(path.join(base.workspace, '.principles', 'INTENT.synth.md'))).toBe(false);
    expect(base.workspaceFiles).toEqual([]);
    expect(cand.workspaceFiles.some((w) => w.state === 'created')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subprocess layer: real CLI entries
// ---------------------------------------------------------------------------

describe('CF-01 — missing --config exits 2 with usage (one explicit test per entry)', () => {
  const expectUsageExit2 = (entry, res) => {
    expect(res.status, `${entry} must exit 2 (got ${res.status})\nstdout=${res.stdout.slice(0, 200)}\nstderr=${res.stderr.slice(0, 300)}`).toBe(2);
    expect(res.stderr).toMatch(/--config <file> is required/);
    expect(res.stderr).toMatch(/usage:/i);
    expect(res.stderr).not.toMatch(/at Object\.|at process\./); // no uncaught stack
  };
  it('ab-run.mjs', () => { expectUsageExit2('ab-run.mjs', runRepoScript(ENTRY_AB_RUN, [])); });
  it('ab-grid.mjs', () => { expectUsageExit2('ab-grid.mjs', runRepoScript(ENTRY_AB_GRID, [])); });
  it('ab-stage.mjs', () => { expectUsageExit2('ab-stage.mjs', runRepoScript(ENTRY_AB_STAGE, [])); });
  it('ab-preflight.mjs', () => { expectUsageExit2('ab-preflight.mjs', runRepoScript(ENTRY_AB_PREFLIGHT, [])); });
  it('ab-preflight-v21.mjs', () => { expectUsageExit2('ab-preflight-v21.mjs', runRepoScript(ENTRY_AB_PREFLIGHT_V21, [])); });
  it('ab-metrics.mjs', () => { expectUsageExit2('ab-metrics.mjs', runRepoScript(ENTRY_AB_METRICS, [])); });
  it('ab-blindpack.mjs', () => { expectUsageExit2('ab-blindpack.mjs', runRepoScript(ENTRY_AB_BLINDPACK, [])); });
  it('ab-blindpack-paired.mjs', () => { expectUsageExit2('ab-blindpack-paired.mjs', runRepoScript(ENTRY_AB_BLINDPACK_PAIRED, [])); });
  it('ab-dreamer-paired.mjs', () => { expectUsageExit2('ab-dreamer-paired.mjs', runRepoScript(ENTRY_AB_DREAMER_PAIRED, [])); });
  it('ab-eval.mjs', () => { expectUsageExit2('ab-eval.mjs', runRepoScript(ENTRY_AB_EVAL, [])); });
  it('ab-blind-summary.mjs', () => { expectUsageExit2('ab-blind-summary.mjs', runRepoScript(ENTRY_AB_BLIND_SUMMARY, [])); });
  it('ab-diversity-eval.mjs', () => { expectUsageExit2('ab-diversity-eval.mjs', runRepoScript(ENTRY_AB_DIVERSITY_EVAL, [])); });
  it('analysis/paired-analysis.mjs', () => { expectUsageExit2('paired-analysis.mjs', runRepoScript(ENTRY_PAIRED_ANALYSIS, [])); });
  it('analysis/owner-spotcheck-list.mjs', () => { expectUsageExit2('owner-spotcheck-list.mjs', runRepoScript(ENTRY_OWNER_SPOTCHECK, [])); });
  it('gate0-failclosed.mjs', () => { expectUsageExit2('gate0-failclosed.mjs', runRepoScript(ENTRY_GATE0, [])); });
});

describe('CF-09 — a config missing baselineArm is rejected by every entry (no letter-order revival)', () => {
  const expectBaselineRejected = (entry, res) => {
    expect(res.status, `${entry} must fail on a baseline-less config (got ${res.status})`).toBe(1);
    expect(res.stderr).toMatch(/\[baselineArm\]/);
    expect(res.stderr).not.toMatch(/at Object\./);
  };
  const removeBaseline = (raw) => { delete raw.baselineArm; };

  it('ab-run.mjs rejects', () => {
    const configFile = buildFixture('cf9run').writeConfig(removeBaseline);
    expectBaselineRejected('ab-run.mjs', runRepoScript(ENTRY_AB_RUN, ['--config', configFile, '--run-id', 'cf9', '--shard-id', '0']));
  });
  it('ab-grid.mjs rejects', () => {
    const configFile = buildFixture('cf9grid').writeConfig(removeBaseline);
    expectBaselineRejected('ab-grid.mjs', runRepoScript(ENTRY_AB_GRID, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-stage.mjs rejects', () => {
    const configFile = buildFixture('cf9stage').writeConfig(removeBaseline);
    expectBaselineRejected('ab-stage.mjs', runRepoScript(ENTRY_AB_STAGE, ['--config', configFile, '--run-id', 'cf9', '--stage', 'distiller']));
  });
  it('ab-preflight.mjs rejects', () => {
    const configFile = buildFixture('cf9pf').writeConfig(removeBaseline);
    expectBaselineRejected('ab-preflight.mjs', runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]));
  });
  it('ab-preflight-v21.mjs rejects', () => {
    const configFile = buildFixture('cf9pf21').writeConfig(removeBaseline);
    expectBaselineRejected('ab-preflight-v21.mjs', runRepoScript(ENTRY_AB_PREFLIGHT_V21, ['--config', configFile]));
  });
  it('ab-metrics.mjs rejects', () => {
    const configFile = buildFixture('cf9met').writeConfig(removeBaseline);
    expectBaselineRejected('ab-metrics.mjs', runRepoScript(ENTRY_AB_METRICS, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-blindpack.mjs rejects', () => {
    const configFile = buildFixture('cf9bp').writeConfig(removeBaseline);
    expectBaselineRejected('ab-blindpack.mjs', runRepoScript(ENTRY_AB_BLINDPACK, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-blindpack-paired.mjs rejects', () => {
    const configFile = buildFixture('cf9bpp').writeConfig(removeBaseline);
    expectBaselineRejected('ab-blindpack-paired.mjs', runRepoScript(ENTRY_AB_BLINDPACK_PAIRED, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-dreamer-paired.mjs rejects', () => {
    const configFile = buildFixture('cf9dp').writeConfig(removeBaseline);
    expectBaselineRejected('ab-dreamer-paired.mjs', runRepoScript(ENTRY_AB_DREAMER_PAIRED, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-eval.mjs rejects', () => {
    const configFile = buildFixture('cf9ev').writeConfig(removeBaseline);
    expectBaselineRejected('ab-eval.mjs', runRepoScript(ENTRY_AB_EVAL, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-blind-summary.mjs rejects', () => {
    const configFile = buildFixture('cf9bs').writeConfig(removeBaseline);
    expectBaselineRejected('ab-blind-summary.mjs', runRepoScript(ENTRY_AB_BLIND_SUMMARY, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('ab-diversity-eval.mjs rejects', () => {
    const configFile = buildFixture('cf9de').writeConfig(removeBaseline);
    expectBaselineRejected('ab-diversity-eval.mjs', runRepoScript(ENTRY_AB_DIVERSITY_EVAL, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('analysis/paired-analysis.mjs rejects', () => {
    const configFile = buildFixture('cf9pa').writeConfig(removeBaseline);
    expectBaselineRejected('paired-analysis.mjs', runRepoScript(ENTRY_PAIRED_ANALYSIS, ['--config', configFile, '--run-id', 'cf9']));
  });
  it('analysis/owner-spotcheck-list.mjs rejects', () => {
    const configFile = buildFixture('cf9os').writeConfig(removeBaseline);
    expectBaselineRejected('owner-spotcheck-list.mjs', runRepoScript(ENTRY_OWNER_SPOTCHECK, ['--config', configFile, '--runs', 'cf9']));
  });
  it('gate0-failclosed.mjs rejects', () => {
    const configFile = buildFixture('cf9g0').writeConfig(removeBaseline);
    expectBaselineRejected('gate0-failclosed.mjs', runRepoScript(ENTRY_GATE0, ['--config', configFile]));
  });
});

describe('ab-preflight — generic checks over the config (CF-04/06/10/14/15)', () => {
  it('passes for the valid synthetic fixture (modelEnv present, heads exact, derived diff declared-only)', () => {
    const fx = buildFixture('pf-ok');
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', fx.writeConfig()]);
    expect(res.status, `stderr=${res.stderr.slice(0, 500)}\nstdout=${res.stdout.slice(0, 300)}`).toBe(0);
    const report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(report.ok).toBe(true);
    expect(report.experimentId).toBe('t3b-synth');
    expect(report.preregistrationStatus).toBe('VERIFIED');
  });

  it('CF-04: a mismatched expectedHead fails the arm-head check (no run/task is created)', () => {
    const fx = buildFixture('cf04');
    const configFile = fx.writeConfig((raw) => {
      raw.arms.wtbase.expectedHead = 'f'.repeat(40);
    });
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/arm-head-matches-expected:wtbase/);
    expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
  });

  it('CF-04 negative control: the same fixture with correct heads passes (proves the failure is the HEAD)', () => {
    const fx = buildFixture('cf04-pos');
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', fx.writeConfig()]);
    expect(res.status).toBe(0);
  });

  it('CF-06: workspaceFiles target escape is rejected by the loader before preflight checks', () => {
    const fx = buildFixture('cf06-escape');
    const configFile = fx.writeConfig((raw) => {
      raw.arms.wtcand.workspaceFiles[0].target = '../escaped.md';
    });
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/workspaceFiles\[0\]\.target/);
  });

  it('CF-06: a symlink in the workspaceFiles intermediate chain is rejected', () => {
    const fx = buildFixture('cf06-link');
    const linkParent = path.join(fx.experimentRoot, 'workspaces', 'wtcand', '.principles');
    fs.mkdirSync(linkParent, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-t3b-wsf-out-'));
    try {
      fs.symlinkSync(outside, path.join(linkParent, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
      const configFile = fx.writeConfig((raw) => {
        raw.arms.wtcand.workspaceFiles[0].target = path.join('.principles', 'linked-dir', 'INTENT.synth.md');
      });
      const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/workspaceFiles|reparse|symlink/);
    } finally {
      fs.rmSync(path.join(linkParent, 'linked-dir'), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('CF-10: an unregistered feature flag id is rejected with the flag name', () => {
    const fx = buildFixture('cf10');
    const configFile = fx.writeConfig((raw) => {
      raw.arms.wtcand.featureOverrides = { diagnostician_async_clii: true }; // typo'd flag
    });
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/diagnostician_async_clii/);
    expect(res.stderr).toMatch(/unregistered_feature_flag/);
  });

  it('CF-14: preregistration raw-byte digest mismatch is rejected before any run record', () => {
    const fx = buildFixture('cf14');
    const configFile = fx.writeConfig();
    fs.appendFileSync(fx.preregFile, '\n<!-- tampered after config write -->\n', 'utf8');
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/preregistration/);
    expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
  });

  it('CF-15: front-matter experimentId mismatch is rejected (digest refreshed — identity is the failure)', () => {
    const fx = buildFixture('cf15');
    fs.writeFileSync(fx.preregFile, '---\nexperimentId: some-other-experiment\nplan: x\n---\nbody\n', 'utf8');
    const configFile = fx.writeConfig((raw) => {
      raw.preregistration.sha256 = sha256File(fx.preregFile);
    });
    const res = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/experiment_id_mismatch/);
  });

  it('CF-16: ab-run re-preflights from CURRENT files — a prereg tampered after preflight is refused before any run record or child', () => {
    const fx = buildFixture('cf16');
    const configFile = fx.writeConfig();
    const pre = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', configFile]);
    expect(pre.status).toBe(0); // preflight passed on the original bytes
    fs.appendFileSync(fx.preregFile, '\n<!-- tampered between preflight and run -->\n', 'utf8');
    const run = runRepoScript(ENTRY_AB_RUN, ['--config', configFile, '--run-id', 'cf16-run', '--shard-id', '0']);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/preregistration/);
    expect(fs.existsSync(path.join(fx.experimentRoot, 'runs', 'cf16-run'))).toBe(false);
    expect(readStubLog(fx), 'no child process may start').toEqual([]);
  });
});

describe('ab-run — ingress contract + global arm order + run-manifest (subprocess)', () => {
  function runAbRun(fx, runId, samples, shardId) {
    const args = ['--config', fx.writeConfig(), '--run-id', runId, '--shard-id', shardId];
    if (samples) args.push('--samples', samples.join(','));
    return runRepoScript(ENTRY_AB_RUN, args);
  }

  function recordFor(fx, runId, sid, arm) {
    const p = path.join(fx.experimentRoot, 'runs', runId, 'records', `${sid}.${arm}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  function firstArmPerSampleFromStdout(stdout) {
    const out = {};
    for (const m of stdout.matchAll(/\] (S\d+) rep(\d+) (wtbase|wtcand) \(shard/g)) {
      if (out[m[1]] === undefined) out[m[1]] = m[3];
    }
    return out;
  }

  it('score/reason/session/host/inputDigest per the TECH §7 contract (real stub CLI argv)', () => {
    const fx = buildFixture('ingress');
    const res = runAbRun(fx, 't3b-ingress', null, '0');
    expect(res.status, `stdout tail=${res.stdout.slice(-600)}`).toBe(0);
    const log = readStubLog(fx).filter((l) => l.cmd === 'pain record');
    // S01: score 73 (not confidence 41), host openclaw, session bound
    const s01 = log.find((l) => l.args[l.args.indexOf('--session') + 1] === 'sess-01');
    expect(s01.args[s01.args.indexOf('--score') + 1]).toBe('73');
    expect(s01.args).not.toContain('41');
    expect(s01.args[s01.args.indexOf('--host') + 1]).toBe('openclaw');
    // S02 (r2: UNBOUND): reason truncated to 500 before the CLI; no --host,
    // no --session (unbound Owner report records no host attribution).
    const s02 = log.find((l) => (l.args[l.args.indexOf('--reason') + 1] ?? '').includes('T3B-long-reason'));
    expect(s02, 'S02 unbound pain record must reach the stub CLI').toBeTruthy();
    expect(s02.args[s02.args.indexOf('--reason') + 1].length).toBe(500);
    expect(s02.args).not.toContain('--host');
    expect(s02.args).not.toContain('--session');
    // S03: binding failure → terminal ingress_binding_failed. The sample runs
    // in BOTH arms (one pain-record per arm) and NEITHER arm may fall back to
    // an unbound re-record — exactly 2 invocations total, both session-bound.
    const s03calls = log.filter((l) => l.args[l.args.indexOf('--session') + 1] === 'sess-03');
    expect(s03calls).toHaveLength(2);
    for (const arm of ['wtbase', 'wtcand']) {
      const rec = recordFor(fx, 't3b-ingress', 'S03', arm);
      expect(rec.status, `${arm} S03 must terminate ingress_binding_failed`).toBe('ingress_binding_failed');
      expect(rec.ingressMode).toBe('ingress_binding_failed');
      expect(rec.ingress.bindingFailure).toBeTruthy();
    }
    // S04: no session → unbound; codex host without lineage → no --host
    const s04 = log.find((l) => (l.args[l.args.indexOf('--reason') + 1] ?? '').includes('S04'));
    expect(s04.args).not.toContain('--session');
    expect(s04.args).not.toContain('--host');
    // r2 P1-02: session-bound + unexpressible host → fail-closed BEFORE any
    // CLI invocation (no pain-record stub call at all, session preserved).
    for (const [sid, sess] of [['S05', 'sess-05'], ['S06', 'sess-06']]) {
      expect(log.some((l) => l.args[l.args.indexOf('--session') + 1] === sess),
        `${sid} must never reach the CLI (fail-closed before any write)`).toBe(false);
      for (const arm of ['wtbase', 'wtcand']) {
        const rec = recordFor(fx, 't3b-ingress', sid, arm);
        expect(rec.status, `${arm} ${sid} must fail closed`).toBe('failed');
        expect(rec.errorCategory).toBe('ingress_host_unresolvable');
        expect(rec.ingressMode).toBe('ingress_host_unresolvable');
        expect(rec.ingress.hostDecision.failClosed).toBe(true);
        expect(rec.ingress.inputArgsSummary.hasSession).toBe(true);
        expect(rec.ingress.hostDecision.basis).toMatch(/openclaw/i);
      }
    }
    // record evidence: inputDigest matches the recomputed digest
    const rec01 = recordFor(fx, 't3b-ingress', 'S01', 'wtbase');
    const ing = rec01.ingress;
    expect(ing.inputDigest).toBe(sha256Text(JSON.stringify({
      reason: 'pain reason for S01', source: 'agent_report', score: 73, session_id: 'sess-01', host: 'openclaw',
    })));
    expect(ing.reasonTruncated).toBe(false);
    expect(ing.hostDecision.applicable).toBe(true);
    expect(rec01.armRole).toBe('baseline');
    const recCand = recordFor(fx, 't3b-ingress', 'S01', 'wtcand');
    expect(recCand.armRole).toBe('candidate');
  });

  it('PT-05 entry-level: session-bound unknown host is refused, never attributed openclaw (r2 P1-02)', () => {
    const fx = buildFixture('pt05');
    const res = runAbRun(fx, 'pt05-run', ['S05'], '0');
    expect(res.status).toBe(0);
    // No CLI invocation may carry sess-05 — the refusal happens BEFORE any
    // write, so the DB-side openclaw default can never trigger.
    const painCalls = readStubLog(fx).filter((l) => l.cmd === 'pain record');
    for (const call of painCalls) {
      expect(call.args[call.args.indexOf('--session') + 1]).not.toBe('sess-05');
    }
    const rec = recordFor(fx, 'pt05-run', 'S05', 'wtbase');
    expect(rec.status).toBe('failed');
    expect(rec.errorCategory).toBe('ingress_host_unresolvable');
    expect(rec.ingress.hostDecision.failClosed).toBe(true);
    expect(rec.ingress.hostDecision.basis).toMatch(/would default to openclaw/);
    expect(rec.ingress.inputArgsSummary.hasSession).toBe(true); // session preserved in evidence
  });

  it('PT-05 entry-level: unbound empty-host sample reaches the CLI WITHOUT --host (no attribution)', () => {
    const fx = buildFixture('pt05-unbound');
    const res = runAbRun(fx, 'pt05-unbound-run', ['S02'], '0');
    expect(res.status).toBe(0);
    const call = readStubLog(fx).find((l) => l.cmd === 'pain record' && (l.args[l.args.indexOf('--reason') + 1] ?? '').includes('T3B-long-reason'));
    expect(call).toBeTruthy();
    expect(call.args).not.toContain('--host');
    expect(call.args).not.toContain('--session');
    const rec = recordFor(fx, 'pt05-unbound-run', 'S02', 'wtbase');
    expect(rec.ingress.hostDecision.basis).toMatch(/unbound report — no host attribution involved/);
  });

  it('CF-12: arm order uses the GLOBAL sample index — invariant under different shard layouts', () => {
    const fx = buildFixture('cf12');
    // Layout A: all four samples in one shard (local == global indices).
    const a = runAbRun(fx, 'cf12-run', ['S01', 'S02', 'S03', 'S04'], '0');
    expect(a.status).toBe(0);
    const orderA = firstArmPerSampleFromStdout(a.stdout);
    // Layout B: S02+S03 alone — S03's local index is 1 while its global
    // index is 2 (opposite parity → OPPOSITE local-index prediction; only
    // the global index keeps the order stable).
    const b = runAbRun(fx, 'cf12-run', ['S02', 'S03'], '1');
    expect(b.status).toBe(0);
    const orderB = firstArmPerSampleFromStdout(b.stdout);

    const dataset = buildDataset();
    const globalIndex = new Map(dataset.samples.map((s, i) => [s.experimentPainId, i]));
    const arms = ['wtbase', 'wtcand'];
    const h = parseInt(sha256Text('cf12-run').slice(0, 8), 16);
    for (const sid of ['S02', 'S03']) {
      const g = globalIndex.get(sid);
      const globalFirst = (h + g) % 2 === 0 ? arms[0] : arms[1];
      const localFirstInB = (h + (sid === 'S02' ? 0 : 1)) % 2 === 0 ? arms[0] : arms[1];
      expect(orderA[sid], `layout A first arm for ${sid}`).toBe(globalFirst);
      expect(orderB[sid], `layout B first arm for ${sid} must equal the GLOBAL prediction`).toBe(globalFirst);
      expect(orderA[sid]).toBe(orderB[sid]);
      if (sid === 'S03') {
        expect(localFirstInB, 'S03 local/global indices have opposite parity — predictions must differ').not.toBe(globalFirst);
      }
    }
  });

  it('run-manifest records the TECH §7 digest set (config/prereg/arms/dataset/snapshot), no legacy heads.v1/v2', () => {
    const fx = buildFixture('manifest');
    const configFile = fx.writeConfig();
    const res = runRepoScript(ENTRY_AB_RUN, ['--config', configFile, '--run-id', 't3b-manifest', '--shard-id', '0']);
    expect(res.status).toBe(0);
    const runsDir = path.join(fx.experimentRoot, 'runs', 't3b-manifest');
    const manifestFiles = fs.readdirSync(runsDir).filter((f) => f.startsWith('run-manifest.'));
    expect(manifestFiles).toHaveLength(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(runsDir, manifestFiles[0]), 'utf8'));
    const configSha = sha256File(configFile);
    expect(manifest.experimentId).toBe('t3b-synth');
    expect(manifest.configSha256).toBe(configSha);
    expect(manifest.preregistrationStatus).toBe('VERIFIED');
    expect(manifest.preregistrationSha256).toBe(sha256File(fx.preregFile));
    expect(manifest.roles).toEqual({ baseline: 'wtbase', candidate: 'wtcand' });
    expect(manifest.arms.wtbase.head).toBe(fx.headBase);
    expect(manifest.arms.wtbase.expectedHead).toBe(fx.headBase);
    expect(manifest.arms.wtcand.head).toBe(fx.headCand);
    expect(manifest.arms.wtcand.derivedConfigSha256).toBe(sha256File(path.join(fx.experimentRoot, 'workspaces', 'wtcand-s0', '.pd', 'config.yaml')));
    expect(manifest.datasetSha256).toBe(sha256File(fx.datasetFile));
    expect(manifest.snapshot.sha256.state).toBe(sha256File(path.join(fx.snapshotDir, 'state.db')));
    expect(manifest.snapshot.sha256.blobManifest).toBe(sha256File(path.join(fx.snapshotDir, 'blob-manifest.json')));
    expect(manifest.heads).toBeUndefined(); // the hardcoded heads.v1/v2 field is gone
    // candidate workspaceFiles landed with the declared digest
    const intent = path.join(fx.experimentRoot, 'workspaces', 'wtcand-s0', '.principles', 'INTENT.synth.md');
    expect(fs.existsSync(intent)).toBe(true);
    expect(sha256File(intent)).toBe(sha256File(fx.wsSource));
  });

  it('CF-13: a loadable legacy config runs and records NOT_APPLICABLE_LEGACY + null digest', () => {
    const fx = buildFixture('legacy');
    const configFile = fx.writeConfig((raw) => {
      delete raw.preregistration;
      raw.legacy = { batch: 'dreamer-v21-round2' };
    });
    const res = runRepoScript(ENTRY_AB_RUN, ['--config', configFile, '--run-id', 't3b-legacy', '--shard-id', '0']);
    expect(res.status, `stderr=${res.stderr.slice(0, 400)}`).toBe(0);
    const runsDir = path.join(fx.experimentRoot, 'runs', 't3b-legacy');
    const manifestFile = fs.readdirSync(runsDir).find((f) => f.startsWith('run-manifest.'));
    const manifest = JSON.parse(fs.readFileSync(path.join(runsDir, manifestFile), 'utf8'));
    expect(manifest.preregistrationStatus).toBe('NOT_APPLICABLE_LEGACY');
    expect(manifest.preregistrationSha256).toBeNull(); // never a forged digest
  });

  it('the two committed historical configs fail preflight itemized (no uncaught exception)', () => {
    const r1cfg = path.join(HISTORICAL_CONFIGS, 'prompt-v2-round1.json');
    const r1 = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', r1cfg]);
    expect(r1.status, 'prompt-v2-round1.json must fail closed (pre-v0.3 historical layout)').toBe(1);
    expect(r1.stderr).toMatch(/experiment config rejected/);
    expect(r1.stderr.split('\n').filter((l) => l.trim().startsWith('- [')).length).toBeGreaterThanOrEqual(3);
    expect(r1.stderr).not.toMatch(/at Object\.|at process\./);
    const r2cfg = path.join(HISTORICAL_CONFIGS, 'dreamer-v21-round2.json');
    const r2 = runRepoScript(ENTRY_AB_PREFLIGHT, ['--config', r2cfg]);
    expect(r2.status, 'dreamer-v21-round2.json must fail closed (pre-v0.3 historical layout)').toBe(1);
    expect(r2.stderr).toMatch(/experiment config rejected/);
    expect(r2.stderr.split('\n').filter((l) => l.trim().startsWith('- [')).length).toBeGreaterThanOrEqual(3);
    expect(r2.stderr).not.toMatch(/at Object\.|at process\./);
  });
});

describe('ab-metrics role propagation (subprocess over a synthetic run)', () => {
  it('lab:metrics consumes the config arm pair and labels roles (not letter order)', () => {
    const fx = buildFixture('metrics');
    const runRes = runRepoScript(ENTRY_AB_RUN, ['--config', fx.writeConfig(), '--run-id', 't3b-metrics', '--shard-id', '0']);
    expect(runRes.status).toBe(0);
    const res = runRepoScript(ENTRY_AB_METRICS, ['--config', fx.writeConfig(), '--run-id', 't3b-metrics']);
    expect(res.status, `stderr=${res.stderr.slice(0, 300)} stdout=${res.stdout.slice(0, 300)}`).toBe(0);
    const jsonStart = res.stdout.indexOf('{');
    const report = JSON.parse(res.stdout.slice(jsonStart, res.stdout.lastIndexOf('}') + 1));
    expect(report.roles).toEqual({ baseline: 'wtbase', candidate: 'wtcand' });
    expect(report.full.wtbase).toBeTruthy();
    expect(report.full.wtcand).toBeTruthy();
    expect(report.pairs.fullChain.arms).toEqual({ baseline: 'wtbase', candidate: 'wtcand' });
    expect(report.pairs.fullChain.missing.every((m) => ['wtbase', 'wtcand', 'both'].includes(m.missingArm))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRI-1284 — budget flags must fail loudly, never silently degrade
// ---------------------------------------------------------------------------

describe('PRI-1284 — malformed budget flags are rejected at the real CLI boundary', () => {
  // Before this change, `--reps abc` produced NaN and silently filtered out
  // every repeat while still printing "run complete", and a non-numeric
  // `--formation-depth` made the depth comparison dead. Both entries must
  // refuse non-positive-integers BEFORE any record write.
  const expectBudgetRejected = (entry, flag, res) => {
    expect(res.status, `${entry} ${flag} must exit non-zero (got ${res.status})\nstdout=${res.stdout.slice(0, 200)}`).not.toBe(0);
    expect(res.stderr).toMatch(new RegExp(`${flag.replace(/-/g, '\\-')} must be a positive integer`));
  };

  const fx = buildFixture('budget');

  for (const [flag, bad] of [['--reps', 'abc'], ['--reps', '0'], ['--reps', '2.5'], ['--formation-depth', 'abc'], ['--formation-depth', '0'], ['--reps=abc', null], ['--formation-depth=0', null]]) {
    const flagName = flag.split('=')[0];
    const flagArgs = flag.includes('=') ? [flag] : [flag, bad];
    const label = flag.includes('=') ? flag : `${flag} ${bad}`;
    it(`ab-run.mjs rejects ${label}`, () => {
      const res = runRepoScript(ENTRY_AB_RUN, ['--config', fx.writeConfig(), '--run-id', `bud-${flagName.slice(2)}-${flag.includes('=') ? 'eq' : bad}`, '--shard-id', '0', ...flagArgs]);
      expectBudgetRejected('ab-run.mjs', flagName, res);
    });
    it(`ab-grid.mjs rejects ${label} (same contract, forwarded to shards)`, () => {
      const res = runRepoScript(ENTRY_AB_GRID, ['--config', fx.writeConfig(), '--run-id', `budg-${flagName.slice(2)}-${flag.includes('=') ? 'eq' : bad}`, ...flagArgs]);
      expectBudgetRejected('ab-grid.mjs', flagName, res);
    });
  }
});
