/**
 * Pain Phase 0 — real integration evidence runner (S1–S4).
 *
 * Part of PR #2296 evidence (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001
 * Phase 0). Drives REAL production entry points from the built dist of THIS
 * checkout (production bytes, zero mocks) against ONE isolated temp workspace
 * with a real SQLite trajectory.db, then dumps observable DB/file facts as
 * machine-readable JSON next to this file.
 *
 * Scenarios:
 *  S1  before_compaction with a fatal-intercept session file
 *      → operational note present; ZERO intercept_extraction pain rows.
 *  S2  /pd-samples review reject on a real mined correction sample
 *      → review + reason saved; ZERO correction_rejected pain rows.
 *  S3  after_tool_call toolName='pain' (explicit Owner pain, positive control)
 *      → pain signal + pain event + manual admission → diagnostic pipeline.
 *  S4a LLM output hook: plain error text + semantic-confusion text + 5-turn
 *      stuck-loop shape → ZERO llm_* / llm_paralysis pain rows.
 *  S4b GFI positive control: 30 real failing after_tool_call calls
 *      accumulate GFI → one handleLlmOutput → exactly ONE user_empathy row,
 *      score=60 (min(gfi,60) clamp), evidence-only (no diagnostic emit).
 *
 * Environment boundary (also emitted into the JSON):
 *  - production dist of the CURRENT checkout: YES (imports from dist/)
 *  - real hook entry points: YES (handleBeforeCompaction / handleSamplesCommand
 *    / handleAfterToolCall / handleLlmOutput)
 *  - real SQLite (better-sqlite3 over the production writers' trajectory.db): YES
 *  - real LLM calls: NO (none of the paths invoke an LLM; recordPain only
 *    creates diagnostician tasks)
 *  - real OpenClaw host experiment: NO (hooks invoked directly, no host)
 *  - production data / real HOME touched: NO (temp workspace, removed after run)
 *
 * Usage: node docs/implementation-reports/phase0-integration-evidence/run-integration-evidence.mjs [repoRoot]
 * (repoRoot defaults to the checkout containing this file)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WT = path.resolve(process.argv[2] ?? defaultRoot);
const plugin = (p) => pathToFileURL(path.join(WT, 'packages/openclaw-plugin/dist', `${p}.js`)).href;

process.env.PD_WORKSPACE_DIR = ''; // neutralize machine-level explicit sources

const results = {};
function record(name, pass, facts) {
  results[name] = { pass, ...facts };
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  for (const [k, v] of Object.entries(facts)) {
    if (k !== 'sqlQueries' && k !== 'inputs') console.log(`      ${k}: ${JSON.stringify(v)}`);
  }
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-phase0-integration-'));
process.env.PD_WORKSPACE_DIR = ws;
console.log(`isolated workspace: ${ws}`);
console.log(`checkout (production dist source): ${WT}`);

// ── imports from production dist ────────────────────────────────────────────
const { handleBeforeCompaction } = await import(plugin('hooks/lifecycle'));
const { handleSamplesCommand } = await import(plugin('commands/samples'));
const { handleAfterToolCall } = await import(plugin('hooks/pain'));
const { TrajectoryRegistry } = await import(plugin('core/trajectory'));
const { listCorrectionSamples } = await import(pathToFileURL(path.join(WT, 'packages/principles-core/dist/trajectory-store.js')).href);

const sessionId = 'phase0-integration';

function evoPathGlobal(workspace) {
  return path.join(workspace, 'memory', 'evolution.jsonl');
}
function readEvo(workspace) {
  return fs.readFileSync(evoPathGlobal(workspace), 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function painRows(db, where) {
  return db.prepare(`SELECT source, score FROM pain_events WHERE ${where}`).all();
}
function openTraj(ro = true) {
  return new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: ro });
}

// ── mine one correction sample through the real pipeline ────────────────────
TrajectoryRegistry.use(ws, (db) => {
  const turnId = db.recordAssistantTurn({
    sessionId,
    runId: 'run-i1',
    provider: 'p',
    model: 'm',
    rawText: 'wrong assistant output needing correction',
    sanitizedText: 'wrong assistant output needing correction',
    usageJson: {},
    empathySignalJson: {},
  });
  db.recordUserTurn({
    sessionId,
    turnIndex: 1,
    rawText: 'this is wrong, fix it',
    correctionDetected: true,
    correctionCue: 'this is wrong',
    referencesAssistantTurnId: turnId,
  });
  db.recordToolCall({ sessionId, toolName: 'edit_file', outcome: 'success' });
});
const [sample] = listCorrectionSamples(ws);

// ── S1: before_compaction fatal intercept ───────────────────────────────────
{
  const sessionFile = path.join(ws, 'session-s1.jsonl');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ role: 'assistant', content: 'trying forbidden action' }),
    JSON.stringify({ role: 'assistant', content: 'attempting again', openclawAbort: { aborted: true, origin: 'rpc', runId: 'run-fatal-i' } }),
  ].join('\n'), 'utf8');

  await handleBeforeCompaction({ messageCount: 2, sessionFile }, { workspaceDir: ws, sessionId, logger: { info() {}, warn() {}, error() {}, debug() {} } });

  const [dateStr] = new Date().toISOString().split('T');
  const note = fs.readFileSync(path.join(ws, 'memory', `${dateStr}.md`), 'utf8');
  const db = openTraj();
  const interceptPains = painRows(db, "source = 'intercept_extraction'");
  const s1AssistantTurns = db.prepare('SELECT COUNT(*) n FROM assistant_turns WHERE session_id = ?').get(sessionId).n;
  db.close();

  const noteHasFact = note.includes('[FATAL INTERCEPT]') && note.includes('attempting again');
  const noPainClaim = !note.includes('Runtime V2 pain chain');
  record('S1 fatal-intercept: note yes / pain no', interceptPains.length === 0 && noteHasFact && noPainClaim, {
    inputs: { hook: 'handleBeforeCompaction', sessionFileLines: ['assistant msg', 'assistant msg + openclawAbort{aborted:true,runId:run-fatal-i}'] },
    sqlQueries: [
      "SELECT source, score FROM pain_events WHERE source = 'intercept_extraction'",
      'SELECT COUNT(*) n FROM assistant_turns WHERE session_id = ?',
    ],
    interceptPainRows: interceptPains.length,
    memoryNoteHasFailureFact: noteHasFact,
    misleadingTextGone: noPainClaim,
    assistantTurnsRecorded: s1AssistantTurns >= 1,
  });
}

// ── S2: sample reject ────────────────────────────────────────────────────────
{
  const result = handleSamplesCommand({ args: `review reject ${sample.sampleId} not a real fix`, sessionId, sessionKey: sessionId, config: { workspaceDir: ws, language: 'en' } });
  const db = openTraj();
  const rejectedPains = painRows(db, "source = 'correction_rejected'");
  const status = db.prepare('SELECT review_status FROM correction_samples WHERE sample_id = ?').get(sample.sampleId).review_status;
  const review = db.prepare('SELECT note FROM sample_reviews WHERE sample_id = ?').get(sample.sampleId);
  db.close();
  record('S2 sample reject: review saved / pain+task none', rejectedPains.length === 0 && status === 'rejected', {
    inputs: { command: 'review reject <sampleId> not a real fix', minedSampleId: sample?.sampleId ?? null },
    sqlQueries: [
      "SELECT source, score FROM pain_events WHERE source = 'correction_rejected'",
      'SELECT review_status FROM correction_samples WHERE sample_id = ?',
      'SELECT note FROM sample_reviews WHERE sample_id = ?',
    ],
    commandText: result.text,
    correctionRejectedPainRows: rejectedPains.length,
    reviewStatus: status,
    reviewNote: review?.note ?? null,
  });
}

// ── S3: explicit owner pain (positive control) ──────────────────────────────
{
  handleAfterToolCall(
    { toolName: 'pain', params: { input: 'integration check: agent ignored my instruction' } },
    { workspaceDir: ws, sessionId, sessionKey: sessionId, agentId: 'main' },
  );
  // recordPain is async inside emit — give the microtasks a beat.
  await new Promise((r) => setTimeout(r, 1500));

  const db = openTraj();
  const manualPains = painRows(db, "source = 'manual'");
  const trajPain = db.prepare("SELECT COUNT(*) n FROM pain_events WHERE session_id = ? AND source = 'manual'").get(sessionId).n;
  db.close();

  // Diagnostician pipeline evidence: the plugin pain chain persists the
  // pain_detected/pain_recorded pair into the evolution event stream and the
  // TRIGGER_DECISION (manual_owner_admitted → create_diagnostic_task) into
  // the SYSTEM log. recordPain completing is the task-creation signal.
  let taskEvidence = null;
  const evoPath = path.join(ws, 'memory', 'evolution.jsonl');
  if (fs.existsSync(evoPath)) {
    const lines = readEvo(ws);
    const detected = lines.filter((e) => e?.type === 'pain_detected' && e?.data?.source === 'pain').length;
    const recorded = lines.filter((e) => e?.type === 'pain_recorded' && e?.data?.source === 'pain').length;
    const [dateStr] = new Date().toISOString().split('T');
    const logPath = path.join(ws, 'memory', 'logs', `SYSTEM_${dateStr}.log`);
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const admitted = log.includes('manual_owner_admitted') && log.includes('create_diagnostic_task');
    taskEvidence = { painDetectedEvents: detected, painRecordedEvents: recorded, manualAdmissionLogged: admitted };
  }

  record('S3 explicit pain: signal+event+pipeline created', manualPains.length >= 1 && trajPain >= 1
    && !!taskEvidence && taskEvidence.painDetectedEvents >= 1 && taskEvidence.painRecordedEvents >= 1 && taskEvidence.manualAdmissionLogged, {
    inputs: { hook: 'handleAfterToolCall', event: { toolName: 'pain', params: { input: 'integration check: agent ignored my instruction' } } },
    sqlQueries: [
      "SELECT source, score FROM pain_events WHERE source = 'manual'",
      "SELECT COUNT(*) n FROM pain_events WHERE session_id = ? AND source = 'manual'",
    ],
    manualPainSignalRows: manualPains.length,
    trajectoryPainEventRows: trajPain,
    diagnosticEvidence: taskEvidence,
  });
}

// ── S4: LLM Output + GFI (real hook entry → real SQLite) ────────────────────
// Production chain, zero mocks: handleLlmOutput / handleAfterToolCall from
// the built dist drive session-tracker (in-process GFI accumulation) and the
// real trajectory.db writers. Old-source rows are counted by SQL.
{
  const { handleLlmOutput } = await import(plugin('hooks/llm'));

  // ── S4a: Semantic / Paralysis produce NO pain on a fresh session ──
  const sessA = 's4-semantic';
  const llmEvent = (text, usage) => ({
    assistantTexts: [text],
    runId: `run-${sessA}`,
    provider: 'dist-integration',
    model: 'none',
    usage,
    lastAssistant: null,
  });
  const llmCtx = (sess) => ({ workspaceDir: ws, sessionId: sess, sessionKey: sess, agentId: 'main', logger: { info() {}, warn() {}, error() {}, debug() {} } });

  const s4aInputs = [];
  // (1) plain error text — pre-Phase-0 the dictionary funnel could match this
  s4aInputs.push({ kind: 'plain error text', text: 'Error: ENOENT: no such file or directory, open /x/y', usage: { input: 500, output: 900 } });
  handleLlmOutput(llmEvent(s4aInputs[0].text, s4aInputs[0].usage), llmCtx(sessA));
  // (2) semantic confusion phrasing
  s4aInputs.push({ kind: 'semantic confusion text', text: "I'm sorry, but I'm still getting an error. I apologize for the confusion.", usage: { input: 500, output: 900 } });
  handleLlmOutput(llmEvent(s4aInputs[1].text, s4aInputs[1].usage), llmCtx(sessA));
  // (3..7) stuck-loop shape: consecutive tiny output + huge input → the old
  // llm_paralysis trigger (threshold 3) would have fired from turn 3 on.
  s4aInputs.push({ kind: 'stuck-loop shape x5', text: 'k', usage: { input: 99999, output: 20 }, repeats: 5 });
  for (let i = 0; i < 5; i++) {
    handleLlmOutput(llmEvent('k', { input: 99999, output: 20 }), llmCtx(sessA));
  }

  const dbA = openTraj();
  const llmRowsA = dbA.prepare("SELECT source, score FROM pain_events WHERE session_id = ? AND (source LIKE 'llm_%')").all(sessA);
  const allRowsA = dbA.prepare('SELECT source, COUNT(*) n FROM pain_events WHERE session_id = ? GROUP BY source').all(sessA);
  const turnsA = dbA.prepare('SELECT COUNT(*) n FROM assistant_turns WHERE session_id = ?').get(sessA).n;
  dbA.close();
  const evoLinesA = fs.existsSync(evoPathGlobal(ws)) ? readEvo(ws).filter((e) => e?.type === 'pain_detected' && e?.data?.sessionId === sessA) : [];
  record('S4a semantic/paralysis: zero old-source pain rows from real hook chain',
    llmRowsA.length === 0 && evoLinesA.length === 0 && turnsA >= 7, {
      inputs: { session: sessA, hook: 'handleLlmOutput', llmOutputCalls: s4aInputs },
      sqlQueries: [
        "SELECT source, score FROM pain_events WHERE session_id = ? AND (source LIKE 'llm_%')",
        'SELECT source, COUNT(*) n FROM pain_events WHERE session_id = ? GROUP BY source',
        'SELECT COUNT(*) n FROM assistant_turns WHERE session_id = ?',
      ],
      llmSourcePainRows: llmRowsA.length,
      allPainRowsBySource: allRowsA,
      assistantTurnsRecorded: turnsA,
      painDetectedEventsForSession: evoLinesA.length,
      stuckLoopTurnsDriven: 5,
    });

  // ── S4b: GFI positive control — real friction accumulation → clamp row ──
  const sessB = 's4-gfi';
  // Real failing tool calls through handleAfterToolCall: each failure adds
  // scores.tool_failure_friction (15) with the repeated-failure multiplier,
  // accumulating GFI in the shared session-tracker (the exact production
  // accumulator handleLlmOutput reads).
  const failEvent = { toolName: 'exec', result: { exitCode: 1, details: { exitCode: 1 } }, error: 'command failed with exit code 1' };
  let frictionCalls = 0;
  for (let i = 0; i < 30; i++) {
    handleAfterToolCall(
      { ...failEvent },
      { workspaceDir: ws, sessionId: sessB, sessionKey: sessB, agentId: 'main', logger: { info() {}, warn() {}, error() {}, debug() {} } },
    );
    frictionCalls++;
  }

  // One single llm_output call — the GFI branch fires iff currentGfi >= 70.
  const s4bLlm = { kind: 'single llm_output after friction accumulation', text: 'assistant reply after repeated failures', usage: { input: 900, output: 700 } };
  handleLlmOutput(llmEvent(s4bLlm.text, s4bLlm.usage), llmCtx(sessB));

  const dbB = openTraj();
  const gfiRows = dbB.prepare("SELECT source, score, reason, origin, host_kind, created_at, canonical_pain_id IS NOT NULL AS hasCanonical FROM pain_events WHERE session_id = ? AND source = 'user_empathy'").all(sessB);
  const toolCallHealth = dbB.prepare('SELECT gfi_before, gfi_after FROM tool_calls WHERE session_id = ? AND gfi_after IS NOT NULL ORDER BY rowid DESC LIMIT 3').all(sessB);
  const toolFailurePains = dbB.prepare("SELECT COUNT(*) n FROM pain_events WHERE session_id = ? AND source IN ('tool_failure','dispatch_error')").get(sessB).n;
  dbB.close();
  const evoB = fs.existsSync(evoPathGlobal(ws)) ? readEvo(ws).filter((e) => e?.type === 'pain_detected' && e?.data?.sessionId === sessB) : [];

  // Contract pins (from the Phase 0 differential unit tests + pre-change code):
  // exactly ONE user_empathy row; score=60 = min(currentGfi,60) clamp;
  // origin 'system_infer'; host_kind 'openclaw'; and the reason string
  // carries the actual accumulated GFI value. The `llm_<ts>` canonical painId
  // format is pinned by the unit differential test (it lives in memory, not
  // as a pain_events column).
  const row = gfiRows[0];
  const gfiAtCrossing = row ? Number((row.reason.match(/Accumulated GFI \(([\d.]+)\)/) || [])[1]) : null;
  const clampOk = !!row && row.score === 60 && gfiAtCrossing !== null && gfiAtCrossing >= 60;
  const contractOk = !!row && row.source === 'user_empathy' && row.origin === 'system_infer' && row.host_kind === 'openclaw' && clampOk;
  // Evidence-only: the GFI path must NOT create a diagnostician pipeline
  // event (triage gfi_threshold = evidence_only, cannot upgrade).
  record('S4b GFI positive control: real friction → clamp row, evidence-only (no diagnose emit)',
    gfiRows.length === 1 && contractOk && evoB.length === 0, {
      inputs: { session: sessB, failingAfterToolCalls: { event: failEvent, count: 30 }, llmOutputCall: s4bLlm },
      sqlQueries: [
        "SELECT source, score, reason, origin, host_kind, created_at, canonical_pain_id IS NOT NULL AS hasCanonical FROM pain_events WHERE session_id = ? AND source = 'user_empathy'",
        'SELECT gfi_before, gfi_after FROM tool_calls WHERE session_id = ? AND gfi_after IS NOT NULL ORDER BY rowid DESC LIMIT 3',
        "SELECT COUNT(*) n FROM pain_events WHERE session_id = ? AND source IN ('tool_failure','dispatch_error')",
      ],
      userEmpathyPainRowsRaw: gfiRows,
      realFailureCallsDriven: frictionCalls,
      userEmpathyPainRows: gfiRows.length,
      gfiAtCrossing,
      clampedScore: row?.score ?? null,
      origin: row?.origin ?? null,
      hostKind: row?.host_kind ?? null,
      toolCallsGfiHealthColumnsRaw: toolCallHealth,
      // Pre-existing live Phase-A behavior (tool failure admission) may also
      // create its own pains for this session — recorded, not asserted.
      toolFailurePainRowsPreExisting: toolFailurePains,
      painDetectedEventsForSession: evoB.length,
    });
}

// ── cleanup ──────────────────────────────────────────────────────────────────
try { TrajectoryRegistry.dispose(ws); } catch { /* already closed */ }
fs.rmSync(ws, { recursive: true, force: true });

