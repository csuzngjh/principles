/**
 * PD-SPEC-001 Phase 5 — blind evaluation packager (SPEC §7).
 *
 * Builds anonymized evaluation packages from A/B run records:
 *  - per-stage pairs (rootcause/distiller/router/dreamer/philosopher/scribe)
 *    for the full-chain run AND the per-agent run where present, keyed by
 *    (experimentPainId, stage, rep, source) — repeat rounds (`.repN.json`)
 *    are packaged per rep, never collapsed into rep 0;
 *  - ALL succeeded artifacts of a stage are collected (not just the last one)
 *    and annotated per attempt; dreamer candidate-set completeness is asserted
 *    from the candidates array length INSIDE each dreamer artifact;
 *  - the evaluator sees: original pain, FULL evidence note text (from the
 *    full-fidelity dataset — local blind pack only, never a committed file),
 *    owner correction (when present), and the two outputs labelled
 *    Output-A / Output-B in randomized order. It NEVER sees arm identity,
 *    prompt text, pipeline contract versions or trusted-context receipts.
 * The blind map (package → arm) is stored separately (blindmap.json).
 *
 * Blinding hardening: after the pack is assembled, a recursive self-check
 * scans every key and string value for group-revealing material (arm tokens,
 * prompt-version tokens, receipt/contract-version keys, arm worktree paths).
 * Fields the packager owns are scrubbed at build time; anything that survives
 * the scan fails the build BEFORE any file is written.
 *
 * Usage: node ab-blindpack.mjs --run-id <gridRunId> [--pa-run-id <perAgentRunId>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EXPERIMENT_ROOT, DATASET_FILE, loadDataset } from './ab-lib.mjs';

export const FULL_CHAIN_STAGES = ['rootcause', 'distiller', 'router', 'dreamer', 'philosopher', 'scribe'];
export const PER_AGENT_STAGES = ['distiller', 'router', 'dreamer', 'philosopher', 'scribe'];

/**
 * Canonical A/B record filename grammar (shared with ab-metrics.mjs):
 *   <sampleId>.<arm>.json            → rep 0
 *   <sampleId>.<arm>.rep<N>.json     → rep N (repeat rounds)
 * Per-agent stage records insert the stage segment:
 *   <sampleId>.<stage>.<arm>[.rep<N>].json
 */
export const RECORD_FILE_RE = /^([^.]+)\.(v1|v2)(?:\.rep(\d+))?\.json$/;
export const PER_AGENT_FILE_RE = /^([^.]+)\.(distiller|router|dreamer|philosopher|scribe)\.(v1|v2)(?:\.rep(\d+))?\.json$/;

export function parseRecordFileName(name) {
  const m = RECORD_FILE_RE.exec(name);
  if (!m) return null;
  return { sid: m[1], arm: m[2], rep: m[3] === undefined ? 0 : Number(m[3]) };
}

export function parsePerAgentFileName(name) {
  const m = PER_AGENT_FILE_RE.exec(name);
  if (!m) return null;
  return { sid: m[1], stage: m[2], arm: m[3], rep: m[4] === undefined ? 0 : Number(m[4]) };
}

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Deterministic A/B flip PRNG (same LCG as before), injectable for tests.
 */
export function makePrng(seed) {
  let h = parseInt(sha256Hex(String(seed)).slice(0, 12), 16);
  if (!Number.isFinite(h)) h = 12345;
  return () => { h = (h * 1103515245 + 12345) % 2147483648; return h / 2147483648; };
}

// ---------------------------------------------------------------------------
// Blinding hardening
// ---------------------------------------------------------------------------

/**
 * JSON keys that must never appear inside a blind package: they either carry
 * arm identity directly or carry run/pipeline metadata from which the group
 * can be inferred (trusted-context receipts, contract/prompt versions).
 */
const LEAKY_KEY_RE = /(receipt|pipelinecontractversion|contractversion|promptversion|promptv[12]|^arm$|^arm(id|name|label|token)$|^variant$)/i;

/**
 * String-value patterns that function as arm semantics. Bare "v1"/"v2" words
 * inside long domain content (e.g. a pain report about a product's "v1
 * release") are NOT flagged: they are the judged subject matter, identical
 * reasoning applies to production schema identifiers (`diagnostician-
 * output-v2`), which the baseline proves byte-identical across arms
 * (baseline/PROMPT_SCHEMA_BASELINE.md §9). What IS flagged: values that ARE
 * an arm token, prompt-version tokens, arm/path references, and receipt or
 * contract-version material embedded in values.
 */
