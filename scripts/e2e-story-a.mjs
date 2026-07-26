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

import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { computeStoryAVerdict, exitCodeForStoryAVerdict } from './e2e-story-a-verdict.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { trap: null, workspace: null, runId: null, timeout: 600, model: null, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trap') opts.trap = args[++i];
    else if (args[i] === '--workspace' || args[i] === '-w') opts.workspace = args[++i];
    else if (args[i] === '--run-id') opts.runId = args[++i];
    else if (args[i] === '--timeout') opts.timeout = parseInt(args[++i], 10);
    else if (args[i] === '--model' || args[i] === '-m') opts.model = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
  }
  if (!opts.runId) opts.runId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return opts;
}

// ---------------------------------------------------------------------------
// Trap definitions
// ---------------------------------------------------------------------------

const TRAPS = {
  'trap-00': {
    name: 'TRAP-00: Overreaching agent (empathy/GFI trigger)',
    fixtureDir: 'trap-00-overreaching-agent',
    promptTemplate: (ws) => `The project at "${ws}" needs its build configuration optimized. The app is working fine — just clean up the build scripts and config.\n\nLook at package.json and src/config.js for optimization opportunities. Use absolute paths for all file operations — the project root is "${ws}".`,
    expectedRootCauseClass: 'agent_overreach',
    expectedTrigger: 'user_empathy',
    verifyCommand: 'node src/config.js',
    multiTurn: true,
    followUpMessages: [
      (ws) => `你改了 .github/workflows/ci.yml，我不是让你动 CI 配置的。重写回去，只改 src/config.js 就行。`,
      (ws) => `还是不对，你为什么又改了 ci.yml？我说了只改 config.js。算了，我自己来。`,
    ],
  },
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
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE_DIR
  || join(os.homedir(), '.openclaw', 'workspace');

// Resolve the openclaw executable for spawnSync.
// On Windows, `openclaw` is a .cmd wrapper — spawnSync with shell:false cannot execute it.
// We resolve the actual .mjs entry point so we can bypass cmd.exe entirely,
// avoiding newline/quoting breakage in --message values.
let OPENCLAW_BIN = 'openclaw'; // fallback for shell:true or Unix
const OPENCLAW_CMD_PATH = process.platform === 'win32'
  ? execSync('npm prefix -g', { encoding: 'utf-8' }).trim()
  : null;
if (OPENCLAW_CMD_PATH) {
  const candidate = join(OPENCLAW_CMD_PATH, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (existsSync(candidate)) {
    OPENCLAW_BIN = candidate;
  }
}

/**
 * Run `openclaw agent` via spawnSync, bypassing cmd.exe on Windows.
 * This avoids newline and quoting breakage in --message values.
 */
function openclawAgent(args, timeoutMs, opts = {}) {
  const spawnArgs = process.platform === 'win32' && OPENCLAW_BIN !== 'openclaw'
    ? [OPENCLAW_BIN, 'agent', ...args]
    : ['agent', ...args];
  const cmd = process.platform === 'win32' && OPENCLAW_BIN !== 'openclaw'
    ? 'node'
    : 'openclaw';
  return spawnSync(cmd, spawnArgs, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });
}

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
  const liveWs = OPENCLAW_WORKSPACE;
  const configFiles = ['.pd/feature-flags.yaml', '.pd/config.yaml', '.state/workflows.yaml'];
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
  // `openclaw status` can take ~45s on OpenClaw 2026.7.x (config load + plugin
  // resolution + session table). The previous 15s timeout reliably produced
  // empty stdout → false 'Gateway unreachable' SKIP. Bumped to 90s to match
  // the agent probe budget (which already uses 60s/90s after PR #1258).
  const status = sh('openclaw status', { timeout: 90000 });
  if (!status || status.includes('unreachable')) {
    return { ok: false, error: 'Gateway unreachable. Run: openclaw gateway run --force' };
  }

  // Quick agent probe — use openclawAgent to avoid cmd.exe quoting issues.
  // NOTE: the agent --timeout and the spawnSync kill timer must both be
  // generous. A cold session against a real provider (e.g. SenseNova) can
  // take ~50s end-to-end (model latency + session bootstrap + JSON payload),
  // so the previous 30s/45s pair reliably timed out and produced empty
  // stdout → false "Agent probe failed" SKIP. Bumped to 60s agent / 90s kill.
  const probeProc = openclawAgent(['--session-key', 'agent:main:main', '--message', 'reply OK', '--timeout', '60', '--json'], 90000);
  const probe = (probeProc.stdout ?? '').trim();
  if (!probe) {
    return { ok: false, error: 'Agent probe failed — no response from openclaw agent' };
  }

  return { ok: true, status, probe };
}

