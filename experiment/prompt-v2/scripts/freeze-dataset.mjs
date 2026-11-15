/**
 * PD-SPEC-001 Phase 0d — dataset selection freeze.
 * Reads ONLY the snapshot DBs; writes the frozen dataset + manifest.
 * Every ID comes from real records; nothing is synthesized.
 */
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';
import { fileURLToPath } from 'node:url';
import { redactForPublication } from './redact-for-publication.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const worktree = findRepoRoot(import.meta.url);
const snapDir = path.join(worktree, '.tmp/prompt-v2-inventory/snapshot');
const state = new Database(path.join(snapDir, 'state.db'), { readonly: true });
const traj = new Database(path.join(snapDir, 'trajectory.db'), { readonly: true });

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Selection (16 real pains; rationale in DATASET_SELECTION.md) ──
const SELECTION = [
  { s: 'S01', painId: 'manual_1788265732489_9nexm9e6', cat: 'successful-full-chain', reason: 'earliest complete chain (2026-09-01), manual source, principle+rule+implementation candidates' },
  { s: 'S02', painId: 'manual_1790560349371_zjwa3dus', cat: 'successful-full-chain', reason: 'router emitted all 5 kinds incl. defer — routing breadth sample' },
  { s: 'S03', painId: 'pain_host_620a1683e2eeb7a714ce5eb67aac55b08dc8bee7164211358c5f00f308068791', cat: 'successful-full-chain', reason: 'host user_correction with complete formation (2026-09-17)' },
  { s: 'S04', painId: 'pain_host_34d5095d650709424fb49f234feffdbec4dd02d56db372d3453e9d38de69399e', cat: 'successful-full-chain', reason: 'single principle candidate — minimal router output; duplicate-risk probe vs earlier principles' },
  { s: 'S05', painId: 'manual_1791287582948_82fego9k', cat: 'successful-full-chain', reason: 'principle+implementation+rule+defer mix (2026-10-06)' },
  { s: 'S06', painId: 'pain_host_432596aee54456a9a157b01f2af66cfe4521089bc5d5ee740e2133b72d3f4c8f', cat: 'successful-full-chain', reason: 'principle-only candidate, early period — ledger-overlap (duplicate-risk) probe' },
  { s: 'S07', painId: 'manual_1794417662834_86wvtpyy', cat: 'successful-full-chain', reason: 'freshest full chain (2026-11-11), user_correction via manual channel, production flags active, mixed scribe outcomes' },
  { s: 'S08', painId: 'manual_1788266915526_u5s94f40', cat: 'successful-no-formation', reason: 'diag complete (incl. defer+prompt kinds) but no formation — partial-chain behavior sample' },
  { s: 'S09', painId: 'pain_host_4dbcf38f94b770ce39c173213d384c534f04bbd8b1130a1bd2c11f62b0d57c2c', cat: 'successful-no-formation', reason: 'recent (2026-10-30) principle-only, formation never ran' },
  { s: 'S10', painId: 'manual_1788417836446_68yyxjpc', cat: 'needs-evidence', reason: 'only inventory pain whose diagnosis path flagged insufficient evidence — uncertainty-handling sample' },
  { s: 'S11', painId: 'pain_host_ce2de9e3844577a776d6a9de152d21f0f4a0b1e2862e8178556f303fcb86a1ed', cat: 'failed-environment', reason: '2026-10-13 failure cluster (timeout class) — V1 output absent, V1-rebuild path' },
  { s: 'S12', painId: 'pain_host_eb614cc9cfe610fad415e3c15d36961896fa8af27258f3947efb7be5de6a9d94', cat: 'failed-environment', reason: 'most recent failure (2026-11-12), rootcause run timed out 3 attempts — stability sample' },
  { s: 'S13', painId: 'manual_1789971610800_jckds5xo', cat: 'failed-environment', reason: 'only manual-source diagnosis failure' },
  { s: 'S14', painId: 'manual_1794421512105_wz88cscb', cat: 'scribe-failure', reason: 'diag+dreamer+philosopher succeeded but scribe failed (2026-11-12 cluster) — Scribe quality/failure sample' },
  { s: 'S15', painId: 'llm_1791862851742', cat: 'stage-a-only', reason: 'llm_paralysis pain never diagnosed — fresh sparse-evidence Stage A probe' },
  { s: 'S16', painId: 'pain_1789213195082_79cf6674', cat: 'stage-a-only', reason: 'the only tool_failure pain, never diagnosed — tooling-attribution Stage A probe' },
];

