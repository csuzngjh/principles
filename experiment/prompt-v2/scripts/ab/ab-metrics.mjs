/**
 * PD-SPEC-001 Phase 5 layer-1 collector — pipeline-run quality metrics
 * (SPEC §6.1) computed from the A/B run records + arm state DBs, per arm.
 *
 * Pairing and aggregation contract (Owner remediation 2026-11-15):
 *  - Record files are parsed with the canonical grammar
 *      ^([^.]+)\.(v1|v2)(?:\.rep(\d+))?\.json$   (full-chain)
 *      ^([^.]+)\.<stage>\.(v1|v2)(?:\.rep(\d+))?\.json$   (per-agent)
 *    so repeat rounds (`.rep1.json`, `.rep2.json`) are counted instead of
 *    being silently dropped by an `endsWith('.v1.json')` filter;
 *  - pairs are keyed by the real Pair primary key (experimentPainId, stage,
 *    rep, arm): a pair exists when BOTH arms have a record for the same
 *    (sample, stage, rep); a missing side is reported in `missing`, never
 *    silently dropped, and never inferred as files.length / 2;
 *  - repeat runs are aggregated per sample (one primary record = rep 0, plus
 *    per-rep variance), never counted as independent samples.
 *
 * All SQL is parameterized; per-file/DB failures are collected in
 * `invalidFiles` with a structured reason (rc-3/rc-9) instead of crashing.
 *
 * Usage: node ab-metrics.mjs --run-id <id> [--experiment full|per-agent|both]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { bootstrapConfigContext, experimentRoot as experimentRootFn, configArms, currentConfig, validateRunId, assertRunManifestIdentity } from './ab-lib.mjs';
import { parseRecordFileName, parsePerAgentFileName, FULL_CHAIN_STAGES } from './ab-blindpack.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * The arm pair is ALWAYS an explicit parameter (baseline first) or the
 * installed config's pair — never a module constant, never letter order
 * (TECH §4.4: index.v1/index.v2-style fixed roles are deleted since T3b).
 */
const DIAG_STAGES = ['rootcause', 'distiller', 'router'];
const DIAG_TASK_PREFIX = { rootcause: 'diag_rootcause-', distiller: 'diag_distiller-', router: 'diag_router-' };
const FORMATION_STAGES = ['dreamer', 'philosopher', 'scribe'];
const STAGE_PREFIX = {
  rootcause: 'diag_rootcause-',
  distiller: 'diag_distiller-',
  router: 'diag_router-',
  dreamer: 'dreamer-',
  philosopher: 'philosopher-',
  scribe: 'scribe-',
};

export { parseRecordFileName, parsePerAgentFileName };

function armDbPath(arm, experimentRoot, shardId = null) {
  // Per-shard workspaces (remediation Phase 4): records carry their shardId;
  // the legacy shared layout only applies to shard-less records.
  const dir = shardId ? path.join(experimentRoot, 'workspaces', arm + '-s' + shardId) : path.join(experimentRoot, 'workspaces', arm);
  return path.join(dir, '.pd', 'state.db');
}

/** Which pipeline stages does this record carry artifacts for? (pair key input) */
export function stagePresenceOf(rec) {
  const sa = Array.isArray(rec?.artifacts?.stageArtifacts) ? rec.artifacts.stageArtifacts : [];
  const fa = Array.isArray(rec?.artifacts?.formationArtifacts) ? rec.artifacts.formationArtifacts : [];
  const presence = {};
  for (const stage of FULL_CHAIN_STAGES) {
    const arts = FORMATION_STAGES.includes(stage) ? fa : sa;
    presence[stage] = arts.some((a) => typeof a?.source_task_id === 'string' && a.source_task_id.startsWith(STAGE_PREFIX[stage]));
  }
  return presence;
}

/**
 * Collect per-record layer-1 rows for one arm from a full-chain records dir.
 * Failures are observable: invalidFiles carries {file, reason}.
 */
