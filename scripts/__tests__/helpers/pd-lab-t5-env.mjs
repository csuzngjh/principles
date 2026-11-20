// PD-Lab v0.3 T5 (PRI-1256) test helper — constructs the hermetic synthetic
// smoke environment shared by the smoke suite and local probe scripts:
//   - two synthetic arm worktrees (fixture CLI + the REAL principles-core
//     dist copied from this checkout + fresh git HEAD),
//   - a synthetic snapshot built through the REAL schema modules,
//   - a synthetic full-fidelity dataset (2 samples: unbound + bound),
//   - a preregistration file + the experiment config binding everything.
// Writes stay inside the OS temp dir (experiment scene) and the checkout's
// gitignored `.tmp/` (arm worktrees, so the fixture CLI resolves the real
// node_modules). No real model, network, credentials or production data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURE_CLI_SOURCE = path.join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'pd-lab-t5-fixture-cli.mjs');
export const REAL_CORE_DIR = path.join(REPO_ROOT, 'packages', 'principles-core');

export const EXPERIMENT_ID = 'pri1256-t5-smoke';
export const BASELINE_ARM = 'base';
export const CANDIDATE_ARM = 'cand';
export const RUN_ID = 'smoke-run-1';
export const SENTINEL_ENV = 'PD_LAB_T5_MODEL_ENV_SENTINEL';
export const SENTINEL_VALUE = 'synthetic-sentinel-not-a-real-credential';

