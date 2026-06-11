/**
 * spike2-load-real-pains.cjs — Load real pain signals from production DB
 *
 * THROWAWAY script for Spike-2 (PRI-366).
 * Opens state.db READ-ONLY, extracts real diagnostician tasks,
 * builds SpikeFixture objects, and reads Arm 1 (production monolith) baselines.
 *
 * Usage: node docs/plans/2026-06-diagnostician-split/spike2-load-real-pains.cjs
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.STATE_DB_PATH || 'D:/.openclaw/workspace/.pd/state.db';
const OUTPUT_DIR = path.join(__dirname, 'spike-fixtures-real');

// ── §2.5 Real pain signal task IDs ──────────────────────────────────────

const REAL_PAIN_IDS = {
  R1: 'manual_1780787633659_8im5rx7t',
  R2: 'manual_1780799247483_e198d6c5',
  R3: 'pain_1780901574214_ee9bf61c',
  R5: 'manual_1780931134915_tiuyvu0g',
  R6: 'manual_1781081305247_1ljln5z9',
  R7: 'manual_1781081347155_07o22nkt',
  R8: 'empathy_gfi_1780909080715',  // optional
};

const REAL_AXIOM_MAP = {
  R1: 'T-03',  // T-03/T-05
  R2: 'T-08',  // T-08/process
  R3: 'T-03',  // T-03/tooling
  R5: 'T-02',  // T-02/design
  R6: 'T-01',  // T-01/T-03
  R7: 'T-03',  // T-03/honesty
  R8: undefined,  // tests defer behavior
};

const REAL_DESCRIPTIONS = {
  R1: 'PR#838 tests green but missed production-path side effects / unreachable high-confidence upgrade',
  R2: 'OpenClaw missed a valid review comment (recurring ERR-002)',
  R3: 'tool edit failed on pain-evidence.test.ts',
  R5: 'PR#852 CLI routing: pain retry dropped options, canary wrong handler, evidence wrong log path',
  R6: 'PRI-363 refactor behavior regression (stage enum change broke tests)',
  R7: 'PRI-363 acceptance report inaccuracy (8 failures reported as passing)',
  R8: 'GFI crossed threshold, matched "wrong"',
};

// ── Synthetic fixtures to copy (T-04/T-06/T-07/T-09/T-10 only) ─────────

const SYNTHETIC_FIXTURE_NAMES = [
  'irreversible-change',    // T-04
  'over-engineering',       // T-06
  'blast-radius-too-large', // T-07
  'no-task-division',       // T-09
  'no-memory-externalization', // T-10
];

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Open DB READ-ONLY
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL'); // safe for readonly

  console.log('Opened state.db READ-ONLY');

  const results = { real: [], synthetic: [] };

  // ── Process real pain signals ───────────────────────────────────────

  for (const [code, painId] of Object.entries(REAL_PAIN_IDS)) {
    console.log(`\nProcessing ${code}: ${painId}`);

    // Find the diagnostician task for this painId
    // The painId may be in input_ref or embedded in diagnostic_json
    const task = findTask(db, painId);
    if (!task) {
      console.warn(`  ⚠ No task found for ${code}/${painId}, skipping`);
      continue;
    }

    console.log(`  Found task: ${task.task_id} (status=${task.status})`);

    // Parse diagnostic_json for pain data
    let diagJson = null;
    try {
      diagJson = JSON.parse(task.diagnostic_json || '{}');
    } catch {
      console.warn(`  ⚠ Failed to parse diagnostic_json for ${code}`);
      continue;
    }

    // Find the latest successful run's output_payload for Arm 1 baseline
    const arm1Baseline = findArm1Baseline(db, task.task_id);

    // Build fixture object matching SpikeFixture shape
    const fixture = {
      name: code.toLowerCase(),
      description: REAL_DESCRIPTIONS[code],
      expectedAxiomViolation: REAL_AXIOM_MAP[code],
      source: 'real',
      realCode: code,
      payload: buildPayload(code, painId, diagJson),
      arm1Baseline: arm1Baseline, // production monolith's principle output
    };

    results.real.push(fixture);

    // Write individual fixture file
    const filePath = path.join(OUTPUT_DIR, `${code.toLowerCase()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));
    console.log(`  Written to ${filePath}`);
    if (arm1Baseline) {
      console.log(`  Arm1 baseline: "${arm1Baseline.abstractedPrinciple?.slice(0, 80)}..."`);
    }
  }

  // ── Copy synthetic fixtures ─────────────────────────────────────────

  const syntheticSourceDir = path.join(__dirname, 'spike-fixtures');
  for (const name of SYNTHETIC_FIXTURE_NAMES) {
    const srcPath = path.join(syntheticSourceDir, `${name}.json`);
    if (fs.existsSync(srcPath)) {
      const data = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
      data.source = 'synthetic';
      data.arm1Baseline = null; // will be re-run by spike2-run.ts
      results.synthetic.push(data);
      const destPath = path.join(OUTPUT_DIR, `synthetic-${name}.json`);
      fs.writeFileSync(destPath, JSON.stringify(data, null, 2));
      console.log(`Copied synthetic fixture: ${name}`);
    } else {
      console.warn(`⚠ Synthetic fixture not found: ${srcPath}`);
    }
  }

  db.close();

  // Write manifest
  const manifestPath = path.join(OUTPUT_DIR, 'manifest.json');
  const manifest = {
    generatedAt: new Date().toISOString(),
    realCount: results.real.length,
    syntheticCount: results.synthetic.length,
    real: results.real.map(r => ({ code: r.realCode, name: r.name, hasArm1: !!r.arm1Baseline })),
    synthetic: results.synthetic.map(s => ({ name: s.name, expectedAxiom: s.expectedAxiomViolation })),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n=== Done ===`);
  console.log(`Real fixtures: ${results.real.length}`);
  console.log(`Synthetic fixtures: ${results.synthetic.length}`);
  console.log(`Manifest: ${manifestPath}`);
}

function findTask(db, painId) {
  // Try exact match on input_ref first
  let task = db.prepare(
    "SELECT * FROM tasks WHERE task_kind = 'diagnostician' AND input_ref = ? ORDER BY created_at DESC LIMIT 1"
  ).get(painId);

  if (task) return task;

  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE task_kind = 'diagnostician' AND diagnostic_json LIKE ? ORDER BY created_at DESC"
  ).all(`%${painId}%`);

  if (tasks.length > 0) {
    const succeeded = tasks.find(t => t.status === 'succeeded');
    return succeeded || tasks[0];
  }

  task = db.prepare(
    "SELECT * FROM tasks WHERE task_kind = 'diagnostician' AND task_id LIKE ? ORDER BY created_at DESC LIMIT 1"
  ).get(`%${painId}%`);

  return task;
}

function findArm1Baseline(db, taskId) {
  // Find the latest successful run for this task
  const run = db.prepare(
    "SELECT * FROM runs WHERE task_id = ? AND execution_status = 'succeeded' ORDER BY ended_at DESC LIMIT 1"
  ).get(taskId);

  if (!run || !run.output_payload) return null;

  try {
    const output = JSON.parse(run.output_payload);

    // Extract kind:principle recommendations with abstractedPrinciple
    const recs = output.recommendations || output.candidates || [];
    const principles = recs.filter(r => r.kind === 'principle');

    if (principles.length === 0) return null;

    // Return the first principle's abstractedPrinciple
    return {
      abstractedPrinciple: principles[0].abstractedPrinciple || principles[0].description,
      kind: 'principle',
      groundedOn: principles[0].groundedOn || null,
      fullOutput: output,
    };
  } catch {
    return null;
  }
}

function buildPayload(code, painId, diagJson) {
  // Build a DiagnosticianContextPayload-compatible object from diagnostic_json
  const painData = diagJson.painData || diagJson;
  const reason = painData.reason || painData.reasonSummary || REAL_DESCRIPTIONS[code] || '';
  const evidence = painData.evidence || [];
  const source = painData.source || 'unknown';
  const severity = painData.severity || 'medium';

  // Build conversation window from evidence
  const conversationWindow = [];
  if (Array.isArray(evidence)) {
    for (const ev of evidence.slice(0, 5)) {
      conversationWindow.push({
        ts: ev.ts || new Date().toISOString(),
        role: 'user',
        text: ev.note || ev.text || (typeof ev === 'string' ? ev : JSON.stringify(ev)),
        sourceRef: ev.sourceRef,
      });
    }
  }

  return {
    contextId: `ctx-spike2-${code.toLowerCase()}`,
    contextHash: `hash-spike2-${code.toLowerCase()}`,
    taskId: `task-spike2-${code.toLowerCase()}`,
    workspaceDir: 'D:/.openclaw/workspace',
    sourceRefs: [`pain://${painId}`],
    diagnosisTarget: {
      painId,
      reasonSummary: reason,
      severity,
      source,
      evidence: Array.isArray(evidence) ? evidence.slice(0, 5).map(e => ({
        sourceRef: e.sourceRef || `pain://${painId}`,
        note: e.note || e.text || (typeof e === 'string' ? e : ''),
      })) : [],
    },
    conversationWindow,
  };
}

main();
