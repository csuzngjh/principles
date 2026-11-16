/**
 * PD-SPEC-001 Phase 0c step 2 — full pain inventory from the SNAPSHOT.
 * Read-only against .tmp/prompt-v2-inventory/snapshot/*.db.
 *
 * Aggregates per pain: diag task + stage statuses, pain_diagnoses row,
 * principle candidates, internalization chain (dreamer/philosopher/scribe
 * tasks joined via candidate uuid), artifacts. Classifies per SPEC §2.3.
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';
import { fileURLToPath } from 'node:url';
import { redactForPublication } from './redact-for-publication.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const worktree = findRepoRoot(import.meta.url);
const snap = (n) => path.join(worktree, '.tmp/prompt-v2-inventory/snapshot', n);
const state = new Database(snap('state.db'), { readonly: true });
const traj = new Database(snap('trajectory.db'), { readonly: true });

const pains = traj.prepare('SELECT id, session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at FROM pain_events ORDER BY id ASC').all();

const getTask = state.prepare('SELECT task_id, task_kind, status, attempt_count, max_attempts, last_error, created_at, updated_at FROM tasks WHERE task_id = ?');
const getDiagRow = state.prepare('SELECT id, pain_id, task_id, diagnosis_id, category, root_cause, confidence, artifact_id, created_at FROM pain_diagnoses WHERE pain_id = ?');
const getCandidates = state.prepare("SELECT candidate_id, artifact_id, task_id, title, description, confidence, status, recommendation_kind, abstracted_principle, created_at FROM principle_candidates WHERE task_id = ? OR task_id = ?");
const getStageArtifacts = state.prepare('SELECT artifact_id, artifact_kind, source_task_id, validation_status, created_at FROM pi_artifacts WHERE source_task_id = ?');
const getChainTasks = (agent, candidateId) => state.prepare("SELECT task_id, status, attempt_count, last_error, created_at FROM tasks WHERE task_kind = ? AND task_id LIKE ? ORDER BY created_at").all(agent, `${agent}-${candidateId}-%`);

const inventory = [];
for (const p of pains) {
  const painId = p.canonical_pain_id ?? null;
  const entry = {
    painEventId: p.id,
    painId,
    sessionId: p.session_id,
    runtimeTaskId: p.runtime_task_id,
    source: p.source,
    severity: p.severity,
    origin: p.origin,
    score: p.confidence ?? p.score,
    reason: p.reason,
    textPreview: typeof p.text === 'string' ? p.text.slice(0, 400) : p.text,
    textLength: typeof p.text === 'string' ? p.text.length : 0,
    hostKind: p.host_kind,
    createdAt: p.created_at,
    chain: null,
  };
  if (painId) {
    const diagTaskId = `diagnosis_${painId}`;
    const diagTask = getTask.get(diagTaskId);
    const rc = getTask.get(`diag_rootcause-${diagTaskId}`);
    const di = getTask.get(`diag_distiller-${diagTaskId}`);
    const ro = getTask.get(`diag_router-${diagTaskId}`);
    const diagRow = getDiagRow.get(painId);
    const candidates = diagTask ? getCandidates.all(`diag_router-${diagTaskId}`, diagTaskId) : [];
    const formation = [];
    for (const c of candidates) {
      formation.push({
        candidateId: c.candidate_id,
        status: c.status,
        kind: c.recommendation_kind,
        abstractedPrinciple: c.abstracted_principle,
        dreamer: getChainTasks('dreamer', c.candidate_id),
        philosopher: getChainTasks('philosopher', c.candidate_id),
        scribe: getChainTasks('scribe', c.candidate_id),
      });
    }
    const stageArtifacts = {
      rootcause: rc ? getStageArtifacts.all(rc.task_id) : [],
      distiller: di ? getStageArtifacts.all(di.task_id) : [],
      router: ro ? getStageArtifacts.all(ro.task_id) : [],
      diagnostician: getStageArtifacts.all(diagTaskId),
    };
    entry.chain = {
      diagTask: diagTask ?? null,
      rootcause: rc ?? null,
      distiller: di ?? null,
      router: ro ?? null,
      painDiagnosis: diagRow ?? null,
      candidates,
      formation,
      stageArtifacts,
    };
  }
  inventory.push(entry);
}

// ── Classification (SPEC §2.3; categories may overlap) ──
function classify(e) {
  const cats = [];
  if (!e.chain || !e.chain.diagTask) {
    cats.push('Undiagnosed'); // pain event exists, no diagnosis task at all
    return cats;
  }
  const st = (t) => t?.status ?? 'missing';
  const rc = st(e.chain.rootcause);
  const di = st(e.chain.distiller);
  const ro = st(e.chain.router);
  const diag = st(e.chain.diagTask);
  const formationDone = e.chain.formation.some((f) => f.scribe.some((t) => t.status === 'succeeded'));
  const anyFailed = [diag, rc, di, ro].includes('failed');
  if (diag === 'succeeded' && ro === 'succeeded') cats.push(formationDone ? 'Successful' : 'Successful-NoFormation');
  if (diag === 'failed' || rc === 'failed' || di === 'failed' || ro === 'failed') cats.push('Failed');
  if (diag === 'succeeded' && (ro === 'missing' || di === 'missing' || rc === 'missing')) cats.push('Partial');
  if (e.source === 'tool_failure') cats.push('Tooling Failure');
  const reasons = `${e.reason ?? ''} ${e.chain?.painDiagnosis?.root_cause ?? ''}`;
  if (/needs_evidence|insufficient evidence|证据不足/i.test(reasons)) cats.push('Needs Evidence');
  if ((e.chain?.candidates?.length ?? 0) > 0) cats.push('Has Candidates');
  if (/多重|multiple|多因|multi-?cause/i.test(reasons)) cats.push('Multi-cause Signal');
  return cats;
}
for (const e of inventory) e.categories = classify(e);

const summary = {
  totalPainEvents: inventory.length,
  bySource: {},
  byCategory: {},
  withDiagnosis: inventory.filter((e) => e.chain?.diagTask).length,
  withFullDiagChain: inventory.filter((e) => e.chain?.router?.status === 'succeeded').length,
  withFormation: inventory.filter((e) => e.chain?.formation?.some((f) => f.scribe.some((t) => t.status === 'succeeded'))).length,
  undiagnosed: inventory.filter((e) => !e.chain?.diagTask).length,
};
for (const e of inventory) {
  summary.bySource[e.source] = (summary.bySource[e.source] ?? 0) + 1;
  for (const c of e.categories) summary.byCategory[c] = (summary.byCategory[c] ?? 0) + 1;
}

const outDir = path.join(worktree, 'experiment/prompt-v2/dataset');
mkdirSync(outDir, { recursive: true });
const invFull = { generatedAt: new Date().toISOString(), snapshotHashes: JSON.parse(readFileSync(path.join(worktree, '.tmp/prompt-v2-inventory/snapshot-report.json'), 'utf8')).snapshots, summary, pains: inventory };
// Dual write (public-repo redaction — see redact-for-publication.mjs): full
// copy stays local (.tmp), committed copy carries digests for verbatim fields.
const tmpDir = path.join(worktree, '.tmp/prompt-v2-inventory');
mkdirSync(tmpDir, { recursive: true });
writeFileSync(path.join(tmpDir, 'pain-inventory.full.json'), JSON.stringify(invFull, null, 2) + '\n', 'utf8');
writeFileSync(path.join(outDir, 'pain-inventory.json'), JSON.stringify(redactForPublication(invFull), null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 1));
console.log('full inventory -> .tmp/prompt-v2-inventory/pain-inventory.full.json; redacted -> experiment/prompt-v2/dataset/pain-inventory.json');