export function collectArm(arm, recordsDir, { experimentRoot: rootOverride = null, arms = null } = {}) {
  const experimentRoot = rootOverride ?? experimentRootFn();
  // Review 0008: the record filename grammar parses the SAME arm set the
  // caller consumes — an explicit custom pair must not fall back to the
  // historical vocabulary (records of custom arms would be silently ignored).
  const parseArms = arms ?? (() => { try { return configArms(); } catch { return null; } })();
  const result = { arm, entries: [], invalidFiles: [], filesMatched: 0 };
  if (!recordsDir || !fs.existsSync(recordsDir)) return result;
  // DB is opened PER RECORD shard (records may span shards in one run dir).
  const dbCache = new Map();
  const dbFor = (shardId) => {
    const key = shardId ?? '__shared__';
    if (dbCache.has(key)) return dbCache.get(key);
    const dbPath = armDbPath(arm, experimentRoot, shardId);
    let handle = null;
    let err = null;
    if (fs.existsSync(dbPath)) {
      try { handle = new Database(dbPath, { readonly: true }); } catch (e) { err = String(e?.message ?? e); }
    }
    const entry = { db: handle, error: err, path: dbPath };
    dbCache.set(key, entry);
    return entry;
  };
  try {
    for (const f of fs.readdirSync(recordsDir)) {
      const parsed = parseRecordFileName(f, parseArms ?? undefined);
      if (!parsed || parsed.arm !== arm) continue;
      result.filesMatched += 1;
      const sid = parsed.sid;
      const rep = parsed.rep;
      const invalid = (reason) => result.invalidFiles.push({ file: f, arm, sid, rep, reason });

      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8')); } catch (e) { invalid(`record-unreadable: ${e?.message ?? e}`); continue; }
      const taskId = rec?.newTaskId ?? rec?.targetTaskId;
      if (typeof taskId !== 'string' || taskId.length === 0) { invalid('no-task-id'); continue; }
      const shardEntry = dbFor(rec?.shardId ?? null);
      if (!shardEntry.db) { invalid(shardEntry.error ? `db-open-failed: ${shardEntry.error}` : `workspace-db-missing: ${shardEntry.path}`); continue; }
      const db = shardEntry.db;

      try {
        const stages = {};
        for (const [k, prefix] of Object.entries(DIAG_TASK_PREFIX)) {
          stages[k] = db.prepare('SELECT status, attempt_count, last_error FROM tasks WHERE task_id = ?').get(`${prefix}${taskId}`) ?? null;
        }
        const runs = db.prepare('SELECT task_id, execution_status, attempt_number, error_category, started_at, ended_at, LENGTH(output_payload) AS out_len FROM runs WHERE task_id IN (?,?,?,?) ORDER BY task_id, attempt_number')
          .all(taskId, `${DIAG_TASK_PREFIX.rootcause}${taskId}`, `${DIAG_TASK_PREFIX.distiller}${taskId}`, `${DIAG_TASK_PREFIX.router}${taskId}`);
        const cands = db.prepare('SELECT count(*) AS c FROM principle_candidates WHERE task_id = ?').get(`${DIAG_TASK_PREFIX.router}${taskId}`)?.c ?? 0;
        const arts = db.prepare('SELECT artifact_id, source_task_id, lineage_artifact_ids FROM pi_artifacts WHERE source_task_id IN (?,?,?)')
          .all(`${DIAG_TASK_PREFIX.rootcause}${taskId}`, `${DIAG_TASK_PREFIX.distiller}${taskId}`, `${DIAG_TASK_PREFIX.router}${taskId}`);
        result.entries.push({
          file: f, sid, arm, rep,
          experimentPainId: typeof rec.experimentPainId === 'string' ? rec.experimentPainId : sid,
          ingressMode: rec.ingressMode ?? null,
          status: rec.status ?? null,
          stages,
          runs,
          candidates: cands,
          stageArtifacts: arts.map((a) => ({ id: a.artifact_id, src: a.source_task_id, lineage: a.lineage_artifact_ids })),
          stagePresence: stagePresenceOf(rec),
        });
      } catch (e) {
        invalid(`db-query-failed: ${e?.message ?? e}`);
      }
    }
  } finally {
    for (const { db: handle } of dbCache.values()) { try { handle?.close(); } catch { /* already closed */ } }
  }
  return result;
}

/** Per-agent stage records: parse (sample, stage, arm, rep) from filenames. */
export function collectPerAgentArm(arm, paDir, { arms = null } = {}) {
  const result = { arm, entries: [], invalidFiles: [], filesMatched: 0 };
  if (!paDir || !fs.existsSync(paDir)) return result;
  const parseArms = arms ?? (() => { try { return configArms(); } catch { return null; } })();
  for (const f of fs.readdirSync(paDir)) {
    const parsed = parsePerAgentFileName(f, parseArms ?? undefined);
    if (!parsed || parsed.arm !== arm) continue;
    result.filesMatched += 1;
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(paDir, f), 'utf8')); } catch (e) {
      result.invalidFiles.push({ file: f, arm, sid: parsed.sid, stage: parsed.stage, rep: parsed.rep, reason: `record-unreadable: ${e?.message ?? e}` });
      continue;
    }
    result.entries.push({ file: f, sid: parsed.sid, stage: parsed.stage, arm, rep: parsed.rep, artifactCount: Array.isArray(rec?.result?.artifacts) ? rec.result.artifacts.length : 0 });
  }
  return result;
}

