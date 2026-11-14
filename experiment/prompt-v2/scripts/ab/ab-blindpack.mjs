/**
 * PD-SPEC-001 Phase 5 — blind evaluation packager (SPEC §7).
 *
 * Builds anonymized evaluation packages from A/B run records:
 *  - per-stage pairs (rootcause/distiller/router/dreamer/philosopher/scribe)
 *    for the full-chain run AND the per-agent run where present;
 *  - the evaluator sees: original pain, evidence snapshot, owner correction
 *    (when present), and the two outputs labelled Output-A / Output-B in
 *    randomized order. It NEVER sees arm identity or the prompt text.
 * The blind map (package → arm) is stored separately (blindmap.json).
 *
 * Usage: node ab-blindpack.mjs --run-id <gridRunId> [--pa-run-id <perAgentRunId>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXPERIMENT_ROOT, DATASET_FILE, loadDataset } from './ab-lib.mjs';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
const paRunId = getOpt('--pa-run-id', null);
if (!runId) throw new Error('--run-id required');

const sha256 = (s) => createHash('sha256').update(JSON.stringify(s)).digest('hex');
const rand = (() => { let h = parseInt(sha256(runId).slice(0, 12), 16); return () => { h = (h * 1103515245 + 12345) % 2147483648; return h / 2147483648; }; })();

const dataset = loadDataset();
const byPain = new Map(dataset.samples.map((s) => [s.experimentPainId, s]));
const runDir = path.join(EXPERIMENT_ROOT, 'runs', runId);
const recordsDir = path.join(runDir, 'records');
const paRecordsDir = paRunId ? path.join(EXPERIMENT_ROOT, 'runs', paRunId, 'records-pa') : null;

function stageOutputFromRecord(rec, stage) {
  if (!rec?.artifacts) return null;
  if (stage === 'rootcause' || stage === 'distiller' || stage === 'router') {
    const key = stage === 'rootcause' ? 'rootcause' : stage;
    const arts = rec.artifacts.stageArtifacts?.filter((a) => a.source_task_id.startsWith(`diag_${stage === 'rootcause' ? 'rootcause' : stage}-`)) ?? [];
    const art = arts[arts.length - 1];
    return art ? art.content_json : null;
  }
  // formation: prefer scribe>philosopher>dreamer artifacts of the first candidate
  const arts = rec.artifacts.formationArtifacts ?? [];
  const of = (kindPrefix) => arts.filter((a) => a.source_task_id.startsWith(`${kindPrefix}-`));
  const pool = stage === 'scribe' ? of('scribe') : stage === 'philosopher' ? of('philosopher') : of('dreamer');
  const art = pool[pool.length - 1];
  return art ? art.content_json : null;
}

function sampleMeta(sid) {
  const s = byPain.get(sid);
  if (!s) return null;
  return {
    experimentPainId: sid,
    painSource: s.painEvent?.source,
    severity: s.painEvent?.severity,
    reason: s.painEvent?.reason,
    painTextHead: typeof s.painEvent?.text === 'string' ? s.painEvent.text.slice(0, 1200) : null,
    ownerCorrection: s.hasCorrectionEvidence ? s.diagnosisTarget?.correctionEvidence?.text ?? null : null,
    evidenceRefs: s.evidenceRefs,
    inclusionReason: s.inclusionReason,
  };
}

const packages = [];
const blindMap = {};

function addPair(stage, sid, outV1, outV2, source) {
  if (!outV1 || !outV2) return;
  const flip = rand() < 0.5;
  const pkgId = sha256({ stage, sid, source, outV1: sha256(outV1), outV2: sha256(outV2) }).slice(0, 16);
  packages.push({
    evalId: pkgId,
    stage,
    source, // full-chain | per-agent
    sample: sampleMeta(sid),
    outputA: flip ? outV2 : outV1,
    outputB: flip ? outV1 : outV2,
  });
  blindMap[pkgId] = { armA: flip ? 'v2' : 'v1', armB: flip ? 'v1' : 'v2', stage, sid, source };
}

// full-chain pairs
if (fs.existsSync(recordsDir)) {
  for (const sid of byPain.keys()) {
    const v1p = path.join(recordsDir, `${sid}.v1.json`);
    const v2p = path.join(recordsDir, `${sid}.v2.json`);
    if (!fs.existsSync(v1p) || !fs.existsSync(v2p)) continue;
    const r1 = JSON.parse(fs.readFileSync(v1p, 'utf8'));
    const r2 = JSON.parse(fs.readFileSync(v2p, 'utf8'));
    for (const stage of ['rootcause', 'distiller', 'router', 'dreamer', 'philosopher', 'scribe']) {
      addPair(stage, sid, stageOutputFromRecord(r1, stage), stageOutputFromRecord(r2, stage), 'full-chain');
    }
  }
}

// per-agent pairs (identical frozen upstream inputs)
if (paRecordsDir && fs.existsSync(paRecordsDir)) {
  for (const f of fs.readdirSync(paRecordsDir)) {
    const m = f.match(/^([^.]+)\.(distiller|router|dreamer|philosopher|scribe)\.(v1)\.json$/);
    if (!m) continue;
    const [, sid, stage] = m;
    const p1 = path.join(paRecordsDir, f);
    const p2 = path.join(paRecordsDir, f.replace('.v1.', '.v2.'));
    if (!fs.existsSync(p2)) continue;
    const r1 = JSON.parse(fs.readFileSync(p1, 'utf8'));
    const r2 = JSON.parse(fs.readFileSync(p2, 'utf8'));
    const art1 = r1.result?.artifacts?.[r1.result.artifacts.length - 1]?.content_json ?? null;
    const art2 = r2.result?.artifacts?.[r2.result.artifacts.length - 1]?.content_json ?? null;
    addPair(stage, sid, art1, art2, 'per-agent');
  }
}

const outDir = path.join(runDir, 'blindpack');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'packages.json'), JSON.stringify({ runId, paRunId, generatedAt: new Date().toISOString(), count: packages.length, packages }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'blindmap.json'), JSON.stringify({ runId, generatedAt: new Date().toISOString(), map: blindMap }, null, 2) + '\n', 'utf8');
console.log(`packages=${packages.length} -> ${path.relative(process.cwd(), path.join(outDir, 'packages.json'))}`);
const byStage = {};
for (const p of packages) byStage[`${p.stage}/${p.source}`] = (byStage[`${p.stage}/${p.source}`] ?? 0) + 1;
console.log(JSON.stringify(byStage));