const LEAKY_VALUE_RES = [
  [/^v[12]$/i, 'arm-identity value'],
  [/prompt[\s._-]?v[12]\b/i, 'prompt-version token'],
  [/\barm\b\s*[=:]\s*['"]?v[12]\b/i, 'arm assignment'],
  [/_worktrees/i, 'arm worktree path'],
  [/v1arm/i, 'arm worktree path'],
  [/adhoc-\d{8}/i, 'arm worktree path'],
  [/pipelineContractVersion/i, 'pipeline contract version'],
  [/trustedContextReceipt/i, 'trusted context receipt'],
];

/**
 * Recursively REMOVE leaky keys from a parsed artifact/metadata value.
 * Returns `{ value, removed }` where `removed` counts removals (the removed
 * key NAMES stay out of the package on purpose — they are leak material).
 */
export function scrubLeakyFields(value) {
  let removed = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, child] of Object.entries(v)) {
        if (typeof k === 'string' && LEAKY_KEY_RE.test(k)) { removed += 1; continue; }
        out[k] = walk(child);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), removed };
}

/** Scan a value recursively for group-revealing keys/values. */
export function findBlindViolations(value, basePath = '$') {
  const violations = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (LEAKY_KEY_RE.test(k)) violations.push({ path: `${p}.${k}`, reason: 'leaky key' });
        walk(child, `${p}.${k}`);
      }
      return;
    }
    if (typeof v === 'string') {
      for (const [re, reason] of LEAKY_VALUE_RES) {
        if (re.test(v)) { violations.push({ path: p, token: re.source, reason }); return; }
      }
    }
  };
  walk(value, basePath);
  return violations;
}

const REDACTED_MARKER_RE = /«redacted sha256:/;

/** Full-fidelity guard (rc-3 fail loud): refuse a redacted dataset copy. */
export function assertFullFidelityDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.samples) || dataset.samples.length === 0) {
    throw new Error(`dataset at ${DATASET_FILE} has no samples — regenerate the full-fidelity copy (scripts/freeze-dataset.mjs)`);
  }
  const checked = [];
  const grab = (sid, field, v) => { if (typeof v === 'string') checked.push([sid, field, v]); };
  for (const s of dataset.samples) {
    const sid = s?.experimentPainId ?? '?';
    grab(sid, 'painEvent.text', s?.painEvent?.text);
    grab(sid, 'painEvent.reason', s?.painEvent?.reason);
    grab(sid, 'correctionEvidence.text', s?.diagnosisTarget?.correctionEvidence?.text);
    for (const e of Array.isArray(s?.diagnosisTarget?.evidence) ? s.diagnosisTarget.evidence : []) {
      grab(sid, 'evidence.note', e?.note);
    }
  }
  const hits = checked.filter(([, , v]) => REDACTED_MARKER_RE.test(v));
  if (hits.length) {
    throw new Error(`dataset resolved to a REDACTED copy (${hits.length} redacted fields, e.g. ${hits[0][0]}.${hits[0][1]}) — blind packs need the full-fidelity dataset from .tmp/prompt-v2-inventory/pain-dataset.full.json`);
  }
}

/**
 * Sample metadata for one package entry. Evidence notes are copied in FULL
 * (no truncation) from the full-fidelity dataset — the pack lives under
 * `.tmp/prompt-v2-ab/` (gitignored) and is never committed (git-15/16).
 */
export function buildSampleMeta(s) {
  if (!s || typeof s !== 'object') return null;
  const sid = s.experimentPainId;
  const evidence = (Array.isArray(s.diagnosisTarget?.evidence) ? s.diagnosisTarget.evidence : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      kind: typeof e.kind === 'string' ? e.kind : null,
      sourceRef: typeof e.sourceRef === 'string' ? e.sourceRef : null,
      note: typeof e.note === 'string' ? e.note : null,
    }));
  const meta = {
    experimentPainId: typeof sid === 'string' ? sid : null,
    painSource: s.painEvent?.source ?? null,
    severity: s.painEvent?.severity ?? null,
    reason: s.painEvent?.reason ?? null,
    painTextHead: typeof s.painEvent?.text === 'string' ? s.painEvent.text.slice(0, 1200) : null,
    ownerCorrection: s.hasCorrectionEvidence === true
      ? (typeof s.diagnosisTarget?.correctionEvidence?.text === 'string' ? s.diagnosisTarget.correctionEvidence.text : null)
      : null,
    evidence,
    evidenceRefs: Array.isArray(s.evidenceRefs) ? s.evidenceRefs : null,
    inclusionReason: s.inclusionReason ?? null,
  };
  const violations = findBlindViolations(meta, `sample[${meta.experimentPainId ?? '?'}]`);
  if (violations.length) throw new Error(`sample metadata for ${meta.experimentPainId} would leak group material: ${JSON.stringify(violations)}`);
  return meta;
}