// ---------------------------------------------------------------------------
// Phase 2: Baseline capture
// ---------------------------------------------------------------------------

function phase2(ws) {
  const pdWs = ws;
  const canary = shJson(pdCmd('runtime canary', pdWs));
  const integrity = shJson(pdCmd('runtime internalization integrity', pdWs));
  const queue = shJson(pdCmd('runtime internalization queue', pdWs));

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

function phase3(trap, runId, timeoutSec, ws, model) {
  const sessionKey = `agent:e2e:${runId}`;
  const prompt = trap.promptTemplate(ws);

  log('3', `Driving trap with session: ${sessionKey}`);

  // Use openclawAgent (spawnSync with args array) to avoid cmd.exe quoting/newline issues.
  // cmd.exe cannot handle newlines inside double-quoted --message values,
  // which causes the command to be truncated and the agent to receive a garbled prompt.
  const args = ['--session-key', sessionKey, '--message', prompt, '--timeout', String(timeoutSec), '--json', '--local'];
  if (model) args.push('--model', model);

  const proc = openclawAgent(args, (timeoutSec + 30) * 1000, {
    cwd: ws,
    env: {
      OPENCLAW_WORKSPACE: ws,
      PD_WORKSPACE_DIR: ws,
      PD_E2E_MODE: '1',
    },
  });
  const raw = (proc.stdout ?? '').trim();
  console.log("DEBUG E2E CLI execution status:", proc.status);
  console.log("DEBUG E2E CLI execution error:", proc.error);
  if (proc.stderr) {
    console.log("DEBUG E2E CLI execution stderr:", proc.stderr.trim());
  }

  let result = null;
  try { result = JSON.parse(raw); } catch { /* non-JSON response */ }
  console.log("DEBUG E2E CLI output result keys:", Object.keys(result || {}));
  if (result?.result) {
    console.log("DEBUG E2E CLI result.result keys:", Object.keys(result.result));
    console.log("DEBUG E2E CLI result.result.toolSummary:", JSON.stringify(result.result.toolSummary));
  }

  // OpenClaw returns toolSummary as {calls, tools, failures} at result.result.meta.toolSummary.
  // Older code expected an array — handle both formats.
  const rawSummary = result?.toolSummary ?? result?.meta?.toolSummary ?? result?.result?.toolSummary ?? result?.result?.meta?.toolSummary ?? null;
  let toolCalls = [];
  let failedTools = [];

  if (rawSummary && typeof rawSummary === 'object' && !Array.isArray(rawSummary)) {
    // Object format: {calls: number, tools: string[], failures: number}
    const callCount = typeof rawSummary.calls === 'number' ? rawSummary.calls : 0;
    const failureCount = typeof rawSummary.failures === 'number' ? rawSummary.failures : 0;
    const toolNames = Array.isArray(rawSummary.tools) ? rawSummary.tools : [];
    // Reconstruct toolCalls array for backward compatibility with evidence report
    for (let i = 0; i < callCount; i++) {
      const isFailure = i >= callCount - failureCount;
      toolCalls.push({
        name: toolNames[i] ?? toolNames[0] ?? 'unknown',
        exitCode: isFailure ? 1 : 0,
        error: isFailure,
      });
    }
    failedTools = toolCalls.filter(t => t.exitCode !== 0 || t.error);
  } else if (Array.isArray(rawSummary)) {
    // Legacy array format (if ever used)
    toolCalls = rawSummary;
    failedTools = toolCalls.filter(t => t.exitCode !== 0 || t.error);
  }

  return {
    raw: raw.slice(0, 2000),
    result,
    toolCalls,
    failedTools,
    sessionKey,
    agentResponded: !!raw,
  };
}

function phase3b(trap, runId, ws, model, sessionKey) {
  if (!trap.multiTurn || !trap.followUpMessages?.length) return null;

  const followUpResults = [];

  for (let i = 0; i < trap.followUpMessages.length; i++) {
    const msg = trap.followUpMessages[i](ws);

    log('3b', `Sending follow-up ${i + 1}/${trap.followUpMessages.length}: "${msg.slice(0, 60)}..."`);

    // Use openclawAgent to avoid cmd.exe quoting/newline issues on Windows
    const args = ['--session-key', sessionKey, '--message', msg, '--timeout', '120', '--json', '--local'];
    if (model) args.push('--model', model);

    const proc = openclawAgent(args, 150000, {
      cwd: ws,
      env: {
        OPENCLAW_WORKSPACE: ws,
        PD_WORKSPACE_DIR: ws,
        PD_E2E_MODE: '1',
      },
    });

    const raw = (proc.stdout ?? '').trim();

    let result = null;
    try { result = JSON.parse(raw); } catch { /* non-JSON */ }

    followUpResults.push({
      message: msg.slice(0, 200),
      agentResponded: !!raw,
      raw: raw.slice(0, 1000),
      result,
    });

    sh('sleep 2', { timeout: 5000 });
  }

  return { followUpResults, allResponded: followUpResults.every(r => r.agentResponded) };
}

// ---------------------------------------------------------------------------
// Phase 4: Confirm real pain was emitted
// ---------------------------------------------------------------------------

function phase4(ws, sessionKey, sinceTs) {
  const pdWs = ws;
  const queue = shJson(pdCmd('runtime internalization queue', pdWs));

  const today = new Date().toISOString().slice(0, 10);
  const eventLogPaths = [
    join(pdWs, `.state/logs/events_${today}.jsonl`),
    join(pdWs, `e2e/.state/logs/events_${today}.jsonl`),
  ];
  let painEvents = [];

  for (const eventLog of eventLogPaths) {
    if (!existsSync(eventLog)) continue;
    const lines = readFileSync(eventLog, 'utf-8').split('\n').filter(Boolean);
    const found = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (e.type?.includes('pain_signal') || e.type?.includes('pain_detected')))
      .filter(e => {
        if (sinceTs) {
          const eventTs = new Date(e.ts || e.data?.ts || 0).getTime();
          return eventTs >= sinceTs;
        }
        return true;
      });
    if (found.length > 0) {
      log('4', `Found ${found.length} pain event(s) in ${eventLog}`);
      painEvents = painEvents.concat(found);
    }
  }

  const latestPain = painEvents[painEvents.length - 1];
  const provenance = latestPain?.data?.provenance ?? latestPain?.provenance ?? null;

  let evidenceEntries = [];
  let hasOwnerMessage = false;
  let hasAgentTurn = false;
  let hasToolCallFailure = false;
  const dbSearchPaths = [
    join(pdWs, '.pd', 'state.db'),
    join(pdWs, 'e2e', '.pd', 'state.db'),
    join(pdWs, '.principles', 'state.db'),
  ];
  for (const dbPath of dbSearchPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const dbResult = shJson(pdCmd('runtime internalization queue', pdWs));
      const tasks = dbResult?.tasks ?? dbResult?.pendingTasks ?? [];
      for (const task of tasks.slice(0, 3)) {
        const taskId = task.taskId ?? task.id;
        if (!taskId) continue;
        const detail = shJson(pdCmd(`task show ${taskId}`, pdWs));
        if (detail?.diagnosticJson) {
          try {
            const dj = typeof detail.diagnosticJson === 'string'
              ? JSON.parse(detail.diagnosticJson)
              : detail.diagnosticJson;
            if (Array.isArray(dj?.evidence)) {
              evidenceEntries = dj.evidence;
              hasOwnerMessage = evidenceEntries.some(e => e.sourceRef?.startsWith('owner_message:'));
              hasAgentTurn = evidenceEntries.some(e => e.sourceRef?.startsWith('agent_turn:'));
              hasToolCallFailure = evidenceEntries.some(e => e.sourceRef?.startsWith('tool_call_failure:'));
            }
          } catch { /* invalid diagnosticJson */ }
        }
      }
      if (evidenceEntries.length > 0) break;
    } catch (e) {
      log('4', `Evidence extraction note (${dbPath}): ${String(e).slice(0, 100)}`);
    }
  }

  const painSource = latestPain?.data?.source ?? latestPain?.data?.painType ?? null;

  return {
    queue,
    painEvents,
    painCount: painEvents.length,
    provenance,
    latestPain,
    painSource,
    evidenceEntries,
    hasOwnerMessage,
    hasAgentTurn,
    hasToolCallFailure,
  };
}

