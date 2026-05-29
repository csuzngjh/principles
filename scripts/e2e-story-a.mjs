#!/usr/bin/env node

/**
 * E2E Story A' Harness — Real-environment PD validation via trap tasks.
 *
 * Drives a real OpenClaw agent to genuinely fail at a designed trap task,
 * producing an authentic, context-bound pain signal (not manual/synthetic).
 * Validates the full Story A' pipeline: pain → diagnosis → candidate → admission.
 *
 * Usage:
 *   node scripts/e2e-story-a.mjs --trap trap-03 [--workspace <path>] [--run-id <id>]
 *   npm run e2e:story-a -- --trap trap-03
 *
 * Traps: trap-01 (circular dep), trap-03 (missing dep)
 *
 * See: .trae/skills/pd-openclaw-e2e/SKILL.md for full design.
 */

import { execSync, execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { trap: null, workspace: null, runId: null, timeout: 600, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trap') opts.trap = args[++i];
    else if (args[i] === '--workspace' || args[i] === '-w') opts.workspace = args[++i];
    else if (args[i] === '--run-id') opts.runId = args[++i];
    else if (args[i] === '--timeout') opts.timeout = parseInt(args[++i], 10);
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
  }
  if (!opts.runId) opts.runId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return opts;
}

// ---------------------------------------------------------------------------
// Trap definitions
// ---------------------------------------------------------------------------

const TRAPS = {
  'trap-01': {
    name: 'TRAP-01: Circular dependency (build failure)',
    fixtureDir: 'trap-01-circular-dep',
    promptTemplate: (ws) => `The build in the project at "${ws}" is broken. Your task: make \`npm run build\` pass.\n\nStart by running: cd "${ws}" && npm run build\nThen fix whatever is failing. Use absolute paths for all file operations — the project root is "${ws}".`,
    expectedRootCauseClass: 'circular_dependency',
    expectedTrigger: 'repeated_failure',
    verifyCommand: 'npm run build',
  },
  'trap-03': {
    name: 'TRAP-03: Missing peer dependency (test failure)',
    fixtureDir: 'trap-03-missing-dep',
    promptTemplate: (ws) => `The test suite in the project at "${ws}" is broken. Your task: make all tests pass.\n\nStart by running: cd "${ws}" && npm test\nThen fix whatever is failing. Use absolute paths for all file operations — the project root is "${ws}".`,
    expectedRootCauseClass: 'wrong_or_missing_dependency',
    expectedTrigger: 'repeated_failure',
    verifyCommand: 'npm test',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PD_CLI = join(ROOT, 'packages/pd-cli/dist/index.js');
const FIXTURES_DIR = join(ROOT, 'tests/e2e-fixtures');
const E2E_WS_BASE = join(ROOT, 'tests/e2e-workspace');
const EVIDENCE_DIR = join(ROOT, 'evidence');

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: opts.timeout ?? 30000, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return e.stdout?.trim?.() ?? '';
  }
}

function shJson(cmd, opts = {}) {
  const raw = sh(cmd, opts);
  try { return JSON.parse(raw); } catch { return null; }
}

function pdCmd(subcmd, ws) {
  return `node "${PD_CLI}" ${subcmd} --workspace "${ws}" --json`;
}

