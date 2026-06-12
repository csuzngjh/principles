/**
 * extract-real-pains.cjs — READ-ONLY extraction of real pain signals from state.db
 * Outputs JSON fixture files for spike/split-e2e-fixtures/
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = 'D:/.openclaw/workspace/.pd/state.db';
const OUTPUT_DIR = path.join('D:', 'Code', 'principles', 'spike', 'split-e2e-fixtures');

const PAIN_IDS = {
  R1: 'manual_1780787633659',
  R2: 'manual_1780799247483',
  R3: 'pain_1780901574214',
  R5: 'manual_1780931134915',
  R6: 'manual_1781081305247',
  R7: 'manual_1781081347155',
};

const DESCRIPTIONS = {
  R1: 'PR#838 tests green but missed production-path side effects',
  R2: 'OpenClaw missed a valid review comment (recurring ERR-002)',
  R3: 'tool edit failed on pain-evidence.test.ts',
  R5: 'PR#852 CLI routing: pain retry dropped options, canary wrong handler, evidence wrong log path',
  R6: 'PRI-363 refactor behavior regression (stage enum change broke tests)',
  R7: 'PRI-363 acceptance report inaccuracy (8 failures reported as passing)',
};

const AXIOM_MAP = {
  R1: ['T-03', 'T-05'],
  R2: ['T-08'],
  R3: ['T-03'],
  R5: ['T-02'],
  R6: ['T-01', 'T-03'],
  R7: ['T-03'],
};

const SOURCE_MAP = {
  R1: 'code_review',
  R2: 'code_review',
  R3: 'tool_failure',
  R5: 'code_review',
  R6: 'refactor_regression',
  R7: 'report_inaccuracy',
};

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH, { readonly: true });
  console.log('Opened state.db READ-ONLY');

  // Step 1: List all tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('\n=== TABLES ===');
  for (const t of tables) {
    console.log(' ', t.name);
  }

  // Step 2: Show schema for key tables
  const keyTables = tables.map(t => t.name);
  for (const tableName of keyTables) {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
    if (schema && schema.sql) {
      console.log(`\n--- Schema: ${tableName} ---`);
      console.log(schema.sql);
    }
  }

  // Step 3: Extract pain signals
  for (const [code, painId] of Object.entries(PAIN_IDS)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing ${code}: ${painId}`);
    console.log('='.repeat(60));

    // Find task(s) related to this painId
    // Try multiple search strategies
    let tasks = [];

    // Strategy 1: exact match on input_ref
    const byInputRef = db.prepare(
      "SELECT * FROM tasks WHERE input_ref = ?"
    ).all(painId);
    if (byInputRef.length > 0) {
      console.log(`  Found by input_ref exact match: ${byInputRef.length}`);
      tasks.push(...byInputRef);
    }

    // Strategy 2: LIKE match on input_ref
    const byInputRefLike = db.prepare(
      "SELECT * FROM tasks WHERE input_ref LIKE ?"
    ).all(`${painId}%`);
    if (byInputRefLike.length > 0) {
      console.log(`  Found by input_ref LIKE: ${byInputRefLike.length}`);
      tasks.push(...byInputRefLike.filter(t => !tasks.some(e => e.task_id === t.task_id)));
    }

    // Strategy 3: LIKE match on diagnostic_json
    const byDiagJson = db.prepare(
      "SELECT * FROM tasks WHERE diagnostic_json LIKE ?"
    ).all(`%${painId}%`);
    if (byDiagJson.length > 0) {
      console.log(`  Found by diagnostic_json LIKE: ${byDiagJson.length}`);
      tasks.push(...byDiagJson.filter(t => !tasks.some(e => e.task_id === t.task_id)));
    }

    // Strategy 4: LIKE match on task_id
    const byTaskId = db.prepare(
      "SELECT * FROM tasks WHERE task_id LIKE ?"
    ).all(`%${painId}%`);
    if (byTaskId.length > 0) {
      console.log(`  Found by task_id LIKE: ${byTaskId.length}`);
      tasks.push(...byTaskId.filter(t => !tasks.some(e => e.task_id === t.task_id)));
    }

    // Also search in pain_signals table if it exists
    let painSignal = null;
    try {
      painSignal = db.prepare(
        "SELECT * FROM pain_signals WHERE pain_id = ? OR pain_id LIKE ?"
      ).get(painId, `${painId}%`);
      if (painSignal) {
        console.log(`  Found pain_signal record`);
      }
    } catch (e) {
      // Table might not exist
    }

    // Also search in principle_candidates if it exists
    let candidates = [];
    try {
      candidates = db.prepare(
        "SELECT * FROM principle_candidates WHERE source_pain_id = ? OR source_pain_id LIKE ?"
      ).all(painId, `${painId}%`);
      if (candidates.length > 0) {
        console.log(`  Found ${candidates.length} principle_candidates`);
      }
    } catch (e) {
      // Table might not exist
    }

    // Find runs for each task
    const allTaskData = [];
    for (const task of tasks) {
      console.log(`\n  Task: ${task.task_id} (kind=${task.task_kind}, status=${task.status})`);

      // Get runs for this task
      let runs = [];
      try {
        runs = db.prepare(
          "SELECT * FROM runs WHERE task_id = ? ORDER BY ended_at DESC"
        ).all(task.task_id);
        console.log(`    Runs: ${runs.length}`);
      } catch (e) {
        console.log(`    Runs: table not found or error`);
      }

      // Parse diagnostic_json
      let diagJson = null;
      try {
        diagJson = JSON.parse(task.diagnostic_json || 'null');
      } catch {
        console.log(`    diagnostic_json: parse failed`);
      }

      // Parse run output_payload
      const runOutputs = [];
      for (const run of runs) {
        let output = null;
        try {
          output = JSON.parse(run.output_payload || 'null');
        } catch {
          // ignore
        }
        runOutputs.push({
          runId: run.run_id,
          status: run.execution_status,
          startedAt: run.started_at,
          endedAt: run.ended_at,
          output,
        });
      }

      allTaskData.push({
        taskId: task.task_id,
        taskKind: task.task_kind,
        taskStatus: task.status,
        inputRef: task.input_ref,
        createdAt: task.created_at,
        diagnosticJson: diagJson,
        runs: runOutputs,
      });
    }

    // Build the fixture
    // Find the diagnostician task specifically
    const diagTask = allTaskData.find(t => t.taskKind === 'diagnostician');
    const succeededRun = diagTask?.runs?.find(r => r.status === 'succeeded');

    // Extract contextPayload from the diagnostician task
    let contextPayload = null;
    if (diagTask?.diagnosticJson) {
      contextPayload = diagTask.diagnosticJson;
    }

    // Extract monolithOutput from the succeeded run
    let monolithOutput = null;
    if (succeededRun?.output) {
      monolithOutput = succeededRun.output;
    }

    // Truncate large fields
    if (contextPayload) {
      if (contextPayload.conversationWindow && Array.isArray(contextPayload.conversationWindow)) {
        if (contextPayload.conversationWindow.length > 10) {
          contextPayload.conversationWindow = contextPayload.conversationWindow.slice(-10);
        }
      }
      if (contextPayload.sourceRefs && Array.isArray(contextPayload.sourceRefs)) {
        if (contextPayload.sourceRefs.length > 5) {
          contextPayload.sourceRefs = contextPayload.sourceRefs.slice(0, 5);
        }
      }
      // Also handle nested painData
      if (contextPayload.painData) {
        if (contextPayload.painData.conversationWindow && Array.isArray(contextPayload.painData.conversationWindow)) {
          if (contextPayload.painData.conversationWindow.length > 10) {
            contextPayload.painData.conversationWindow = contextPayload.painData.conversationWindow.slice(-10);
          }
        }
        if (contextPayload.painData.sourceRefs && Array.isArray(contextPayload.painData.sourceRefs)) {
          if (contextPayload.painData.sourceRefs.length > 5) {
            contextPayload.painData.sourceRefs = contextPayload.painData.sourceRefs.slice(0, 5);
          }
        }
      }
    }

    const fixture = {
      id: code,
      painId: painId,
      source: SOURCE_MAP[code] || 'unknown',
      description: DESCRIPTIONS[code] || '',
      coveredAxioms: AXIOM_MAP[code] || [],
      contextPayload: contextPayload,
      monolithOutput: monolithOutput,
      // Additional data for completeness
      _meta: {
        painSignal: painSignal || null,
        candidates: candidates.length > 0 ? candidates.map(c => ({
          candidateId: c.candidate_id,
          principleText: c.principle_text?.slice(0, 200),
          status: c.status,
        })) : [],
        allTasks: allTaskData.map(t => ({
          taskId: t.taskId,
          taskKind: t.taskKind,
          taskStatus: t.taskStatus,
          inputRef: t.inputRef,
          runCount: t.runs.length,
          succeededRunId: t.runs.find(r => r.status === 'succeeded')?.runId || null,
        })),
      },
    };

    const fileName = `${code.toLowerCase()}-${painId}.json`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));
    console.log(`\n  Written: ${filePath}`);
    console.log(`  contextPayload: ${contextPayload ? 'present' : 'null'}`);
    console.log(`  monolithOutput: ${monolithOutput ? 'present' : 'null'}`);
  }

  db.close();
  console.log('\n=== Done ===');
}

main();