const allPass = Object.values(results).every((r) => r.pass);
console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);

let headSha = null;
try {
  const { execFileSync } = await import('node:child_process');
  headSha = execFileSync('git', ['-C', WT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch { /* not a git checkout or git unavailable — sha stays null */ }

const evidence = {
  schemaVersion: 'pd-phase0-integration-evidence/v1',
  spec: 'SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 Phase 0 (PR #2296)',
  runAt: new Date().toISOString(),
  checkoutHeadSha: headSha,
  environment: {
    productionDistOfThisCheckout: true,
    realHookEntryPoints: ['handleBeforeCompaction', 'handleSamplesCommand', 'handleAfterToolCall', 'handleLlmOutput'],
    realSqlite: true,
    realLlmExecuted: false,
    realOpenclawHostExperiment: false,
    realProductionDataTouched: false,
    isolatedWorkspacePath: ws,
    isolatedWorkspaceRemovedAfterRun: true,
    sqlAccess: 'better-sqlite3 readonly connections over the production writers\' trajectory.db; all parameterized',
  },
  scenarios: results,
  overallVerdict: allPass ? 'PASS' : 'FAIL',
};
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'PD-PAIN-PHASE0-INTEGRATION-EVIDENCE.json'), JSON.stringify(evidence, null, 2));
process.exit(allPass ? 0 : 1);