function log(phase, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] Phase ${phase}: ${msg}`);
}

function pass(phase, msg) { log(phase, `✅ ${msg}`); }
function fail(phase, msg) { log(phase, `❌ ${msg}`); }
function skip(phase, msg) { log(phase, `⏭️  ${msg}`); }

// ---------------------------------------------------------------------------
// Phase 0: Isolate workspace
// ---------------------------------------------------------------------------

function phase0(trap, runId) {
  const ws = join(E2E_WS_BASE, runId);
  const trapDir = join(FIXTURES_DIR, trap.fixtureDir);

  if (!existsSync(trapDir)) {
    return { ok: false, ws: null, error: `Fixture not found: ${trapDir}` };
  }

  // Clean and create
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });

  // Copy fixture
  cpSync(trapDir, ws, { recursive: true });

  // Copy live workspace config if available
  const liveWs = 'D:\\.openclaw\\workspace';
  const configFiles = ['.pd/feature-flags.yaml', '.state/workflows.yaml'];
  for (const f of configFiles) {
    const src = join(liveWs, f);
    const dest = join(ws, f);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
  }

  return { ok: true, ws };
}

// ---------------------------------------------------------------------------
// Phase 1: Environment probe
// ---------------------------------------------------------------------------

function phase1() {
  const status = sh('openclaw status', { timeout: 15000 });
  if (!status || status.includes('unreachable')) {
    return { ok: false, error: 'Gateway unreachable. Run: openclaw gateway run --force' };
  }

  // Quick agent probe
  const probe = sh('openclaw agent --session-key "agent:main:main" --message "reply OK" --timeout 30 --json', { timeout: 45000 });
  if (!probe) {
    return { ok: false, error: 'Agent probe failed — no response from openclaw agent' };
  }

  return { ok: true, status, probe };
}

// ---------------------------------------------------------------------------
// Phase 2: Baseline capture
// ---------------------------------------------------------------------------

function phase2(ws) {
  const canary = shJson(pdCmd('runtime canary', ws));
  const integrity = shJson(pdCmd('runtime internalization integrity', ws));
  const queue = shJson(pdCmd('runtime internalization queue', ws));

  return {
    canary: canary ?? { overallStatus: 'unavailable' },
    integrity: integrity ?? { overallStatus: 'unavailable' },
    queue: queue ?? { totalPending: 0, totalProcessing: 0 },
    candidateCount: queue?.totalPending ?? 0,
    ledgerEntryCount: integrity?.ledgerEntryCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Drive the trap task
// ---------------------------------------------------------------------------

function phase3(trap, runId, timeoutSec, ws) {
  const sessionKey = `agent:e2e:${runId}`;
  const prompt = trap.promptTemplate(ws);
  const cmd = `openclaw agent --session-key "${sessionKey}" --message "${prompt.replace(/"/g, '\\"')}" --timeout ${timeoutSec} --json`;

  log('3', `Driving trap with session: ${sessionKey}`);
  const raw = sh(cmd, { timeout: (timeoutSec + 30) * 1000 });

  let result = null;
  try { result = JSON.parse(raw); } catch { /* non-JSON response */ }

  const toolSummary = result?.toolSummary ?? result?.meta?.toolSummary ?? [];
  const toolCalls = Array.isArray(toolSummary) ? toolSummary : [];
  const failedTools = toolCalls.filter(t => t.exitCode !== 0 || t.error);
  const sessionUsed = sessionKey;

  return {
    raw: raw.slice(0, 2000), // truncate for evidence
    result,
    toolCalls,
    failedTools,
    sessionKey: sessionUsed,
    agentResponded: !!raw,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Confirm real pain was emitted
// ---------------------------------------------------------------------------

function phase4(ws, sessionKey) {
  // Check queue for new pain_detected entries
  const queue = shJson(pdCmd('runtime internalization queue', ws));

  // Search event log for pain_signal
  const today = new Date().toISOString().slice(0, 10);
  const eventLog = join(ws, `.state/logs/events_${today}.jsonl`);
  let painEvents = [];

  if (existsSync(eventLog)) {
    const lines = readFileSync(eventLog, 'utf-8').split('\n').filter(Boolean);
    painEvents = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (e.type?.includes('pain_signal') || e.type?.includes('pain_detected')))
      .filter(e => !sessionKey || e.data?.sessionId?.includes(sessionKey) || e.sessionId?.includes(sessionKey));
  }

  // Determine provenance from the most recent pain event
  const latestPain = painEvents[painEvents.length - 1];
  const provenance = latestPain?.data?.provenance ?? latestPain?.provenance ?? null;

  return {
    queue,
    painEvents,
    painCount: painEvents.length,
    provenance,
    latestPain,
  };
}

// ---------------------------------------------------------------------------
// Phase 5: Verify diagnosis → candidate → admission chain
// ---------------------------------------------------------------------------