const getPain = traj.prepare('SELECT id, session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at FROM pain_events WHERE canonical_pain_id = ?');
const getTaskFull = state.prepare('SELECT task_id, task_kind, status, attempt_count, max_attempts, last_error, input_ref, result_ref, diagnostic_json, created_at, updated_at FROM tasks WHERE task_id = ?');
const getRuns = state.prepare('SELECT run_id, task_id, execution_status, reason, error_category, attempt_number, LENGTH(input_payload) AS input_len, LENGTH(output_payload) AS output_len, started_at, ended_at FROM runs WHERE task_id = ? ORDER BY attempt_number');
const getRunOutput = state.prepare('SELECT output_payload FROM runs WHERE task_id = ? AND execution_status = ? ORDER BY attempt_number DESC LIMIT 1');
const getRunInput = state.prepare('SELECT input_payload FROM runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1');
const getPiArts = state.prepare('SELECT artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at FROM pi_artifacts WHERE source_task_id = ? ORDER BY created_at');
const getCands = state.prepare("SELECT candidate_id, artifact_id, task_id, title, description, confidence, status, recommendation_kind, trigger_pattern, action, abstracted_principle, created_at FROM principle_candidates WHERE task_id = ? OR task_id = ?");
const getDiag = state.prepare('SELECT * FROM pain_diagnoses WHERE pain_id = ?');
const getChainTasks = (agent, candidateId) => state.prepare("SELECT task_id, status, attempt_count, last_error, created_at FROM tasks WHERE task_kind = ? AND task_id LIKE ? ORDER BY created_at").all(agent, `${agent}-${candidateId}-%`);

// Ledger snapshot (existing principles for duplicate-risk dimension)
const activations = state.prepare('SELECT * FROM activations ORDER BY rowid').all();
const approvedCands = state.prepare("SELECT candidate_id, title, abstracted_principle, status, created_at FROM principle_candidates WHERE status != 'consumed' ORDER BY created_at").all();
const ledgerSnapshot = {
  activationsCount: activations.length,
  approvalsCount: state.prepare('SELECT count(*) AS c FROM approvals').get().c,
  activationsSha256: sha256(JSON.stringify(activations)),
  nonConsumedCandidates: approvedCands.length,
  nonConsumedCandidatesSha256: sha256(JSON.stringify(approvedCands)),
};

const LIMITS = {
  'stage-a-only': 'no persisted diagnosisTarget (diagnosis task never created); Stage A input must be assembled from the pain event via the production bridge mapping; V1 has no historical output — both arms are fresh runs',
};

const samples = [];
for (const sel of SELECTION) {
  const pain = getPain.get(sel.painId);
  if (!pain) throw new Error(`pain not found in snapshot: ${sel.painId}`);
  const diagTaskId = `diagnosis_${sel.painId}`;
  const diagTask = getTaskFull.get(diagTaskId) ?? null;
  let diagnosisTarget = null;
  if (diagTask?.diagnostic_json) {
    try { diagnosisTarget = JSON.parse(diagTask.diagnostic_json); } catch { diagnosisTarget = { unparseable: true }; }
  }
  const stages = {};
  for (const [key, id] of [['rootcause', `diag_rootcause-${diagTaskId}`], ['distiller', `diag_distiller-${diagTaskId}`], ['router', `diag_router-${diagTaskId}`]]) {
    const t = getTaskFull.get(id);
    if (!t) { stages[key] = null; continue; }
    const runs = getRuns.all(id);
    const arts = getPiArts.all(id);
    const succeededOutput = getRunOutput.get(id, 'succeeded')?.output_payload ?? null;
    stages[key] = {
      task: { task_id: t.task_id, status: t.status, attempt_count: t.attempt_count, last_error: t.last_error },
      runs: runs.map((r) => ({ ...r, input_len: r.input_len, output_len: r.output_len })),
      artifactIds: arts.map((a) => a.artifact_id),
      artifacts: arts.map((a) => ({ artifact_id: a.artifact_id, content_json: a.content_json })),
      succeededRunOutputPayload: succeededOutput,
      routerPersistedInput: key === 'router' ? (getRunInput.get(id)?.input_payload ?? null) : undefined,
    };
  }
  const cands = diagTask ? getCands.all(`diag_router-${diagTaskId}`, diagTaskId) : [];
  const formation = cands.map((c) => ({
    candidate: c,
    dreamer: getChainTasks('dreamer', c.candidate_id).map((t) => ({
      task: t,
      artifacts: getPiArts.all(t.task_id).map((a) => ({ artifact_id: a.artifact_id, content_json: a.content_json })),
      succeededRunOutputPayload: getRunOutput.get(t.task_id, 'succeeded')?.output_payload ?? null,
    })),
    philosopher: getChainTasks('philosopher', c.candidate_id).map((t) => ({
      task: t,
      artifacts: getPiArts.all(t.task_id).map((a) => ({ artifact_id: a.artifact_id, content_json: a.content_json })),
      succeededRunOutputPayload: getRunOutput.get(t.task_id, 'succeeded')?.output_payload ?? null,
    })),
    scribe: getChainTasks('scribe', c.candidate_id).map((t) => ({
      task: t,
      artifacts: getPiArts.all(t.task_id).map((a) => ({ artifact_id: a.artifact_id, content_json: a.content_json })),
      succeededRunOutputPayload: getRunOutput.get(t.task_id, 'succeeded')?.output_payload ?? null,
    })),
  }));

  const digestSource = JSON.stringify({
    painEvent: pain,
    diagnosisTarget,
    rootcauseArtifact: stages.rootcause?.artifacts?.[0]?.content_json ?? null,
    distillerArtifact: stages.distiller?.artifacts?.[0]?.content_json ?? null,
  });
  samples.push({
    experimentPainId: sel.s,
    originalPainId: sel.painId,
    originalTaskId: diagTask ? diagTaskId : null,
    sampleCategory: sel.cat,
    painEvent: pain,
    diagnosisTarget,
    painDiagnosis: diagTask ? (getDiag.get(sel.painId) ?? null) : null,
    diagnosticianTask: diagTask ? { task_id: diagTask.task_id, status: diagTask.status, attempt_count: diagTask.attempt_count, last_error: diagTask.last_error } : null,
    stageArtifacts: stages,
    candidates: cands,
    formation,
    evidenceRefs: Array.isArray(diagnosisTarget?.evidence) ? diagnosisTarget.evidence.map((e) => e?.sourceRef).filter((x) => typeof x === 'string') : [],
    hasCorrectionEvidence: Boolean(diagnosisTarget?.correctionEvidence),
    inputDigest: sha256(digestSource),
    inclusionReason: sel.reason,
    knownLimitations: LIMITS[sel.cat] ?? 'none recorded',
  });
}