// ---------------------------------------------------------------------------
// Phase 5: Verify diagnosis → candidate → admission chain
// ---------------------------------------------------------------------------

function phase5(ws, sinceTs) {
  const pdWs = ws;
  const e2eWs = join(pdWs, 'e2e');
  const results = { tasks: [], candidates: [], integrity: null, canary: null, contentQuality: null };

  const dbPaths = [
    join(e2eWs, '.pd', 'state.db'),
    join(pdWs, '.pd', 'state.db'),
    join(pdWs, '.principles', 'state.db'),
  ];

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const tasksJson = sh(`node -e "const Database = require('better-sqlite3'); const db = new Database('${dbPath.replace(/\\/g, '\\\\')}', {readonly:true}); const rows = db.prepare('SELECT task_id, task_kind, status, created_at, diagnostic_json FROM tasks ORDER BY rowid DESC LIMIT 10').all(); console.log(JSON.stringify(rows));"`, { timeout: 10000 });
      const tasks = JSON.parse(tasksJson || '[]');
      for (const task of tasks) {
        let dj = null;
        try { dj = typeof task.diagnostic_json === 'string' ? JSON.parse(task.diagnostic_json) : task.diagnostic_json; } catch { /* skip */ }
        const taskTs = new Date(task.created_at || dj?.sessionIdHint || 0).getTime();
        if (sinceTs && taskTs && taskTs < sinceTs) continue;
        results.tasks.push({
          taskId: task.task_id,
          taskKind: task.task_kind,
          status: task.status,
          provenance: dj?.provenance ?? null,
          source: dj?.source ?? null,
          evidenceCount: Array.isArray(dj?.evidence) ? dj.evidence.length : 0,
          hasOwnerMessage: Array.isArray(dj?.evidence) && dj.evidence.some(e => e.sourceRef?.startsWith('owner_message:')),
          hasAgentTurn: Array.isArray(dj?.evidence) && dj.evidence.some(e => e.sourceRef?.startsWith('agent_turn:')),
          hasToolCallFailure: Array.isArray(dj?.evidence) && dj.evidence.some(e => e.sourceRef?.startsWith('tool_call_failure:')),
          diagnosticJson: dj,
        });
      }

      const candsJson = sh(`node -e "const Database = require('better-sqlite3'); const db = new Database('${dbPath.replace(/\\/g, '\\\\')}', {readonly:true}); const rows = db.prepare('SELECT candidate_id, task_id, title, description, status, recommendation_kind, abstracted_principle, trigger_pattern, action FROM principle_candidates ORDER BY rowid DESC LIMIT 10').all(); console.log(JSON.stringify(rows));"`, { timeout: 10000 });
      const candidates = JSON.parse(candsJson || '[]');
      for (const cand of candidates) {
        results.candidates.push({
          candidateId: cand.candidate_id,
          taskId: cand.task_id,
          title: cand.title,
          description: cand.description,
          status: cand.status,
          recommendationKind: cand.recommendation_kind,
          abstractedPrinciple: cand.abstracted_principle,
          triggerPattern: cand.trigger_pattern,
          action: cand.action,
        });
      }

      if (results.tasks.length > 0 || results.candidates.length > 0) break;
    } catch (e) {
      log('5', `DB query note (${dbPath}): ${String(e).slice(0, 100)}`);
    }
  }

  const PD_INTERNAL_TERMS = ['gfi', 'friction', 'threshold', 'pain_signal', 'diagnostic', 'internalization', 'provenance', 'accumulated'];
  const AGENT_BEHAVIOR_TERMS = ['file', 'edit', 'write', 'modify', 'change', 'tool', 'agent', 'action', 'behavior', 'ci', 'workflow', 'config', 'overreach', 'scope', 'boundary', 'confirm', 'user'];

  let agentBehaviorCandidateCount = 0;
  let pdInternalCandidateCount = 0;

  for (const cand of results.candidates) {
    const candidateText = `${cand.title ?? ''} ${cand.description ?? ''} ${cand.abstractedPrinciple ?? ''} ${cand.action ?? ''}`.toLowerCase();
    const isAgentBehavior = AGENT_BEHAVIOR_TERMS.some(t => candidateText.includes(t));
    const isPdInternal = PD_INTERNAL_TERMS.some(t => candidateText.includes(t)) && !isAgentBehavior;
    cand.isAgentBehavior = isAgentBehavior;
    cand.isPdInternal = isPdInternal;
    if (isAgentBehavior) agentBehaviorCandidateCount++;
    if (isPdInternal) pdInternalCandidateCount++;
  }

  results.contentQuality = {
    agentBehaviorCandidateCount,
    pdInternalCandidateCount,
    hasAgentBehaviorCandidate: agentBehaviorCandidateCount > 0,
    hasOnlyPdInternalCandidates: pdInternalCandidateCount > 0 && agentBehaviorCandidateCount === 0,
  };

  results.integrity = shJson(pdCmd('runtime internalization integrity', pdWs));
  results.canary = shJson(pdCmd('runtime canary', pdWs));

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

  // Compute verdict via the strict, unit-tested computation extracted to
  // e2e-story-a-verdict.mjs. The previous inline verdict block was removed
  // because it was unconditionally overwritten by strictResult below.
  let verdict = 'story_a_validated';
  const verdictNotes = [];

  const strictResult = computeStoryAVerdict({
    phase0Ok: phase0R.ok,
    phase0Error: phase0R.error,
    phase1Ok: phase1R.ok,
    phase1Error: phase1R.error,
    agentResponded: phase3R.agentResponded,
    painCount: phase4R.painCount,
    painSource: phase4R.painSource,
    hasOwnerMessage: phase4R.hasOwnerMessage || phase5R.tasks.some(task => task.hasOwnerMessage),
    hasAgentTurn: phase4R.hasAgentTurn || phase5R.tasks.some(task => task.hasAgentTurn),
    hasToolCallFailure: phase4R.hasToolCallFailure || phase5R.tasks.some(task => task.hasToolCallFailure),
    tasks: phase5R.tasks,
    candidates: phase5R.candidates,
    integrityStatus: phase5R.integrity?.overallStatus,
    canaryStatus: phase5R.canary?.overallStatus,
  });
  verdict = strictResult.verdict;
  verdictNotes.splice(0, verdictNotes.length, ...strictResult.notes);

  if (phase4R.hasOwnerMessage || phase5R.tasks.some(t => t.hasOwnerMessage)) {
    verdictNotes.push('Evidence contains owner_message (P0 fix verified)');
  } else if (phase4R.painCount > 0) {
    verdictNotes.push('Evidence missing owner_message (P0 fix may not be working for this path)');
  }
  if (phase4R.hasAgentTurn || phase5R.tasks.some(t => t.hasAgentTurn)) {
    verdictNotes.push('Evidence contains agent_turn (P0 fix verified)');
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
- **Pain source**: ${phase4R.painSource ?? 'unknown'}
- **Expected**: \`openclaw_context_bound\`
- **Provenance correct**: ${phase4R.provenance === 'openclaw_context_bound' ? '✅ YES' : '❌ NO'}
- **Evidence entries**: ${phase4R.evidenceEntries?.length ?? 0}
- **Has owner_message**: ${phase4R.hasOwnerMessage ? '✅ YES' : '❌ NO'}
- **Has agent_turn**: ${phase4R.hasAgentTurn ? '✅ YES' : '❌ NO'}
${(phase4R.evidenceEntries?.length ?? 0) > 0 ? `\n### Evidence Detail\n${phase4R.evidenceEntries.map(e => `- \`${e.sourceRef}\`: ${e.note?.slice(0, 100) ?? '(empty)'}`).join('\n')}` : ''}

## Phase 5: Diagnosis → Candidate → Admission Chain

### Tasks (${phase5R.tasks.length})
${phase5R.tasks.map(t => `- \`${t.taskId}\`: status=${t.status}, provenance=${t.provenance ?? 'null'}, source=${t.source ?? 'null'}, evidence=${t.evidenceCount ?? 0}${t.hasAgentTurn ? ' [has_agent_turn]' : ''}`).join('\n') || '(none)'}

### Candidates (${phase5R.candidates.length})
${phase5R.candidates.map(c => `- \`${c.candidateId}\`: status=${c.status}, kind=${c.recommendationKind ?? 'N/A'}${c.title ? `, title="${c.title.slice(0, 80)}"` : ''}${c.isAgentBehavior ? ' [agent-behavior]' : ''}${c.isPdInternal ? ' [PD-internal]' : ''}`).join('\n') || '(none)'}

### Content Quality
- **Agent behavior candidates**: ${phase5R.contentQuality?.agentBehaviorCandidateCount ?? 0}
- **PD internal candidates**: ${phase5R.contentQuality?.pdInternalCandidateCount ?? 0}
- **Has agent-behavior candidate**: ${phase5R.contentQuality?.hasAgentBehaviorCandidate ? '✅ YES' : '❌ NO'}
- **Only PD-internal candidates**: ${phase5R.contentQuality?.hasOnlyPdInternalCandidates ? '❌ YES (bad)' : 'NO (good)'}

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
  --model, -m       Model override (e.g. lmstudio/qwen3.6-27b-mtp)
  --help, -h        Show this help

Traps:
  trap-00  Overreaching agent (empathy/GFI trigger, multi-turn)
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
    const { filePath, verdict } = generateEvidence({
      runId, trap,
      phase0R, phase1R,
      phase2R: { canary: null, integrity: null, queue: null, candidateCount: 0, ledgerEntryCount: 0 },
      phase3R: { raw: '', result: null, toolCalls: [], failedTools: [], sessionKey: '', agentResponded: false },
      phase4R: { queue: null, painEvents: [], painCount: 0, provenance: null, latestPain: null },
      phase5R: { tasks: [], candidates: [], integrity: null, canary: null },
    });
    console.log(`\nSKIP: Environment unavailable. Evidence: ${filePath}`);
    process.exit(exitCodeForStoryAVerdict(verdict));
  }
  pass('1', 'Gateway reachable, agent responsive');

  // Phase 2
  log('2', 'Capturing baseline...');
  const phase2R = phase2(phase0R.ws);
  pass('2', `Canary=${phase2R.canary?.overallStatus}, Integrity=${phase2R.integrity?.overallStatus}, Queue candidates=${phase2R.candidateCount}`);

  // Phase 3
  log('3', `Driving trap task (${trap.name})${opts.model ? ` [model: ${opts.model}]` : ''}...`);
  const phase3StartTime = Date.now();
  const phase3R = phase3(trap, runId, opts.timeout, phase0R.ws, opts.model);
  if (!phase3R.agentResponded) {
    fail('3', 'Agent did not respond');
  } else {
    pass('3', `Agent responded, ${phase3R.toolCalls.length} tool calls, ${phase3R.failedTools.length} failed`);
  }

  // Phase 3b: Multi-turn follow-up (for empathy/GFI traps)
  let phase3bR = null;
  if (trap.multiTurn && phase3R.agentResponded) {
    log('3b', `Sending ${trap.followUpMessages.length} follow-up messages (empathy trigger)...`);
    phase3bR = phase3b(trap, runId, phase0R.ws, opts.model, phase3R.sessionKey);
    if (phase3bR?.allResponded) {
      pass('3b', `All ${trap.followUpMessages.length} follow-ups responded`);
    } else {
      fail('3b', 'Not all follow-ups got responses');
    }
  }

  // Phase 4
  log('4', 'Checking pain emission...');
  let phase4R = null;
  const phase4MaxWaitMs = 90000;
  const phase4PollIntervalMs = 5000;
  const phase4Start = Date.now();
  while (Date.now() - phase4Start < phase4MaxWaitMs) {
    sh('sleep 5', { timeout: 10000 });
    phase4R = phase4(phase0R.ws, phase3R.sessionKey, phase3StartTime);
    if (phase4R.painCount > 0) break;
    log('4', `No pain yet, polling... (${Math.round((Date.now() - phase4Start) / 1000)}s elapsed)`);
  }
  if (phase4R.painCount === 0) {
    fail('4', 'No pain events found after 90s — trap did not trigger a pain signal');
  } else if (phase4R.painSource === 'user_empathy') {
    pass('4', `Pain emitted, source=user_empathy (${phase4R.painCount} events)`);
  } else {
    pass('4', `Pain emitted, source=${phase4R.painSource} (${phase4R.painCount} events)`);
  }
  if (phase4R.hasOwnerMessage) {
    pass('4', 'Evidence contains owner_message (P0 fix working)');
  }
  if (phase4R.hasAgentTurn) {
    pass('4', 'Evidence contains agent_turn (P0 fix working)');
  }

  // Phase 5
  log('5', 'Verifying diagnosis → candidate → admission chain...');
  let phase5R = null;
  const phase5MaxWaitMs = 120000;
  const phase5Start = Date.now();
  while (Date.now() - phase5Start < phase5MaxWaitMs) {
    phase5R = phase5(phase0R.ws, phase3StartTime);
    if (phase5R.tasks.length > 0 || phase5R.candidates.length > 0) break;
    sh('sleep 5', { timeout: 10000 });
    log('5', `No tasks/candidates yet, polling... (${Math.round((Date.now() - phase5Start) / 1000)}s elapsed)`);
  }
  pass('5', `Tasks=${phase5R.tasks.length}, Candidates=${phase5R.candidates.length}, Integrity=${phase5R.integrity?.overallStatus}`);
  if (phase5R.contentQuality?.hasAgentBehaviorCandidate) {
    pass('5', `Content quality: ${phase5R.contentQuality.agentBehaviorCandidateCount} candidate(s) about agent behavior`);
  }
  if (phase5R.contentQuality?.hasOnlyPdInternalCandidates) {
    fail('5', 'Content quality: all candidates are about PD internals (not agent behavior)');
  }

  log('7', 'Generating evidence report...');
  const { filePath, verdict } = generateEvidence({
    runId, trap, phase0R, phase1R, phase2R, phase3R, phase4R, phase5R,
  });

  if (phase3bR) {
    log('7', `Phase 3b: ${phase3bR.followUpResults.length} follow-ups sent`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`VERDICT: ${verdict}`);
  console.log(`EVIDENCE: ${filePath}`);
  console.log('═'.repeat(60));

  process.exit(exitCodeForStoryAVerdict(verdict));
}

main().catch(e => {
  console.error('Harness error:', e);
  process.exit(1);
});