// ---------------------------------------------------------------------------
// Per-stage artifact collection (ALL succeeded artifacts, annotated)
// ---------------------------------------------------------------------------

const DIAG_PREFIX = { rootcause: 'diag_rootcause-', distiller: 'diag_distiller-', router: 'diag_router-' };
const FORMATION_STAGES = new Set(['dreamer', 'philosopher', 'scribe']);

function stagePrefix(stage) {
  return DIAG_PREFIX[stage] ?? `${stage}-`;
}

function parseArtifactContent(contentJson) {
  if (typeof contentJson !== 'string') return { parsed: null, raw: contentJson == null ? null : String(contentJson) };
  try { return { parsed: JSON.parse(contentJson), raw: contentJson }; } catch { return { parsed: null, raw: contentJson }; }
}

/**
 * Collect EVERY succeeded artifact of `stage` from one run record.
 * - artifacts in a record are committed only after a successful run; when the
 *   record carries run rows for the artifact's source task, a source task
 *   whose runs all failed is excluded;
 * - content is leak-scrubbed (scrubLeakyFields) and kept as a string;
 * - dreamer completeness is asserted from the candidates array length INSIDE
 *   each artifact (rc-3/rc-9: failures are reported, never silently dropped).
 */
export function collectStageArtifacts(rec, stage) {
  const bucket = FORMATION_STAGES.has(stage)
    ? (rec?.artifacts?.formationArtifacts ?? [])
    : (rec?.artifacts?.stageArtifacts ?? []);
  const prefix = stagePrefix(stage);

  const runsByTask = new Map();
  for (const r of Array.isArray(rec?.artifacts?.runs) ? rec.artifacts.runs : []) {
    if (!r || typeof r.task_id !== 'string') continue;
    if (!runsByTask.has(r.task_id)) runsByTask.set(r.task_id, []);
    runsByTask.get(r.task_id).push(r);
  }
  const hasSucceededRun = (src) => {
    const rows = runsByTask.get(src);
    return !rows || rows.some((r) => r?.execution_status === 'succeeded');
  };

  const attempts = [];
  const reasons = [];
  let scrubbedKeyCount = 0;
  let index = 0;
  for (const a of Array.isArray(bucket) ? bucket : []) {
    if (!a || typeof a.source_task_id !== 'string' || !a.source_task_id.startsWith(prefix)) continue;
    if (!hasSucceededRun(a.source_task_id)) { reasons.push(`artifact[${index}] skipped: no succeeded run for ${a.source_task_id}`); index += 1; continue; }
    const { parsed, raw } = parseArtifactContent(a.content_json);
    const scrub = scrubLeakyFields(parsed ?? raw);
    scrubbedKeyCount += scrub.removed;
    const content = typeof scrub.value === 'string' ? scrub.value : JSON.stringify(scrub.value);
    const violations = findBlindViolations(content, `artifact[${index}]`);
    if (violations.length) {
      reasons.push(`artifact[${index}] excluded: leak tokens survived scrub (${violations.map((v) => v.reason).join(', ')})`);
      index += 1;
      continue;
    }
    let candidateCount = null;
    if (stage === 'dreamer' && scrub.value && typeof scrub.value === 'object' && Array.isArray(scrub.value.candidates)) {
      candidateCount = scrub.value.candidates.length;
      if (candidateCount < 1) reasons.push(`dreamer artifact[${index}] candidates array is empty — candidate set incomplete`);
    } else if (stage === 'dreamer') {
      reasons.push(`dreamer artifact[${index}] has no parseable candidates array — candidate set completeness unprovable`);
    }
    attempts.push({
      index: attempts.length,
      artifactId: typeof a.artifact_id === 'string' ? a.artifact_id : null,
      sourceTaskId: a.source_task_id,
      candidateCount,
      content,
    });
    index += 1;
  }

  let complete = attempts.length > 0;
  if (stage === 'dreamer') complete = complete && attempts.every((a) => typeof a.candidateCount === 'number' && a.candidateCount >= 1);
  const candidateTotal = attempts.reduce((n, a) => n + (typeof a.candidateCount === 'number' ? a.candidateCount : 0), 0);
  return { attempts, complete, reasons, scrubbedKeyCount, candidateTotal };
}