function phase5(ws) {
  // Get queue to find task/candidate IDs
  const queue = shJson(pdCmd('runtime internalization queue', ws));
  const tasks = queue?.tasks ?? queue?.pendingTasks ?? [];
  const candidates = queue?.candidates ?? queue?.pendingCandidates ?? [];

  const results = { tasks: [], candidates: [], integrity: null, canary: null };

  // Check up to 3 tasks
  for (const task of tasks.slice(0, 3)) {
    const taskId = task.taskId ?? task.id;
    if (!taskId) continue;
    const detail = shJson(pdCmd(`task show ${taskId}`, ws));
    results.tasks.push({
      taskId,
      status: detail?.status ?? 'unknown',
      diagnosticJson: detail?.diagnosticJson,
      candidateIds: detail?.candidateIds ?? [],
    });
  }

  // Check up to 5 candidates
  for (const cand of candidates.slice(0, 5)) {
    const candidateId = cand.candidateId ?? cand.id;
    if (!candidateId) continue;
    const detail = shJson(pdCmd(`candidate show ${candidateId}`, ws));
    results.candidates.push({
      candidateId,
      status: detail?.status ?? 'unknown',
      admission: detail?.admission,
      sourcePainId: detail?.sourcePainId,
    });
  }

  // Integrity + canary
  results.integrity = shJson(pdCmd('runtime internalization integrity', ws));
  results.canary = shJson(pdCmd('runtime canary', ws));

  return results;
}

// ---------------------------------------------------------------------------
// Phase 7: Generate evidence report
// ---------------------------------------------------------------------------