export const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function initArmWorktree(armDir, armName) {
  const cliDist = path.join(armDir, 'packages', 'pd-cli', 'dist');
  fs.mkdirSync(cliDist, { recursive: true });
  fs.copyFileSync(FIXTURE_CLI_SOURCE, path.join(cliDist, 'index.js'));
  // No "type" field: the fixture CLI copy is CommonJS, exactly like the
  // destination layout the real spawn wiring expects.
  writeJson(path.join(armDir, 'packages', 'pd-cli', 'package.json'), {
    name: `@t5-fixture/pd-cli-${armName}`, version: '0.0.0', private: true,
  });
  // The arm's REAL runtime: same-source-version built artifacts copied from
  // this checkout (CI builds @principles/core before the scripts suite).
  const coreDest = path.join(armDir, 'packages', 'principles-core');
  fs.mkdirSync(coreDest, { recursive: true });
  fs.cpSync(path.join(REAL_CORE_DIR, 'package.json'), path.join(coreDest, 'package.json'));
  fs.cpSync(path.join(REAL_CORE_DIR, 'dist'), path.join(coreDest, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(armDir, 'README.md'), `synthetic T5 arm worktree (${armName})\n`, 'utf8');
  const git = (args) => execFileSync('git', args, { cwd: armDir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=t5@test.invalid', '-c', 'user.name=t5', 'commit', '-qm', 'init']);
  return git(['rev-parse', 'HEAD']).trim();
}

/**
 * Build the whole synthetic environment. Returns the paths the suite (or a
 * probe) needs plus a dispose() that removes BOTH temp roots (best effort).
 */
export async function buildSmokeEnvironment() {
  // realpath the tmpdir base: os.tmpdir() can carry an 8.3 short-name
  // component on Windows (C:\Users\ADMINI~1\...); the harness's containment
  // fence compares the realpath'd experiment root against the canonical
  // workspace path, so the base must be in its long form everywhere.
  let tmpBase = os.tmpdir();
  try { tmpBase = fs.realpathSync.native(tmpBase); } catch { /* lexical fallback */ }
  const envRoot = fs.mkdtempSync(path.join(tmpBase, 'pd-lab-t5-smoke-'));
  const repoTmp = path.join(REPO_ROOT, '.tmp', 'pri-1256-smoke', `${process.pid}-${Date.now()}`);
  fs.mkdirSync(repoTmp, { recursive: true });
  const expRoot = path.join(envRoot, 'experiment');
  // The loader fences dataset/snapshot INSIDE the experimentRoot (§4.5) —
  // the synthetic snapshot is part of the experiment scene, not a sibling.
  const snapDir = path.join(expRoot, 'snapshot');
  fs.mkdirSync(path.join(expRoot, 'workspaces'), { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });

  const coreDistDir = path.join(REAL_CORE_DIR, 'dist');
  if (!fs.existsSync(path.join(coreDistDir, 'runtime', 'store', 'sqlite-connection.js'))) {
    throw new Error(`real principles-core dist missing under ${REAL_CORE_DIR} — build the workspace (root npm run build) before running the T5 smoke`);
  }

  // ── synthetic arm worktrees (fixture CLI + real dist + fresh git HEAD) ──
  const armHeads = {};
  for (const armName of [BASELINE_ARM, CANDIDATE_ARM]) {
    armHeads[armName] = await initArmWorktree(path.join(repoTmp, 'arms', armName), armName);
  }

  // ── synthetic snapshot: state.db + trajectory.db through the REAL schema
  //    modules, plus two referenced blobs + a producer-contract manifest ──
  const { pathToFileURL } = await import('node:url');
  const { SqliteConnection } = await import(
    pathToFileURL(path.join(coreDistDir, 'runtime', 'store', 'sqlite-connection.js')).href,
  );
  const scratchWs = path.join(envRoot, 'scratch-ws');
  const stateConn = new SqliteConnection(scratchWs);
  stateConn.getDb().close();
  fs.copyFileSync(path.join(scratchWs, '.pd', 'state.db'), path.join(snapDir, 'state.db'));

  const trajectorySchema = await import(
    pathToFileURL(path.join(coreDistDir, 'runtime', 'trajectory-schema.js')).href,
  );
  const Database = require('better-sqlite3');
  const traj = new Database(path.join(snapDir, 'trajectory.db'));
  try {
    trajectorySchema.applyTrajectorySchemaBase(traj);
    trajectorySchema.convergeTrajectorySchemaVersion(traj);
    const now = '2026-11-20T00:00:00.000Z';
    traj.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run('sess-smoke-0002', now, now);
    traj.prepare('INSERT INTO user_turns (session_id, turn_index, raw_text, created_at) VALUES (?, ?, ?, ?)').run('sess-smoke-0002', 0, 'synthetic seed turn for the bound smoke sample', now);
  } finally {
    traj.close();
  }

  fs.mkdirSync(path.join(snapDir, 'blobs'), { recursive: true });
  const blobFiles = [
    { ref: 'blob-smoke-1', content: 'synthetic blob content 1 (T5 hermetic smoke)' },
    { ref: 'blob-smoke-2', content: 'synthetic blob content 2 (T5 hermetic smoke)' },
  ];
  const manifestFiles = blobFiles.map((b) => {
    const buf = Buffer.from(b.content, 'utf8');
    fs.writeFileSync(path.join(snapDir, 'blobs', b.ref), buf);
    return {
      ref: b.ref,
      path: `blobs/${b.ref}`,
      sha256: sha256Buf(buf),
      bytes: buf.length,
      referenceCount: 1,
      referencedBy: ['sessions'],
    };
  });
  writeJson(path.join(snapDir, 'blob-manifest.json'), {
    schema: 'pd-lab-blob-manifest.v1',
    ok: true,
    consistencyStatus: 'CONSISTENT_WITHIN_WINDOW',
    consistencyReasons: ['synthetic complete snapshot window (T5)'],
    blobDir: 'blobs',
    files: manifestFiles,
    counts: {
      referencedDistinct: manifestFiles.length,
      referencedRows: manifestFiles.reduce((n, f) => n + f.referenceCount, 0),
      copied: manifestFiles.length,
      orphansNotCopied: 0,
    },
  });

  // ── synthetic full-fidelity dataset (2 samples; s1 unbound, s2 bound) ──
  const samples = [
    {
      experimentPainId: 'smoke-s1',
      originalPainId: 'synthetic-orig-1',
      painEvent: {
        source: 'manual', severity: 'major', score: 4,
        reason: 'smoke-s1 synthetic pain: a claimed result was not verified by a direct check',
        text: 'Synthetic full-fidelity text for smoke-s1 — no real content, generated for the hermetic smoke',
        host_kind: '', session_id: '',
      },
      diagnosisTarget: { evidence: [{ kind: 'note', sourceRef: 'synthetic://s1/1', note: 'Synthetic evidence note for smoke-s1' }] },
      evidenceRefs: ['synthetic://s1/1'],
      inclusionReason: 'synthetic T5 smoke sample (unbound)',
    },
    {
      experimentPainId: 'smoke-s2',
      originalPainId: 'synthetic-orig-2',
      painEvent: {
        source: 'session', severity: 'minor', score: 3,
        reason: 'smoke-s2 synthetic pain: a session-bound report lacked its expected follow-up',
        text: 'Synthetic full-fidelity text for smoke-s2 — no real content, generated for the hermetic smoke',
        host_kind: 'openclaw', session_id: 'sess-smoke-0002',
      },
      diagnosisTarget: { evidence: [{ kind: 'note', sourceRef: 'synthetic://s2/1', note: 'Synthetic evidence note for smoke-s2' }] },
      evidenceRefs: ['synthetic://s2/1'],
      inclusionReason: 'synthetic T5 smoke sample (bound)',
    },
  ];
  for (const s of samples) {
    const p = s.painEvent;
    s.inputDigest = sha256Buf(Buffer.from(JSON.stringify({
      reason: p.reason.slice(0, 500), source: p.source, score: typeof p.score === 'number' ? p.score : null,
      session_id: p.session_id !== '' ? p.session_id : null,
      host: p.session_id !== '' && p.host_kind === 'openclaw' ? 'openclaw' : null,
    }), 'utf8'));
  }
  const datasetPath = path.join(expRoot, 'inputs', 'dataset.json');
  fs.mkdirSync(path.dirname(datasetPath), { recursive: true });
  writeJson(datasetPath, { datasetId: 'pri1256-t5-smoke-synthetic', samples, repeatRunPicks: [] });

  // ── preregistration (YAML front matter experimentId) + raw-byte digest ──
  const preregPath = path.join(envRoot, 'PREREGISTRATION.md');
  fs.writeFileSync(preregPath,
    `---\nexperimentId: ${EXPERIMENT_ID}\n---\n\n# Preregistration — ${EXPERIMENT_ID} (synthetic)\n\n`
    + 'Synthetic preregistration for the T5 hermetic mechanical smoke. The experiment config binds '
    + 'the SHA-256 of these raw bytes. No real study is registered by this file.\n', 'utf8');
  const preregSha = sha256Buf(fs.readFileSync(preregPath));

  // ── derivation template (baseConfigFile) ──
  const baseConfigPath = path.join(envRoot, 'base-config.yaml');
  fs.writeFileSync(baseConfigPath, [
    '# T5 synthetic derivation template (hermetic smoke) — not a real workspace config.',
    'workspace:',
    '  default: /t5-placeholder/replaced-per-arm',
    'ui:',
    '  enabled: false',
    'feedback:',
    '  ingestToken: synthetic-not-a-real-token',
    'features:',
    '  intent_engineering:',
    '    category: experimentation',
    '    enabled: false',
    'telemetry:',
    '  enabled: false',
    'trajectoryRetention:',
    '  enabled: true',
    '',
  ].join('\n'), 'utf8');

  // ── the experiment config ──
  const datasetSha = sha256Buf(fs.readFileSync(datasetPath));
  const configPath = path.join(envRoot, 'config.json');
  writeJson(configPath, {
    schema: 'pd-lab-experiment-config.v1',
    _note: 'T5 hermetic smoke synthetic config — never a real experiment (PRI-1256)',
    experimentId: EXPERIMENT_ID,
    preregistration: { file: preregPath, sha256: preregSha },
    baselineArm: BASELINE_ARM,
    candidateArm: CANDIDATE_ARM,
    experimentRoot: expRoot,
    additionalForbiddenRoots: [],
    dataset: { file: datasetPath, sha256: datasetSha },
    snapshot: {
      dir: snapDir,
      sha256: {
        state: sha256Buf(fs.readFileSync(path.join(snapDir, 'state.db'))),
        trajectory: sha256Buf(fs.readFileSync(path.join(snapDir, 'trajectory.db'))),
        blobManifest: sha256Buf(fs.readFileSync(path.join(snapDir, 'blob-manifest.json'))),
      },
    },
    baseConfigFile: baseConfigPath,
    arms: {
      [BASELINE_ARM]: { worktree: path.join(repoTmp, 'arms', BASELINE_ARM), expectedHead: armHeads[BASELINE_ARM] },
      [CANDIDATE_ARM]: { worktree: path.join(repoTmp, 'arms', CANDIDATE_ARM), expectedHead: armHeads[CANDIDATE_ARM] },
    },
    modelEnv: [SENTINEL_ENV],
  });

  // ── offline chain inputs: plan + source groups (CONTRACT §3/§4) ──
  writeJson(path.join(envRoot, 'plan.json'), {
    schemaVersion: 'pd-lab-plan.v1',
    benchmarkId: 'bench-t5-smoke',
    benchmarkVersion: '1',
    comparisonDesign: 'CHANGE_VS_BASELINE',
    judgeProtocolRef: 'jp-t5@1',
    judgeProtocol: { requiredJudgments: 1 },
    analysisPolicy: { alpha: 0.05 },
    owners: [{ ownerId: 'O1', weight: 1 }],
    scenarios: [{ scenarioId: 'SC1', ownerId: 'O1', weight: 1 }],
    assignments: samples.map((s) => ({
      candidateConfigId: 'cfg-candidate',
      caseId: s.experimentPainId,
      caseVersion: 'v1',
      opportunityId: 'opp-1',
      repetitionId: 'rep-1',
      referenceId: 'ref-1',
      scenarioId: 'SC1',
      candidateTrajectoryRef: `traj-cand-${s.experimentPainId}`,
      referenceTrajectoryRef: `traj-ref-${s.experimentPainId}`,
      expectationRef: `exp-${s.experimentPainId}`,
    })),
  });
  writeJson(path.join(envRoot, 'source-groups.json'), {
    groups: { 'smoke-s1': 'sg-smoke-1', 'smoke-s2': 'sg-smoke-2' },
    rationales: {
      'sg-smoke-1': 'distinct synthetic session (s1 unbound owner report)',
      'sg-smoke-2': 'distinct synthetic session (s2 bound to sess-smoke-0002)',
    },
  });

  return {
    envRoot,
    repoTmp,
    expRoot,
    snapDir,
    configPath,
    preregPath,
    datasetPath,
    armHeads,
    fixtureLogPath: path.join(expRoot, 'workspaces', 't5-fixture-cli.log'),
    dispose() {
      for (const dir of [envRoot, repoTmp]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  };
}