/** Primary output string: single artifact → its content; several → annotated collection. */
function primaryOutput(stage, collection) {
  if (collection.attempts.length === 1) return collection.attempts[0].content;
  return JSON.stringify({
    stage,
    artifactCount: collection.attempts.length,
    candidateTotal: collection.candidateTotal || undefined,
    artifacts: collection.attempts.map((a) => ({ index: a.index, artifactId: a.artifactId, candidateCount: a.candidateCount, content: a.content })),
  });
}

// ---------------------------------------------------------------------------
// Pack assembly
// ---------------------------------------------------------------------------

export function readRecordsDir(recordsDir, parse) {
  const out = [];
  if (!recordsDir || !fs.existsSync(recordsDir)) return out;
  for (const f of fs.readdirSync(recordsDir)) {
    const parsed = parse(f);
    if (!parsed) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8')); } catch (e) {
      out.push({ fileName: f, ...parsed, rec: null, error: String(e?.message ?? e) });
      continue;
    }
    out.push({ fileName: f, ...parsed, rec, error: null });
  }
  return out;
}

/** Normalize a per-agent result record into the full-chain artifact shape. */
function normalizePerAgentRecord(rec) {
  const arts = Array.isArray(rec?.result?.artifacts) ? rec.result.artifacts : [];
  const runs = Array.isArray(rec?.result?.runs) ? rec.result.runs : [];
  return { artifacts: { stageArtifacts: arts, formationArtifacts: arts, runs } };
}

/**
 * Build the blind pack from in-memory inputs (pure — fs access lives in
 * readRecordsDir/main so tests can drive this with synthetic records).
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string|null} args.paRunId
 * @param {object} args.dataset  full-fidelity frozen dataset ({samples:[...]})
 * @param {Array<{fileName,sid,arm,rep,rec,error}>} args.fullRecords
 * @param {Array<{fileName,sid,stage,arm,rep,rec,error}>} args.paRecords
 * @param {(a:string,b:string)=>number} [args.compare] stable iteration order
 */