function generateEvidence({ runId, trap, phase0R, phase1R, phase2R, phase3R, phase4R, phase5R }) {
  const date = new Date().toISOString().slice(0, 10);
  const evidencePath = join(EVIDENCE_DIR, date);
  mkdirSync(evidencePath, { recursive: true });

  const filePath = join(evidencePath, `STORY_A_E2E_${runId}.md`);

  // Compute verdict
  let verdict = 'story_a_validated';
  const verdictNotes = [];

  if (!phase0R.ok) { verdict = `failed:phase0:${phase0R.error}`; }
  else if (!phase1R.ok) { verdict = `failed:phase1:${phase1R.error}`; }
  else if (!phase3R.agentResponded) { verdict = 'failed:phase3:agent_no_response'; }
  else if (phase4R.painCount === 0) { verdict = 'failed:phase4:no_pain_emitted'; }
  else if (phase4R.provenance !== 'openclaw_context_bound') {
    verdict = `failed:phase4:wrong_provenance:${phase4R.provenance}`;
  }
  else if (phase5R.tasks.length === 0) { verdict = 'failed:phase5:no_tasks_created'; }
  else if (phase5R.candidates.length === 0) {
    // Context-bound pain with no candidates — may be needs_evidence (acceptable)
    const hasNeedsEvidence = phase5R.candidates.some(c => c.admission?.decision === 'needs_evidence');
    if (hasNeedsEvidence) {
      verdict = 'gate_quarantined_expected';
      verdictNotes.push('Context-bound pain but diagnosis was evidence-incomplete → needs_evidence is correct');
    } else {
      verdict = 'failed:phase5:no_candidates';
    }
  }
  else {
    // Check admission decisions
    const admitted = phase5R.candidates.filter(c => c.admission?.decision === 'admitted');
    const deferred = phase5R.candidates.filter(c => c.admission?.decision === 'deferred');
    const needsEvidence = phase5R.candidates.filter(c => c.admission?.decision === 'needs_evidence');

    if (admitted.length > 0 || deferred.length > 0) {
      verdict = 'story_a_validated';
      verdictNotes.push(`${admitted.length} admitted, ${deferred.length} deferred, ${needsEvidence.length} needs_evidence`);
    } else if (needsEvidence.length > 0) {
      verdict = 'gate_quarantined_expected';
      verdictNotes.push('All candidates needs_evidence — diagnosis may be evidence-incomplete');
    }
  }

  const baselineDelta = {
    newCandidates: (phase5R.candidates?.length ?? 0) - (phase2R.candidateCount ?? 0),
    newTasks: phase5R.tasks?.length ?? 0,
    integrityBefore: phase2R.integrity?.overallStatus,
    integrityAfter: phase5R.integrity?.overallStatus,
  };

  const md = `# Story A' E2E Report — ${runId}

**Date**: ${new Date().toISOString()}
**Trap**: ${trap.name}
**Expected root cause**: ${trap.expectedRootCauseClass}
**Verdict**: \`${verdict}\`
${verdictNotes.length > 0 ? `\n**Notes**: ${verdictNotes.join('; ')}` : ''}

---

## Phase 0: Workspace Isolation

- **Status**: ${phase0R.ok ? 'PASS' : 'FAIL'}
- **Workspace**: ${phase0R.ws ?? 'N/A'}
${phase0R.error ? `- **Error**: ${phase0R.error}` : ''}

## Phase 1: Environment Probe

- **Status**: ${phase1R.ok ? 'PASS' : 'FAIL'}
${phase1R.error ? `- **Error**: ${phase1R.error}` : ''}
${phase1R.status ? `- **Gateway**: ${phase1R.status.split('\n')[0]}` : ''}

## Phase 2: Baseline Capture

- **Canary**: ${phase2R.canary?.overallStatus ?? 'N/A'}
- **Integrity**: ${phase2R.integrity?.overallStatus ?? 'N/A'}
- **Queue candidates**: ${phase2R.candidateCount ?? 0}
- **Ledger entries**: ${phase2R.ledgerEntryCount ?? 0}

## Phase 3: Trap Task Execution

- **Session**: ${phase3R.sessionKey}
- **Agent responded**: ${phase3R.agentResponded}
- **Tool calls**: ${phase3R.toolCalls.length}
- **Failed tools**: ${phase3R.failedTools.length}
- **Agent output (first 500 chars)**:
\`\`\`
${(phase3R.raw ?? '').slice(0, 500)}
\`\`\`

## Phase 4: Pain Emission Confirmation

- **Pain events found**: ${phase4R.painCount}
- **Provenance**: ${phase4R.provenance ?? 'none'}
- **Expected**: \`openclaw_context_bound\`
- **Provenance correct**: ${phase4R.provenance === 'openclaw_context_bound' ? '✅ YES' : '❌ NO'}

## Phase 5: Diagnosis → Candidate → Admission Chain

### Tasks (${phase5R.tasks.length})
${phase5R.tasks.map(t => `- \`${t.taskId}\`: status=${t.status}, candidates=${t.candidateIds?.length ?? 0}`).join('\n') || '(none)'}

### Candidates (${phase5R.candidates.length})
${phase5R.candidates.map(c => `- \`${c.candidateId}\`: admission=${c.admission?.decision ?? 'N/A'}, sourcePainId=${c.sourcePainId ?? 'N/A'}`).join('\n') || '(none)'}

### Integrity
- **Status**: ${phase5R.integrity?.overallStatus ?? 'N/A'}

### Canary
- **Status**: ${phase5R.canary?.overallStatus ?? 'N/A'}

## Baseline Delta

- **New candidates**: ${baselineDelta.newCandidates}
- **New tasks**: ${baselineDelta.newTasks}
- **Integrity before**: ${baselineDelta.integrityBefore}
- **Integrity after**: ${baselineDelta.integrityAfter}

---

## Determinism Notes