/**
 * Aggregate per-file entries into ONE row per sample (Pair primary key:
 * experimentPainId). rep 0 is the primary record; every additional rep is
 * kept as variance data — never counted as an independent sample.
 */
export function aggregateBySample(entries) {
  const bySid = new Map();
  for (const e of entries) {
    const sid = e.experimentPainId ?? e.sid;
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push(e);
  }
  const samples = [];
  for (const [sid, list] of bySid) {
    list.sort((a, b) => a.rep - b.rep);
    const primary = list.find((e) => e.rep === 0) ?? list[0];
    const totalAttempts = { rootcause: 0, distiller: 0, router: 0 };
    const stageFailureCounts = { rootcause: 0, distiller: 0, router: 0 };
    const allRuns = [];
    for (const e of list) {
      for (const k of DIAG_STAGES) {
        const st = e.stages?.[k];
        if (!st) continue;
        totalAttempts[k] += st.attempt_count ?? 1;
        if (st.status === 'failed') stageFailureCounts[k] += 1;
      }
      allRuns.push(...(e.runs ?? []));
    }
    const routerStatuses = list.map((e) => e.stages?.router?.status ?? null).filter((s) => s != null);
    samples.push({
      experimentPainId: sid,
      primaryRep: primary.rep,
      records: list.map((e) => e.file),
      reps: list.map((e) => ({ rep: e.rep, status: e.status, routerStatus: e.stages?.router?.status ?? null, candidates: e.candidates, file: e.file })),
      stages: primary.stages,
      candidates: primary.candidates,
      status: primary.status,
      totalAttempts,
      stageFailureCounts,
      allRuns,
      repSummary: {
        repRecords: list.length,
        repRouterSucceeded: routerStatuses.filter((s) => s === 'succeeded').length,
        routerStatusAgreement: routerStatuses.length >= 2 ? routerStatuses.every((s) => s === routerStatuses[0]) : null,
      },
    });
  }
  samples.sort((a, b) => (a.experimentPainId < b.experimentPainId ? -1 : a.experimentPainId > b.experimentPainId ? 1 : 0));
  return samples;
}

/** Layer-1 metrics over aggregated per-sample rows (see file header for semantics). */
export function layer1(samples) {
  const total = samples.length;
  const completedDiag = samples.filter((s) => s.stages?.router?.status === 'succeeded').length;
  const stageFailures = { rootcause: 0, distiller: 0, router: 0 };
  const attempts = { rootcause: 0, distiller: 0, router: 0 };
  const runOutcomes = { succeeded: 0, failed: 0, other: 0 };
  let latencyMs = 0;
  let latencyPairs = 0;
  let outputChars = 0;
  for (const s of samples) {
    for (const k of DIAG_STAGES) {
      stageFailures[k] += s.stageFailureCounts?.[k] ?? 0;
      attempts[k] += s.totalAttempts?.[k] ?? 0;
    }
    for (const run of s.allRuns ?? []) {
      if (run?.execution_status === 'succeeded') runOutcomes.succeeded += 1;
      else if (run?.execution_status === 'failed') runOutcomes.failed += 1;
      else runOutcomes.other += 1;
      const started = run?.started_at ? new Date(run.started_at).getTime() : NaN;
      const ended = run?.ended_at ? new Date(run.ended_at).getTime() : NaN;
      if (Number.isFinite(started) && Number.isFinite(ended) && run.execution_status === 'succeeded') {
        latencyMs += ended - started;
        latencyPairs += 1;
      }
      outputChars += run?.out_len ?? 0;
    }
  }
  const repSamples = samples.filter((s) => s.reps.length >= 2 && s.repSummary.routerStatusAgreement !== null);
  return {
    samples: total,
    pipelineCompletionRate: { numerator: completedDiag, denominator: total, value: total ? +(completedDiag / total).toFixed(3) : null },
    schemaPassRate: { numerator: runOutcomes.succeeded, denominator: runOutcomes.succeeded + runOutcomes.failed, value: (runOutcomes.succeeded + runOutcomes.failed) ? +(runOutcomes.succeeded / (runOutcomes.succeeded + runOutcomes.failed)).toFixed(3) : null },
    stageFailures,
    totalAttempts: attempts,
    runOutcomes,
    avgStageLatencySec: latencyPairs ? +(latencyMs / latencyPairs / 1000).toFixed(1) : null,
    totalOutputChars: outputChars,
    repSummary: {
      samplesWithRepeats: samples.filter((s) => s.reps.length > 1).length,
      repRecords: samples.reduce((n, s) => n + s.reps.length, 0),
      repRouterSucceeded: samples.reduce((n, s) => n + s.repSummary.repRouterSucceeded, 0),
      routerStatusAgreement: repSamples.length ? +(repSamples.filter((s) => s.repSummary.routerStatusAgreement === true).length / repSamples.length).toFixed(3) : null,
    },
  };
}