export function buildBlindPack({ runId, paRunId = null, dataset, fullRecords = [], paRecords = [], compare }) {
  assertFullFidelityDataset(dataset);
  const byPain = new Map((dataset.samples ?? []).map((s) => [s.experimentPainId, s]));
  const rand = makePrng(runId);
  const cmp = compare ?? ((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const packages = [];
  const blindMap = {};
  const missing = [];           // neutral (no arm names) — ships in packages.json
  const missingArmAware = [];   // operator-side detail — ships in blindmap.json
  const warnings = [];

  const addPair = (stage, source, sid, rep, colA, colB) => {
    const meta = buildSampleMeta(byPain.get(sid));
    if (!meta) { warnings.push(`no dataset sample for ${sid} — pair skipped (${stage}/${source}/rep${rep})`); return; }
    const outV1 = colA.primary;
    const outV2 = colB.primary;
    const flip = rand() < 0.5;
    const pkgId = sha256Hex(JSON.stringify({ stage, sid, rep, source, outV1: sha256Hex(outV1), outV2: sha256Hex(outV2) })).slice(0, 16);
    packages.push({
      evalId: pkgId,
      stage,
      source, // full-chain | per-agent
      sid,
      rep,
      sample: meta,
      outputA: flip ? outV2 : outV1,
      outputB: flip ? outV1 : outV2,
      attemptsA: flip ? colB.attempts : colA.attempts,
      attemptsB: flip ? colA.attempts : colB.attempts,
      completeness: {
        A: flip ? colB.summary : colA.summary,
        B: flip ? colA.summary : colB.summary,
      },
    });
    blindMap[pkgId] = { armA: flip ? 'v2' : 'v1', armB: flip ? 'v1' : 'v2', stage, sid, rep, source };
  };

  // --- full-chain pairs, keyed by (sid, stage, rep) ---
  const fullIndex = new Map(); // `${sid}|${arm}|${rep}` -> entry
  const fullKeys = new Set();  // `${sid}|${rep}`
  for (const e of fullRecords) {
    if (e.error || !e.rec) {
      missing.push({ source: 'full-chain', sid: e.sid, stage: null, rep: e.rep, reason: 'record-unreadable' });
      missingArmAware.push({ source: 'full-chain', sid: e.sid, stage: null, rep: e.rep, missingArm: e.arm, reason: 'record-unreadable' });
      warnings.push(`full-chain record ${e.fileName} unreadable: ${e.error}`);
      continue;
    }
    if (typeof e.rec.rep === 'number' && e.rec.rep !== e.rep) {
      warnings.push(`${e.fileName}: filename rep ${e.rep} != record rep ${e.rec.rep} (filename authoritative)`);
    }
    const k = `${e.sid}|${e.arm}|${e.rep}`;
    if (fullIndex.has(k)) warnings.push(`duplicate full-chain record for ${k} (${e.fileName}) — keeping first`);
    else fullIndex.set(k, e);
    fullKeys.add(`${e.sid}|${e.rep}`);
  }
  const sortedFullKeys = [...fullKeys].sort(cmp);
  for (const key of sortedFullKeys) {
    const [sid, repStr] = key.split('|');
    const rep = Number(repStr);
    const e1 = fullIndex.get(`${sid}|v1|${rep}`);
    const e2 = fullIndex.get(`${sid}|v2|${rep}`);
    for (const stage of FULL_CHAIN_STAGES) {
      if (!e1 || !e2) {
        const missingArm = !e1 && !e2 ? 'both' : (!e1 ? 'v1' : 'v2');
        missing.push({ source: 'full-chain', sid, stage, rep, reason: e1 || e2 ? 'record-missing' : 'record-missing-both' });
        missingArmAware.push({ source: 'full-chain', sid, stage, rep, missingArm, reason: e1 || e2 ? 'record-missing' : 'record-missing-both' });
        continue;
      }
      const c1 = collectStageArtifacts(e1.rec, stage);
      const c2 = collectStageArtifacts(e2.rec, stage);
      if (!c1.attempts.length || !c2.attempts.length) {
        const missingArm = !c1.attempts.length && !c2.attempts.length ? 'both' : (!c1.attempts.length ? 'v1' : 'v2');
        missing.push({ source: 'full-chain', sid, stage, rep, reason: 'stage-artifacts-missing' });
        missingArmAware.push({ source: 'full-chain', sid, stage, rep, missingArm, reason: 'stage-artifacts-missing' });
        continue;
      }
      const mk = (c) => ({
        attempts: c.attempts,
        scrubbedKeyCount: c.scrubbedKeyCount,
        summary: { artifactCount: c.attempts.length, candidateCount: c.candidateTotal, complete: c.complete, reasons: c.reasons },
        primary: primaryOutput(stage, c),
      });
      addPair(stage, 'full-chain', sid, rep, mk(c1), mk(c2));
    }
  }

  // --- per-agent pairs, keyed by (sid, stage, rep) ---
  const paIndex = new Map(); // `${sid}|${stage}|${arm}|${rep}` -> entry
  const paKeys = new Set();  // `${sid}|${stage}|${rep}`
  for (const e of paRecords) {
    if (e.error || !e.rec) {
      missing.push({ source: 'per-agent', sid: e.sid, stage: e.stage, rep: e.rep, reason: 'record-unreadable' });
      missingArmAware.push({ source: 'per-agent', sid: e.sid, stage: e.stage, rep: e.rep, missingArm: e.arm, reason: 'record-unreadable' });
      warnings.push(`per-agent record ${e.fileName} unreadable: ${e.error}`);
      continue;
    }
    const k = `${e.sid}|${e.stage}|${e.arm}|${e.rep}`;
    if (paIndex.has(k)) warnings.push(`duplicate per-agent record for ${k} (${e.fileName}) — keeping first`);
    else paIndex.set(k, e);
    paKeys.add(`${e.sid}|${e.stage}|${e.rep}`);
  }
  for (const key of [...paKeys].sort(cmp)) {
    const [sid, stage, repStr] = key.split('|');
    const rep = Number(repStr);
    const e1 = paIndex.get(`${sid}|${stage}|v1|${rep}`);
    const e2 = paIndex.get(`${sid}|${stage}|v2|${rep}`);
    if (!e1 || !e2) {
      const missingArm = !e1 && !e2 ? 'both' : (!e1 ? 'v1' : 'v2');
      missing.push({ source: 'per-agent', sid, stage, rep, reason: 'record-missing' });
      missingArmAware.push({ source: 'per-agent', sid, stage, rep, missingArm, reason: e1 || e2 ? 'record-missing' : 'record-missing-both' });
      continue;
    }
    const c1 = collectStageArtifacts(normalizePerAgentRecord(e1.rec), stage);
    const c2 = collectStageArtifacts(normalizePerAgentRecord(e2.rec), stage);
    if (!c1.attempts.length || !c2.attempts.length) {
      const missingArm = !c1.attempts.length && !c2.attempts.length ? 'both' : (!c1.attempts.length ? 'v1' : 'v2');
      missing.push({ source: 'per-agent', sid, stage, rep, reason: 'stage-artifacts-missing' });
      missingArmAware.push({ source: 'per-agent', sid, stage, rep, missingArm, reason: 'stage-artifacts-missing' });
      continue;
    }
    const mk = (c) => ({
      attempts: c.attempts,
      scrubbedKeyCount: c.scrubbedKeyCount,
      summary: { artifactCount: c.attempts.length, candidateCount: c.candidateTotal, complete: c.complete, reasons: c.reasons },
      primary: primaryOutput(stage, c),
    });
    addPair(stage, 'per-agent', sid, rep, mk(c1), mk(c2));
  }

  const byStage = {};
  for (const p of packages) byStage[`${p.stage}/${p.source}`] = (byStage[`${p.stage}/${p.source}`] ?? 0) + 1;

  return {
    packages,
    blindMap,
    missing,
    missingArmAware,
    missingCount: missing.length,
    byStage,
    warnings,
  };
}

/**
 * Final gate + write. The self-check runs over the exact object that is
 * serialized; ANY violation aborts BEFORE either file is written. The blind
 * map is a separate file and is never merged into packages.json.
 */
export function writeBlindPackFiles(outDir, result, { runId, paRunId }) {
  const doc = {
    runId,
    paRunId,
    generatedAt: new Date().toISOString(),
    count: result.packages.length,
    byStage: result.byStage,
    missing: result.missing,
    missingCount: result.missingCount,
    packages: result.packages,
  };
  const violations = [
    ...findBlindViolations(doc, 'packages.json'),
    ...result.packages.flatMap((p, i) => findBlindViolations(p, `packages[${i}]`)),
  ];
  if (violations.length) {
    throw new Error(`blind pack FAILED blinding self-check — no files written:\n${violations.map((v) => `  ${v.path}: ${v.reason}${v.token ? ` (${v.token})` : ''}`).join('\n')}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'packages.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'blindmap.json'), JSON.stringify({
    runId,
    paRunId,
    generatedAt: doc.generatedAt,
    map: result.blindMap,
    missing: result.missingArmAware,
    warnings: result.warnings,
  }, null, 2) + '\n', 'utf8');
  return { packagesPath: path.join(outDir, 'packages.json'), blindMapPath: path.join(outDir, 'blindmap.json') };
}

// ---------------------------------------------------------------------------
// CLI entry (guarded so tests can import the functions above)
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
  const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const runId = getOpt('--run-id', null);
  const paRunId = getOpt('--pa-run-id', null);
  if (!runId) throw new Error('--run-id required');

  const dataset = loadDataset();
  const runDir = path.join(EXPERIMENT_ROOT, 'runs', runId);
  const fullRecords = readRecordsDir(path.join(runDir, 'records'), parseRecordFileName);
  const paRecords = paRunId
    ? readRecordsDir(path.join(EXPERIMENT_ROOT, 'runs', paRunId, 'records-pa'), parsePerAgentFileName)
    : [];

  const result = buildBlindPack({ runId, paRunId, dataset, fullRecords, paRecords });
  const written = writeBlindPackFiles(path.join(runDir, 'blindpack'), result, { runId, paRunId });
  console.log(`packages=${result.packages.length} missing=${result.missingCount} -> ${path.relative(process.cwd(), written.packagesPath)}`);
  if (result.warnings.length) console.log(`warnings (${result.warnings.length}):\n  ${result.warnings.join('\n  ')}`);
  console.log(JSON.stringify(result.byStage));
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