- Provenance, admission decision, task status: **exact** assertions
- Diagnosis text, principle content, specific candidate count: **best-effort** (LLM non-deterministic)
- Trap trigger (repeated_failure): **exact** — deterministic fixture design
`;

  writeFileSync(filePath, md, 'utf-8');
  return { filePath, verdict };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
E2E Story A' Harness — Real-environment PD validation

Usage:
  node scripts/e2e-story-a.mjs --trap <trap-id> [options]

Options:
  --trap <id>       Trap to run (trap-01, trap-03) [required]
  --workspace, -w   Override e2e workspace path (default: tests/e2e-workspace/<runId>)
  --run-id <id>     Custom run ID (default: auto-generated)
  --timeout <sec>   Agent timeout in seconds (default: 600)
  --help, -h        Show this help

Traps:
  trap-01  Circular dependency (build failure, repeated)
  trap-03  Missing peer dependency (test failure, repeated)
`);
    process.exit(0);
  }

  const trap = TRAPS[opts.trap];
  if (!trap) {
    console.error(`Error: Unknown trap "${opts.trap}". Available: ${Object.keys(TRAPS).join(', ')}`);
    process.exit(1);
  }

  const runId = opts.runId;
  const evidenceLines = [];

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     E2E Story A\' Harness — Real PD Validation           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nRun ID: ${runId}`);
  console.log(`Trap:   ${trap.name}\n`);

  // Phase 0
  log('0', 'Isolating workspace...');
  const phase0R = opts.workspace
    ? { ok: true, ws: opts.workspace }
    : phase0(trap, runId);
  if (!phase0R.ok) { fail('0', phase0R.error); process.exit(1); }
  pass('0', `Workspace: ${phase0R.ws}`);

  // Phase 1
  log('1', 'Probing environment...');
  const phase1R = phase1();
  if (!phase1R.ok) {
    skip('1', phase1R.error);
    // Environment unavailable — generate skip evidence
    const { filePath } = generateEvidence({
      runId, trap,
      phase0R, phase1R,
      phase2R: { canary: null, integrity: null, queue: null, candidateCount: 0, ledgerEntryCount: 0 },
      phase3R: { raw: '', result: null, toolCalls: [], failedTools: [], sessionKey: '', agentResponded: false },
      phase4R: { queue: null, painEvents: [], painCount: 0, provenance: null, latestPain: null },
      phase5R: { tasks: [], candidates: [], integrity: null, canary: null },
    });
    console.log(`\nSKIP: Environment unavailable. Evidence: ${filePath}`);
    process.exit(0);
  }
  pass('1', 'Gateway reachable, agent responsive');

  // Phase 2
  log('2', 'Capturing baseline...');
  const phase2R = phase2(phase0R.ws);
  pass('2', `Canary=${phase2R.canary?.overallStatus}, Integrity=${phase2R.integrity?.overallStatus}, Queue candidates=${phase2R.candidateCount}`);

  // Phase 3
  log('3', `Driving trap task (${trap.name})...`);
  const phase3R = phase3(trap, runId, opts.timeout, phase0R.ws);
  if (!phase3R.agentResponded) {
    fail('3', 'Agent did not respond');
  } else {
    pass('3', `Agent responded, ${phase3R.toolCalls.length} tool calls, ${phase3R.failedTools.length} failed`);
  }

  // Phase 4
  log('4', 'Checking pain emission...');
  // Brief pause to let hooks process
  sh('sleep 3', { timeout: 10000 });
  const phase4R = phase4(phase0R.ws, phase3R.sessionKey);
  if (phase4R.painCount === 0) {
    fail('4', 'No pain events found — trap did not trigger a pain signal');
  } else if (phase4R.provenance === 'openclaw_context_bound') {
    pass('4', `Pain emitted, provenance=openclaw_context_bound (${phase4R.painCount} events)`);
  } else {
    fail('4', `Pain emitted but wrong provenance: ${phase4R.provenance}`);
  }

  // Phase 5
  log('5', 'Verifying diagnosis → candidate → admission chain...');
  const phase5R = phase5(phase0R.ws);
  pass('5', `Tasks=${phase5R.tasks.length}, Candidates=${phase5R.candidates.length}, Integrity=${phase5R.integrity?.overallStatus}`);

  // Phase 7: Evidence
  log('7', 'Generating evidence report...');
  const { filePath, verdict } = generateEvidence({
    runId, trap, phase0R, phase1R, phase2R, phase3R, phase4R, phase5R,
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`VERDICT: ${verdict}`);
  console.log(`EVIDENCE: ${filePath}`);
  console.log('═'.repeat(60));

  // Exit code: 0 for validated/gate_quarantined, 1 for failed
  if (verdict.startsWith('failed')) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Harness error:', e);
  process.exit(1);
});