/**
 * Pairing over the real Pair primary key (experimentPainId, stage, rep, arm).
 * full-chain: record-level pairs (sample, rep) + stage-level pairs where BOTH
 * arms carry artifacts for that stage. Missing sides land in `missing`.
 */
export function buildFullChainPairing(entriesByArm, { arms = null } = {}) {
  const pair = arms ?? configArms(); // [baseline, candidate] — the ONLY role order
  const [base, cand] = pair;
  const index = {};
  const keys = new Set();
  for (const arm of pair) {
    index[arm] = new Map();
    for (const e of entriesByArm?.[arm] ?? []) {
      const k = `${e.experimentPainId ?? e.sid}|${e.rep}`;
      index[arm].set(k, e);
      keys.add(k);
    }
  }
  const recordPairs = [];
  const recordMissing = [];
  const byStage = Object.fromEntries(FULL_CHAIN_STAGES.map((s) => [s, { pairs: 0, missing: 0 }]));
  const stageMissing = [];
  for (const k of [...keys].sort()) {
    const [sid, repStr] = k.split('|');
    const rep = Number(repStr);
    const e1 = index[base].get(k);
    const e2 = index[cand].get(k);
    if (e1 && e2) recordPairs.push({ sid, rep });
    else recordMissing.push({ sid, stage: null, rep, missingArm: !e1 && !e2 ? 'both' : (!e1 ? base : cand), reason: 'record-missing' });
    for (const stage of FULL_CHAIN_STAGES) {
      const ok = Boolean(e1?.stagePresence?.[stage] && e2?.stagePresence?.[stage]);
      if (ok) byStage[stage].pairs += 1;
      else {
        byStage[stage].missing += 1;
        stageMissing.push({
          sid, stage, rep,
          missingArm: !e1 && !e2 ? 'both' : (!e1 ? base : !e2 ? cand : (!e1.stagePresence?.[stage] && !e2.stagePresence?.[stage] ? 'both' : (!e1.stagePresence?.[stage] ? base : cand))),
          reason: e1 && e2 ? 'stage-artifacts-missing' : 'record-missing',
        });
      }
    }
  }
  return { recordPairs: recordPairs.length, recordMissing, byStage, missing: stageMissing, missingCount: stageMissing.length, arms: { baseline: base, candidate: cand } };
}

/** Per-agent pairing keyed by (experimentPainId, stage, rep, arm). */
export function buildPerAgentPairing(entriesByArm, { arms = null } = {}) {
  const pair = arms ?? configArms(); // [baseline, candidate]
  const [base, cand] = pair;
  const index = {};
  const keys = new Set();
  const recordsPerArm = {};
  for (const arm of pair) {
    index[arm] = new Map();
    recordsPerArm[arm] = 0;
    for (const e of entriesByArm?.[arm] ?? []) {
      const k = `${e.sid}|${e.stage}|${e.rep}`;
      index[arm].set(k, e);
      keys.add(k);
      recordsPerArm[arm] += 1;
    }
  }
  const byStage = {};
  const missing = [];
  let pairs = 0;
  for (const k of [...keys].sort()) {
    const [sid, stage, repStr] = k.split('|');
    const rep = Number(repStr);
    const e1 = index[base].get(k);
    const e2 = index[cand].get(k);
    if (!byStage[stage]) byStage[stage] = { pairs: 0, missing: 0, emptyArtifactsPairs: 0 };
    if (e1 && e2) {
      pairs += 1;
      byStage[stage].pairs += 1;
      if (!e1.artifactCount || !e2.artifactCount) byStage[stage].emptyArtifactsPairs += 1;
    } else {
      byStage[stage].missing += 1;
      missing.push({ sid, stage, rep, missingArm: !e1 && !e2 ? 'both' : (!e1 ? base : cand), reason: 'record-missing' });
    }
  }
  return { pairs, byStage, missing, missingCount: missing.length, recordsPerArm, arms: { baseline: base, candidate: cand } };
}