// coverage validation against inventory
const inv = JSON.parse(readFileSync(path.join(worktree, 'experiment/prompt-v2/dataset/pain-inventory.json'), 'utf8'));
const known = new Set(inv.pains.map((p) => p.painId));
for (const s of samples) if (!known.has(s.originalPainId)) throw new Error(`selected pain not in inventory: ${s.originalPainId}`);

const dataset = {
  spec: 'PD-SPEC-001',
  frozenAt: new Date().toISOString(),
  v1BaseCommit: '0485046e71d2aeba4769725adb4f2aac35a5dd9b',
  snapshotHashes: JSON.parse(readFileSync(path.join(worktree, '.tmp/prompt-v2-inventory/snapshot-report.json'), 'utf8')).snapshots,
  ledgerSnapshot,
  repeatRunPicks: ['S07', 'S10', 'S12', 'S02', 'S14'],
  samples,
};
const outDir = path.join(worktree, 'experiment/prompt-v2/dataset');
// Dual write: FULL-fidelity copy stays local (.tmp, gitignored — execution and
// blind evaluation read it); the COMMITTED copy is field-redacted for the
// public repo (verbatim pain text → sha256 placeholders, see
// redact-for-publication.mjs). Both copies are regenerable from the snapshot
// DBs via snapshot-and-discover.mjs + this script.
const tmpDir = path.join(worktree, '.tmp/prompt-v2-inventory');
mkdirSync(tmpDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'pain-dataset.full.json'), JSON.stringify(dataset, null, 2) + '\n', 'utf8');
writeFileSync(path.join(outDir, 'pain-dataset.json'), JSON.stringify(redactForPublication(dataset), null, 2) + '\n', 'utf8');

const manifest = {
  spec: 'PD-SPEC-001',
  datasetFile: 'pain-dataset.json',
  frozenAt: dataset.frozenAt,
  sampleCount: samples.length,
  byCategory: samples.reduce((acc, s) => { acc[s.sampleCategory] = (acc[s.sampleCategory] ?? 0) + 1; return acc; }, {}),
  correctionEvidenceSamples: samples.filter((s) => s.hasCorrectionEvidence).map((s) => s.experimentPainId),
  v1BaseCommit: dataset.v1BaseCommit,
  snapshotSha256: Object.fromEntries(Object.entries(dataset.snapshotHashes).map(([k, v]) => [k, v.sha256])),
  ledgerSnapshot: dataset.ledgerSnapshot,
  repeatRunPicks: dataset.repeatRunPicks,
  sampleDigests: Object.fromEntries(samples.map((s) => [s.experimentPainId, s.inputDigest])),
};
writeFileSync(path.join(outDir, 'dataset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(manifest, null, 1));