function readFormationTasks(experimentRoot, arm) {
  const dbPath = armDbPath(arm, experimentRoot);
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try { db = new Database(dbPath, { readonly: true }); } catch { return null; }
  try {
    const rows = db.prepare("SELECT task_kind, status, attempt_count FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status != 'missing'").all();
    const byKind = {};
    for (const r of rows) byKind[r.task_kind] = (byKind[r.task_kind] ?? 0) + 1;
    return { total: rows.length, byKind };
  } catch { return null; } finally { db.close(); }
}

/** Full metrics computation for one run (fs-backed; injectable experimentRoot for tests). */
export function computeMetrics({ runId, experimentRoot: rootOverride = null, experiment = 'both', arms = null }) {
  const root = rootOverride ?? experimentRootFn();
  const pair = arms ?? configArms(); // [baseline, candidate]
  const dir = path.join(root, 'runs', runId);
  const out = { runId, generatedAt: new Date().toISOString(), arms: { baseline: pair[0], candidate: pair[1] }, full: {}, perAgent: {}, pairs: {}, invalidFiles: {} };

  if (experiment === 'full' || experiment === 'both') {
    const fullByArm = {};
    for (const arm of pair) {
      const collected = collectArm(arm, path.join(dir, 'records'), { experimentRoot: root, arms: pair });
      fullByArm[arm] = collected.entries;
      out.invalidFiles[arm] = collected.invalidFiles;
      const samples = aggregateBySample(collected.entries);
      out.full[arm] = layer1(samples);
      out.full[arm].filesMatched = collected.filesMatched;
      out.full[arm].invalidFileCount = collected.invalidFiles.length;
      out.full[arm].formationTasks = readFormationTasks(root, arm);
      out.full[arm].perSample = samples.map((s) => ({
        id: s.experimentPainId,
        rep: s.primaryRep,
        rc: s.stages?.rootcause?.status ?? null,
        di: s.stages?.distiller?.status ?? null,
        ro: s.stages?.router?.status ?? null,
        cands: s.candidates,
        recordStatus: s.status,
        reps: s.reps.map((r) => ({ rep: r.rep, ro: r.routerStatus, status: r.status })),
        records: s.records,
      }));
    }
    out.pairs.fullChain = buildFullChainPairing(fullByArm, { arms: pair });
  }

  if (experiment === 'per-agent' || experiment === 'both') {
    const paByArm = {};
    for (const arm of pair) {
      const collected = collectPerAgentArm(arm, path.join(dir, 'records-pa'), { arms: pair });
      paByArm[arm] = collected.entries;
      out.invalidFiles[`${arm}:per-agent`] = collected.invalidFiles;
    }
    out.pairs.perAgent = buildPerAgentPairing(paByArm, { arms: pair });
    out.perAgent.recordsPerArm = out.pairs.perAgent.recordsPerArm;
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI entry (guarded so tests can import the functions above)
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
  const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  bootstrapConfigContext(argv, 'usage: node ab-metrics.mjs --config <experiment-config.json> --run-id <id> [--experiment full|per-agent|both]');
  const runId = getOpt('--run-id', null);
  const experiment = getOpt('--experiment', 'both');
  if (!runId) throw new Error('--run-id required');
  if (!['full', 'per-agent', 'both'].includes(experiment)) {
    throw new Error(`unsupported --experiment value '${experiment}' (expected full|per-agent|both)`);
  }
  const dir = validateRunId(runId); // runId fence: the validated runs/<id> path IS the run dir
  // PRI-1254 r2 (review P2-07): the run's own manifests must prove the SAME
  // config/arms/dataset identity as the CURRENT config before any metric is
  // generated from its records.
  assertRunManifestIdentity(currentConfig(), runId);
  const out = computeMetrics({ runId, experiment });
  fs.writeFileSync(path.join(dir, 'layer1-metrics.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  const slim = (armOut) => {
    if (!armOut || Object.keys(armOut).length === 0) return armOut;
    const { perSample, ...rest } = armOut;
    return rest;
  };
  console.log(JSON.stringify({
    roles: { baseline: out.arms.baseline, candidate: out.arms.candidate },
    full: { [out.arms.baseline]: slim(out.full[out.arms.baseline]), [out.arms.candidate]: slim(out.full[out.arms.candidate]) },
    pairs: out.pairs,
    invalidFiles: Object.fromEntries(Object.entries(out.invalidFiles).map(([k, v]) => [k, v.length])),
  }, null, 1));
  console.log('->', path.join(dir, 'layer1-metrics.json'));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
