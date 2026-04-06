// Packaged AI sprint orchestrator entrypoint.
// Source of truth remains D:/Code/principles/scripts/ai-sprint-orchestrator/run.mjs.
// Keep this package-local copy in sync only for package CLI, validation, and runtime-layout changes.

import { spawnSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { decideStage, buildStageMetrics, buildHandoff } from './lib/decision.mjs';
import { ensureDir, appendText, fileExists, readJson, writeJson, writeText } from './lib/state-store.mjs';
import { buildRolePrompt, buildStageBrief, getTaskSpec } from './lib/task-specs.mjs';
import { archiveRunById } from './lib/archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const referencesRoot = path.join(packageRoot, 'references');
const defaultRuntimeRoot = path.join(packageRoot, 'runtime');
let runtimeRoot = process.env.AI_SPRINT_RUNTIME_ROOT
  ? path.resolve(process.env.AI_SPRINT_RUNTIME_ROOT)
  : defaultRuntimeRoot;
let sprintRoot = path.join(runtimeRoot, 'runs');
let tempRoot = path.join(runtimeRoot, 'tmp');
// Resolve acpx binary path and node executable — spawn directly via node to avoid
// shebang/env resolution issues when cron/nohup has a minimal PATH.
const acpxBin = (() => {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['acpx'], { encoding: 'utf8' });
  if (r.status === 0) {
    const lines = r.stdout.trim().split(/\r?\n/);
    const symlink = lines[0].trim();
    try {
      return fs.realpathSync(symlink);
    } catch {
      return symlink;
    }
  }
  return 'acpx';
})();
const nodeBin = process.execPath; // e.g. /usr/bin/node — reliable, no PATH search needed
// Extended env for detached child processes.
// Linux: includes /usr/bin so the Node.js shebang (#!/usr/bin/env node) resolves
// correctly even when cron/nohup has a minimal PATH.
// Windows: inherit PATH as-is — nodeBin is absolute, no PATH search needed.
const acpxEnv = process.platform === 'win32'
  ? { ...process.env }
  : {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/usr/bin:/bin`,
    };

// On Linux, ignore SIGHUP so SSH disconnect doesn't kill the orchestrator.
// Skip in test environments to avoid interfering with test signal handling.
if (process.platform !== 'win32' && !process.env.VITEST && process.env.NODE_ENV !== 'test') {
  process.on('SIGHUP', () => { /* ignored — survive SSH disconnect */ });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function configureRuntimeRoots(rootPath) {
  runtimeRoot = path.resolve(rootPath);
  sprintRoot = path.join(runtimeRoot, 'runs');
  tempRoot = path.join(runtimeRoot, 'tmp');
  process.env.AI_SPRINT_RUNTIME_ROOT = runtimeRoot;
}

function checkAcpxAvailable() {
  return process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'acpx --version'], {
        encoding: 'utf8',
        shell: false,
        timeout: 10_000,
      })
    : spawnSync(nodeBin, [acpxBin, '--version'], {
        encoding: 'utf8',
        shell: false,
        timeout: 10_000,
      });
}

function runSelfCheck() {
  ensureDir(runtimeRoot);
  ensureDir(sprintRoot);
  ensureDir(tempRoot);

  const checks = [];
  const record = (name, ok, details) => {
    checks.push({ name, ok, details });
  };

  record('package_root_exists', fileExists(packageRoot), packageRoot);
  record('references_root_exists', fileExists(referencesRoot), referencesRoot);
  record('runtime_root_exists', fileExists(runtimeRoot), runtimeRoot);
  record('agent_registry_exists', fileExists(path.join(referencesRoot, 'agent-registry.json')), path.join(referencesRoot, 'agent-registry.json'));

  const builtInSpecs = [
    'workflow-validation-minimal',
    'workflow-validation-minimal-verify',
  ];
  for (const specId of builtInSpecs) {
    try {
      const spec = getTaskSpec(specId, null);
      record(`spec:${specId}`, true, spec.title);
    } catch (err) {
      record(`spec:${specId}`, false, err.message);
    }
  }

  const acpxCheck = checkAcpxAvailable();
  record('acpx_available', acpxCheck.status === 0, (acpxCheck.stdout || acpxCheck.stderr || '').trim() || `status=${acpxCheck.status}`);

  const probePath = path.join(runtimeRoot, '.self-check-write-probe.tmp');
  try {
    fs.writeFileSync(probePath, 'ok', 'utf8');
    fs.rmSync(probePath, { force: true });
    record('runtime_root_writable', true, runtimeRoot);
  } catch (err) {
    record('runtime_root_writable', false, err.message);
  }

  const failed = checks.filter((check) => !check.ok);
  const lines = [
    'AI Sprint Orchestrator Self Check',
    '',
    `Package root: ${packageRoot}`,
    `Runtime root: ${runtimeRoot}`,
    '',
    ...checks.map((check) => `${check.ok ? '[OK]' : '[FAIL]'} ${check.name}: ${check.details}`),
  ];
  console.log(lines.join('\n'));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function makeRunId(taskId) {
  const stamp = nowIso().replace(/[:.]/g, '-');
  return `${stamp}-${slugify(taskId)}`;
}

function createSprintState(spec, runId, specPath) {
  return {
    runId,
    taskId: spec.id,
    title: spec.title,
    specPath: specPath || null,
    status: 'running',
    currentStageIndex: 0,
    currentStage: spec.stages[0],
    currentRound: 1,
    maxRoundsPerStage: spec.maxRoundsPerStage,
    maxRuntimeMinutes: spec.maxRuntimeMinutes,
    staleAfterMs: spec.staleAfterMs ?? 5 * 60 * 1000,
    orchestratorPid: process.pid,
    lastHeartbeatAt: nowIso(),
    currentRole: null,
    haltReason: null,
    mergePending: null,
    worktree: null,  // { worktreePath, branchName, headSha, baseBranch } — set by ensureWorktree
    consecutiveTimeouts: {}, // { stageName: count } — tracks consecutive timeouts per stage
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function loadOrInitState(args) {
  ensureDir(sprintRoot);

  if (args.resume) {
    const runDir = path.join(sprintRoot, args.resume);
    const sprintFile = path.join(runDir, 'sprint.json');
    if (!fileExists(sprintFile)) {
      throw new Error(`Run not found: ${args.resume}`);
    }
    const state = reconcileRunState(runDir, readJson(sprintFile));
    if (state.status === 'halted' || state.status === 'aborted') {
      // Validate: if halted mid-stage, the previous stage must have advanced
      // Special case: implement-pass-1 revise → implement-pass-2 is valid routing
      if (state.currentStageIndex > 0) {
        const prevStageName = loadSpec(state, args).stages[state.currentStageIndex - 1];
        const prevDecisionPath = path.join(runDir, 'stages', `${String(state.currentStageIndex).padStart(2, '0')}-${prevStageName}`, 'decision.md');
        if (fileExists(prevDecisionPath)) {
          const prevDecisionText = fs.readFileSync(prevDecisionPath, 'utf8');
          const outcomeMatch = prevDecisionText.match(/Outcome:\s*(\w+)/);
          if (outcomeMatch && outcomeMatch[1] !== 'advance') {
            // Check for special routing: implement-pass-1 revise → implement-pass-2
            const isSpecialRoute = state.currentStage === 'implement-pass-2' && prevStageName === 'implement-pass-1' && outcomeMatch[1] === 'revise';
            if (!isSpecialRoute) {
              throw new Error(`Cannot resume: previous stage "${prevStageName}" outcome was "${outcomeMatch[1]}" (expected "advance"). Fix the previous stage first.`);
            }
          }
        }
      }
      const previousStatus = state.status;
      state.status = 'running';
      state.haltReason = null;
      state.orchestratorPid = process.pid;
      state.lastHeartbeatAt = nowIso();
      state.updatedAt = nowIso();
      // Refresh maxRoundsPerStage from spec in case spec was updated since the sprint started
      const spec = loadSpec(state, args);
      if (spec.maxRoundsPerStage !== undefined && spec.maxRoundsPerStage !== state.maxRoundsPerStage) {
        appendTimeline(runDir, `maxRoundsPerStage updated from spec: ${state.maxRoundsPerStage} → ${spec.maxRoundsPerStage}`);
        state.maxRoundsPerStage = spec.maxRoundsPerStage;
      }
      writeJson(sprintFile, state);
      appendTimeline(runDir, `Sprint resumed from ${previousStatus} by operator`);
    }
    return { runDir, state, resumed: true };
  }

  if (!args.task) {
    throw new Error('Missing required --task <task-id>');
  }

  const spec = getTaskSpec(args.task, args.taskSpec);
  const runId = makeRunId(spec.id);
  const runDir = path.join(sprintRoot, runId);
  const state = createSprintState(spec, runId, args.taskSpec);
  ensureDir(runDir);
  writeJson(path.join(runDir, 'sprint.json'), state);
  writeText(path.join(runDir, 'timeline.md'), `# Timeline\n\n- ${nowIso()} Created sprint ${runId}\n`);
  writeText(path.join(runDir, 'latest-summary.md'), `# Latest Summary\n\n- Status: ${state.status}\n- Stage: ${state.currentStage}\n- Round: ${state.currentRound}\n`);
  return { runDir, state, resumed: false };
}

function saveState(runDir, state) {
  state.updatedAt = nowIso();
  writeJson(path.join(runDir, 'sprint.json'), state);
}

function heartbeatState(runDir, state, patch = {}) {
  Object.assign(state, patch, {
    orchestratorPid: process.pid,
    lastHeartbeatAt: nowIso(),
  });
  saveState(runDir, state);
}

function updateSummary(runDir, lines) {
  writeText(path.join(runDir, 'latest-summary.md'), `# Latest Summary\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
}

function inferFailureClassification({ summary = '', blockers = [], reviewerTimeouts = null, reviewerViolations = null }) {
  const combined = [summary, ...(blockers ?? [])].join(' ').toLowerCase();

  if (/acpx|path|enoent|eacces|eprem|permission|writable|runtime root|command not found|not available/.test(combined)) {
    return {
      failureClassification: 'environment issue',
      failureSource: 'runtime environment',
      recommendedNextAction: 'Repair the environment or required binaries, then rerun self-check and validation.',
    };
  }

  if (/sample-spec|product-side|sample-side|openclaw-plugin|d:\\code\\openclaw|integrationphase|branchworkspace/.test(combined)) {
    return {
      failureClassification: 'sample-spec issue',
      failureSource: 'sample/spec contract',
      recommendedNextAction: 'Classify and stop. Do not reopen product-side closure work in this workflow milestone.',
    };
  }

  if ((reviewerTimeouts?.length ?? 0) > 0 || (reviewerViolations?.length ?? 0) > 0 || /missing reports|schema violation|report invalidated|timed out|agent .*failed|verdict|dimensions/.test(combined)) {
    return {
      failureClassification: 'agent behavior issue',
      failureSource: 'role execution or report quality',
      recommendedNextAction: 'Adjust agent profile, fallback, or prompt discipline; do not treat this as a product-side bug.',
    };
  }

  return {
    failureClassification: 'workflow bug',
    failureSource: 'orchestrator runtime',
    recommendedNextAction: 'Fix the workflow plumbing, persistence, or artifact layout before retrying.',
  };
}

function updateSummaryWithClassification(runDir, lines, classification = null) {
  const enriched = [...lines];
  if (classification?.failureClassification) {
    enriched.push(`Failure classification: ${classification.failureClassification}`);
    enriched.push(`Failure source: ${classification.failureSource}`);
    enriched.push(`Recommended next action: ${classification.recommendedNextAction}`);
  }
  updateSummary(runDir, enriched);
}

function readStageFailureClassification(runDir, state) {
  try {
    const stageDirName = `${String(state.currentStageIndex + 1).padStart(2, '0')}-${state.currentStage}`;
    const scorecardPath = path.join(runDir, 'stages', stageDirName, 'scorecard.json');
    if (!fileExists(scorecardPath)) return null;
    const scorecard = readJson(scorecardPath);
    if (!scorecard?.failureClassification) return null;
    return {
      failureClassification: scorecard.failureClassification,
      failureSource: scorecard.failureSource ?? 'n/a',
      recommendedNextAction: scorecard.recommendedNextAction ?? 'n/a',
    };
  } catch {
    return null;
  }
}

function extractEvidenceFiles(reportText) {
  if (!reportText) return [];
  const matches = [
    ...reportText.matchAll(/files_(?:checked|verified):\s*([^\n]+)/gi),
  ];
  return matches
    .flatMap((match) => match[1].split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function writeCheckpointSummary(stageDir, { decision, handoff = null, producer = '', reviewerA = '', reviewerB = '', globalReviewer = '' }) {
  const verifiedFiles = Array.from(new Set([
    ...extractEvidenceFiles(producer),
    ...extractEvidenceFiles(reviewerA),
    ...extractEvidenceFiles(reviewerB),
    ...extractEvidenceFiles(globalReviewer),
  ]));
  const accomplished = handoff?.contractItems?.filter((item) => item.status === 'DONE').map((item) => item.deliverable) ?? [];
  const blockers = decision.blockers?.length ? decision.blockers : ['None.'];
  const nextFocus = handoff?.focusForNextRound
    ?? decision.nextRunRecommendation?.reasons?.[0]
    ?? decision.summary;
  const lines = [
    '## Accomplished',
    ...(accomplished.length ? accomplished.map((item) => `- ${item}`) : ['- No contract deliverables were marked DONE in this round.']),
    '',
    '## Blockers',
    ...blockers.map((item) => `- ${item}`),
    '',
    '## Next Focus',
    nextFocus,
    '',
    '## Verified Files',
    ...(verifiedFiles.length ? verifiedFiles.map((item) => `- ${item}`) : ['- None recorded.']),
  ];
  writeText(path.join(stageDir, 'checkpoint-summary.md'), `${lines.join('\n')}\n`);
}

function writeStageFailureArtifacts({ runDir, state, stageName, stageDir, decisionPath, scorecardPath, summary, blockers = [] }) {
  const failure = inferFailureClassification({ summary, blockers });
  writeText(decisionPath, [
    '# Decision',
    '',
    `- Stage: ${stageName}`,
    `- Round: ${state.currentRound}`,
    '- Outcome: error',
    '',
    '## Summary',
    summary,
    '',
    '## Blockers',
    ...(blockers.length ? blockers.map((item) => `- ${item}`) : ['- None.']),
    '',
    '## Failure Classification',
    `- Type: ${failure.failureClassification}`,
    `- Source: ${failure.failureSource}`,
    `- Recommended Next Action: ${failure.recommendedNextAction}`,
    '',
  ].join('\n'));
  writeJson(scorecardPath, {
    stage: stageName,
    round: state.currentRound,
    outcome: 'error',
    summary,
    blockers,
    failureClassification: failure.failureClassification,
    failureSource: failure.failureSource,
    recommendedNextAction: failure.recommendedNextAction,
    updatedAt: nowIso(),
  });
  updateSummaryWithClassification(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    `Halt reason: ${summary}`,
  ], failure);
}

const MAX_TIMELINE_LINES = 500;

function appendTimeline(runDir, line) {
  const tlPath = path.join(runDir, 'timeline.md');
  appendText(tlPath, `- ${nowIso()} ${line}\n`);

  // Rotate if too long
  if (fileExists(tlPath)) {
    const content = fs.readFileSync(tlPath, 'utf8');
    const lineCount = content.split('\n').filter((l) => l.startsWith('- ')).length;
    if (lineCount > MAX_TIMELINE_LINES) {
      const archivePath = path.join(runDir, 'timeline-archive.md');
      appendText(archivePath, content);
      const lines = content.split('\n').filter((l) => l.startsWith('- '));
      const kept = lines.slice(-300);
      writeText(tlPath, `# Timeline (archived ${lineCount - 300} older entries)\n\n${kept.join('\n')}\n`);
    }
  }
}

function runAgent({ cwd, agent, model, prompt, timeoutSeconds = 1800, failLogPath = null, promptDir = cwd, runDir = null, roleLabel = agent }) {
  // promptDir (default=cwd) is where we write the prompt file; must exist and be writable.
  // On Windows, avoid os.tmpdir() (short ~ paths) and non-existent branchWorkspace dirs.
  const promptFile = path.join(promptDir, `.ai-sprint-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  let result;
  try {
    if (process.platform === 'win32') {
      result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `acpx --cwd $env:AI_SPRINT_CWD --approve-all --model $env:AI_SPRINT_MODEL --timeout $env:AI_SPRINT_TIMEOUT ${agent} exec -f $env:AI_SPRINT_PROMPT`,
        ],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: (timeoutSeconds + 60) * 1000,
          shell: false,
          env: {
            ...process.env,
            AI_SPRINT_CWD: cwd,
            AI_SPRINT_MODEL: model,
            AI_SPRINT_TIMEOUT: String(timeoutSeconds),
            AI_SPRINT_PROMPT: promptFile,
          },
        },
      );
    } else {
      result = spawnSync(
        nodeBin,
        [acpxBin, '--cwd', cwd, '--approve-all', '--model', model, '--timeout', String(timeoutSeconds), '--prompt-retries', '2', '--suppress-reads', agent, 'exec', '-f', promptFile],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: (timeoutSeconds + 60) * 1000,
          shell: false,
          // Detach child process into its own session group so SIGHUP
          // from SSH disconnect doesn't propagate to agent processes.
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: acpxEnv,
        },
      );
      // Fallback if resolved path is stale (e.g., npm package updated between module load and spawn)
      if (result.error && result.error.code === 'ENOENT') {
        result = spawnSync(
          nodeBin,
          [acpxBin, '--cwd', cwd, '--approve-all', '--model', model, '--timeout', String(timeoutSeconds), '--prompt-retries', '2', '--suppress-reads', agent, 'exec', '-f', promptFile],
          {
            cwd,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: (timeoutSeconds + 60) * 1000,
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: acpxEnv,
          },
        );
      }
    }
  } finally {
    fs.rmSync(promptFile, { force: true });
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error || result.status !== 0) {
    // Map acpx exit codes to semantic error types for better error classification:
    //   0  = success
    //   1  = runtime error (agent crash, ACP failure)
    //   2  = usage error (bad flags, missing prompt)
    //   3  = timeout (acpx --timeout exceeded)
    //   4  = no session (session lost/closed)
    //   5  = permission denied (agent approval rejected)
    //   130 = interrupted (SIGINT/SIGHUP — SSH disconnect)
    const exitCode = result.status ?? 1;
    const errorType = exitCode === 3 ? 'timeout'
      : exitCode === 4 ? 'no_session'
        : exitCode === 5 ? 'permission_denied'
          : exitCode === 130 ? 'interrupted'
            : exitCode === 2 ? 'usage_error'
              : 'runtime_error';

    if ((result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') && result.pid) {
      terminateProcessTree(result.pid, { runDir, label: roleLabel });
    }
    if (failLogPath) {
      ensureDir(path.dirname(failLogPath));
      writeText(failLogPath, `# Agent Failure Log\n\n- agent: ${agent}\n- model: ${model}\n- exitStatus: ${result.status ?? 'N/A'}\n- exitCode: ${exitCode}\n- errorType: ${errorType}\n- error: ${result.error?.message ?? 'none'}\n\n## stdout\n\n${stdout}\n\n## stderr\n\n${stderr}\n`);
    }
    if (result.error) throw result.error;
    throw Object.assign(new Error(`Agent ${agent} failed with status ${result.status} (${errorType})\n${stdout.slice(0, 2000)}\n${stderr.slice(0, 2000)}`), {
      acpxExitCode: exitCode,
      acpxErrorType: errorType,
    });
  }

  return stdout.trim();
}

/**
 * Async agent runner using spawn (non-blocking) — used for parallel reviewer execution.
 * Returns a Promise that resolves with { stdout, stderr, status } or rejects on error.
 */
function runAgentAsync({ cwd, agent, model, prompt, timeoutSeconds = 1800, promptDir = cwd, runDir = null, roleLabel = agent, onSpawn = null }) {
  return new Promise((resolve, reject) => {
    const promptFile = path.join(promptDir, `.ai-sprint-prompt-${process.pid}-${crypto.randomUUID()}.txt`);

    const cleanup = () => {
      try { fs.rmSync(promptFile, { force: true }); } catch {}
    };

    try {
      fs.writeFileSync(promptFile, prompt, 'utf8');
    } catch (writeErr) {
      reject(new Error(`Failed to write prompt file: ${writeErr.message}`));
      return;
    }

    const timeoutMs = (timeoutSeconds + 60) * 1000;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let proc;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        terminateProcessTree(proc?.pid, { runDir, label: roleLabel });
        reject(new Error(`Agent ${agent} timed out after ${timeoutSeconds}s`));
      }
    }, timeoutMs);

    try {
      if (process.platform === 'win32') {
        proc = spawn('powershell.exe', [
          '-NoProfile', '-Command',
          `acpx --cwd $env:AI_SPRINT_CWD --approve-all --model $env:AI_SPRINT_MODEL --timeout $env:AI_SPRINT_TIMEOUT ${agent} exec -f $env:AI_SPRINT_PROMPT`,
        ], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          shell: false,
          env: {
            ...process.env,
            AI_SPRINT_CWD: cwd,
            AI_SPRINT_MODEL: model,
            AI_SPRINT_TIMEOUT: String(timeoutSeconds),
            AI_SPRINT_PROMPT: promptFile,
          },
        });
      } else {
        try {
          proc = spawn(nodeBin, [acpxBin,
            '--cwd', cwd, '--approve-all', '--model', model,
            '--timeout', String(timeoutSeconds), '--prompt-retries', '2', '--suppress-reads', agent, 'exec', '-f', promptFile,
          ], {
            cwd,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: acpxEnv,
          });
        } catch (enoentErr) {
          // Fallback if resolved path is stale
          if (enoentErr.code === 'ENOENT') {
            proc = spawn(nodeBin, [acpxBin,
              '--cwd', cwd, '--approve-all', '--model', model,
              '--timeout', String(timeoutSeconds), '--prompt-retries', '2', '--suppress-reads', agent, 'exec', '-f', promptFile,
            ], {
              cwd,
              encoding: 'utf8',
              maxBuffer: 10 * 1024 * 1024,
              shell: false,
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe'],
              env: acpxEnv,
            });
          } else {
            throw enoentErr;
          }
        }
      }
      if (proc?.pid && onSpawn) onSpawn(proc.pid);
    } catch (spawnErr) {
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Failed to spawn agent ${agent}: ${spawnErr.message}`));
      return;
    }

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    // Use 'exit' instead of 'close' — on Windows, powershell.exe child process chains
    // may keep stdio pipes open after exit, causing 'close' to never fire.
    // 'exit' fires when the process exits regardless of stdio pipe state.
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // Read any remaining buffered stdout/stderr before resolving
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status: code });
      }
    });
    // Cleanup prompt file on close (stdio fully drained) — separate from resolve
    proc.on('close', () => {
      cleanup();
    });
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    });
  });
}

/**
 * Check if there's progress evidence in the last N seconds.
 * Progress signals:
 * 1. Worklog file updated recently
 * 2. Target directory has file modifications
 * 3. Stdout has new content (tracked externally)
 */
function checkProgressEvidence({ worktreePath, worklogPath, lastStdoutLength, currentStdout, lookbackSeconds = 120 }) {
  const now = Date.now();
  const lookbackMs = lookbackSeconds * 1000;
  const signals = [];

  // Check worklog file mtime
  if (worklogPath && fileExists(worklogPath)) {
    try {
      const stat = fs.statSync(worklogPath);
      if (now - stat.mtimeMs < lookbackMs) {
        signals.push({ type: 'worklog_updated', age: Math.round((now - stat.mtimeMs) / 1000) });
      }
    } catch {}
  }

  // Check for new stdout content
  if (lastStdoutLength !== undefined && currentStdout !== undefined) {
    if (currentStdout.length > lastStdoutLength) {
      signals.push({ type: 'stdout_grew', delta: currentStdout.length - lastStdoutLength });
    }
  }

  // Check target directory for recent modifications
  if (worktreePath && fileExists(worktreePath)) {
    try {
      const result = spawnSync('git', ['diff', '--name-only', '--since', `${lookbackSeconds}.seconds.ago`], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const changedFiles = (result.stdout ?? '').trim().split('\n').filter(Boolean);
      if (changedFiles.length > 0) {
        signals.push({ type: 'files_changed', count: changedFiles.length, files: changedFiles.slice(0, 3) });
      }
    } catch {}
  }

  return {
    hasProgress: signals.length > 0,
    signals,
  };
}

/**
 * Async agent runner with progress-based timeout extension.
 * 
 * Implements soft/hard timeout model:
 * - softTimeout: check for progress, extend if evidence found
 * - hardTimeout: force terminate regardless of progress
 * - maxExtensions: limit total extensions to prevent infinite loops
 */
function runAgentWithProgressCheck({
  cwd,
  agent,
  model,
  prompt,
  timeoutSeconds = 1800,
  promptDir = cwd,
  runDir = null,
  roleLabel = agent,
  worktreePath = null,
  worklogPath = null,
  softTimeoutRatio = 0.67,  // soft timeout at 67% of hard timeout
  extensionSeconds = null,  // defaults to a timeout-scaled extension window
  maxExtensions = 2,        // max 2 extensions unless caller overrides
  progressCheckIntervalSeconds = 60,
}) {
  return new Promise((resolve, reject) => {
    const scaledExtensionSeconds = extensionSeconds ?? Math.max(30, Math.min(300, Math.floor(timeoutSeconds / 2)));
    const hardTimeoutSeconds = timeoutSeconds + (scaledExtensionSeconds * maxExtensions);
    const softTimeoutSeconds = Math.floor(timeoutSeconds * softTimeoutRatio);
    
    let extensionsUsed = 0;
    let lastStdoutLength = 0;
    let lastProgressCheck = Date.now();
    let settled = false;
    let proc = null;
    let stdout = '';
    let stderr = '';

    const promptFile = path.join(promptDir, `.ai-sprint-prompt-${process.pid}-${crypto.randomUUID()}.txt`);

    const cleanup = () => {
      try { fs.rmSync(promptFile, { force: true }); } catch {}
    };

    try {
      fs.writeFileSync(promptFile, prompt, 'utf8');
    } catch (writeErr) {
      reject(new Error(`Failed to write prompt file: ${writeErr.message}`));
      return;
    }

    // Hard timeout - absolute maximum
    const hardTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearTimeout(softTimer);
        clearTimeout(progressTimer);
        cleanup();
        terminateProcessTree(proc?.pid, { runDir, label: roleLabel });
        reject(new Error(`Agent ${agent} hard timeout after ${hardTimeoutSeconds}s (extended ${extensionsUsed} times)`));
      }
    }, hardTimeoutSeconds * 1000);

    // Soft timeout - check progress and maybe extend
    let softTimer;
    const setupSoftTimeout = (seconds) => {
      clearTimeout(softTimer);
      softTimer = setTimeout(() => {
        if (settled) return;
        
        const progress = checkProgressEvidence({
          worktreePath,
          worklogPath,
          lastStdoutLength,
          currentStdout: stdout,
          lookbackSeconds: 120,
        });

        if (progress.hasProgress && extensionsUsed < maxExtensions) {
          extensionsUsed++;
          lastStdoutLength = stdout.length;
          if (runDir) {
            appendTimeline(runDir, `Soft timeout: progress detected for ${roleLabel}, extending by ${scaledExtensionSeconds}s (${progress.signals.map(s => s.type).join(', ')})`);
          }
          setupSoftTimeout(scaledExtensionSeconds);
        } else {
          // No progress or max extensions reached - this becomes effective timeout
          // But don't terminate yet - let hard timeout handle it
          if (runDir && extensionsUsed >= maxExtensions) {
            appendTimeline(runDir, `Soft timeout: max extensions (${maxExtensions}) reached for ${roleLabel}, waiting for hard timeout`);
          } else if (runDir) {
            appendTimeline(runDir, `Soft timeout: no progress detected for ${roleLabel}, waiting for hard timeout`);
          }
        }
      }, seconds * 1000);
    };

    // Progress monitoring timer
    let progressTimer;
    const setupProgressMonitor = () => {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        if (settled) return;
        
        const progress = checkProgressEvidence({
          worktreePath,
          worklogPath,
          lastStdoutLength,
          currentStdout: stdout,
          lookbackSeconds: 60,
        });
        
        if (progress.hasProgress) {
          lastStdoutLength = stdout.length;
        }
        
        if (!settled) setupProgressMonitor();
      }, progressCheckIntervalSeconds * 1000);
    };

    // Spawn the agent process
    try {
      if (process.platform === 'win32') {
        proc = spawn('powershell.exe', [
          '-NoProfile', '-Command',
          `acpx --cwd $env:AI_SPRINT_CWD --approve-all --model $env:AI_SPRINT_MODEL --timeout $env:AI_SPRINT_TIMEOUT ${agent} exec -f $env:AI_SPRINT_PROMPT`,
        ], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          shell: false,
          env: {
            ...process.env,
            AI_SPRINT_CWD: cwd,
            AI_SPRINT_MODEL: model,
            AI_SPRINT_TIMEOUT: String(hardTimeoutSeconds),
            AI_SPRINT_PROMPT: promptFile,
          },
        });
      } else {
        try {
          proc = spawn(nodeBin, [acpxBin,
            '--cwd', cwd, '--approve-all', '--model', model,
            '--timeout', String(hardTimeoutSeconds), '--prompt-retries', '2', '--suppress-reads', agent, 'exec', '-f', promptFile,
          ], {
            cwd,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            shell: false,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: acpxEnv,
          });
        } catch (enoentErr) {
          if (enoentErr.code === 'ENOENT') {
            proc = spawn(nodeBin, [acpxBin,
              '--cwd', cwd, '--approve-all', '--model', model,
              '--timeout', String(hardTimeoutSeconds), '--prompt-retries', '2', '--suppress-reads', agent, 'exec', '-f', promptFile,
            ], {
              cwd,
              encoding: 'utf8',
              maxBuffer: 10 * 1024 * 1024,
              shell: false,
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe'],
              env: acpxEnv,
            });
          } else {
            throw enoentErr;
          }
        }
      }
    } catch (spawnErr) {
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(softTimer);
      clearTimeout(progressTimer);
      cleanup();
      reject(new Error(`Failed to spawn agent ${agent}: ${spawnErr.message}`));
      return;
    }

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(softTimer);
        clearTimeout(progressTimer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status: code, extensionsUsed });
      }
    });

    proc.on('close', () => { cleanup(); });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(softTimer);
        clearTimeout(progressTimer);
        cleanup();
        reject(err);
      }
    });

    // Start timers
    setupSoftTimeout(softTimeoutSeconds);
    setupProgressMonitor();
  });
}

function roleConfig(spec, role) {
  if (role === 'producer') return spec.producer;
  if (role === 'reviewer_a') return spec.reviewerA;
  if (role === 'reviewer_b') return spec.reviewerB;
  if (role === 'global_reviewer') return spec.escalationReviewer ?? null;
  throw new Error(`Unknown role: ${role}`);
}

function roleAttemptConfigs(config) {
  if (!config) return [];
  const primary = { ...config, fallback: undefined, attemptLabel: 'primary' };
  const attempts = [primary];

  if (config.fallback?.agent && config.fallback?.model) {
    attempts.push({
      ...config,
      ...config.fallback,
      fallback: undefined,
      attemptLabel: 'fallback',
    });
  } else if (config.retryOnce === true) {
    attempts.push({
      ...config,
      fallback: undefined,
      attemptLabel: 'retry',
    });
  }

  return attempts;
}

function loadSpec(state, args) {
  const specPath = (args && args.taskSpec) || (state && state.specPath) || null;
  return getTaskSpec(state.taskId, specPath);
}

/**
 * Resolve per-role timeout for a given stage.
 * Priority: spec.stageRoleTimeouts[stage][role] > config.timeoutSeconds > 600
 */
function stageRoleTimeout(spec, stage, role) {
  if (spec.stageRoleTimeouts?.[stage]?.[role] != null) {
    return spec.stageRoleTimeouts[stage][role];
  }
  const config = roleConfig(spec, role);
  return config?.timeoutSeconds ?? 600;
}

function ensureStagePaths(runDir, stageIndex, stageName) {
  const stageDir = path.join(runDir, 'stages', `${String(stageIndex + 1).padStart(2, '0')}-${stageName}`);
  ensureDir(stageDir);
  const paths = {
    stageDir,
    briefPath: path.join(stageDir, 'brief.md'),
    producerPath: path.join(stageDir, 'producer.md'),
    reviewerAPath: path.join(stageDir, 'reviewer-a.md'),
    reviewerBPath: path.join(stageDir, 'reviewer-b.md'),
    globalReviewerPath: path.join(stageDir, 'global-reviewer.md'),
    decisionPath: path.join(stageDir, 'decision.md'),
    scorecardPath: path.join(stageDir, 'scorecard.json'),
    producerStdoutPath: path.join(stageDir, 'producer-stdout.log'),
    reviewerAStdoutPath: path.join(stageDir, 'reviewer-a-stdout.log'),
    reviewerBStdoutPath: path.join(stageDir, 'reviewer-b-stdout.log'),
    globalReviewerStdoutPath: path.join(stageDir, 'global-reviewer-stdout.log'),
    producerWorklogPath: path.join(stageDir, 'producer-worklog.md'),
    reviewerAWorklogPath: path.join(stageDir, 'reviewer-a-worklog.md'),
    reviewerBWorklogPath: path.join(stageDir, 'reviewer-b-worklog.md'),
    globalReviewerWorklogPath: path.join(stageDir, 'global-reviewer-worklog.md'),
    producerStatePath: path.join(stageDir, 'producer-state.json'),
    reviewerAStatePath: path.join(stageDir, 'reviewer-a-state.json'),
    reviewerBStatePath: path.join(stageDir, 'reviewer-b-state.json'),
    globalReviewerStatePath: path.join(stageDir, 'global-reviewer-state.json'),
  };

  const placeholderFiles = [
    paths.producerWorklogPath,
    paths.reviewerAWorklogPath,
    paths.reviewerBWorklogPath,
    paths.globalReviewerWorklogPath,
  ];
  for (const file of placeholderFiles) {
    if (!fileExists(file)) {
      writeText(file, '# Worklog\n\n');
    }
  }

  const placeholderStates = [
    [paths.producerStatePath, 'producer'],
    [paths.reviewerAStatePath, 'reviewer_a'],
    [paths.reviewerBStatePath, 'reviewer_b'],
    [paths.globalReviewerStatePath, 'global_reviewer'],
  ];
  for (const [file, role] of placeholderStates) {
    if (!fileExists(file)) {
      writeJson(file, {
        role,
        stage: stageName,
        round: 0,
        status: 'idle',
        lastPid: null,
        startedAt: null,
        finishedAt: null,
        terminatedAt: null,
        timeoutSeconds: null,
        lastError: null,
        checklist: [],
        updatedAt: nowIso(),
      });
    }
  }

  return paths;
}

function roleArtifactPaths(paths, role) {
  if (role === 'producer') {
    return { reportPath: paths.producerPath, stdoutPath: paths.producerStdoutPath };
  }
  if (role === 'reviewer_a') {
    return { reportPath: paths.reviewerAPath, stdoutPath: paths.reviewerAStdoutPath };
  }
  if (role === 'reviewer_b') {
    return { reportPath: paths.reviewerBPath, stdoutPath: paths.reviewerBStdoutPath };
  }
  if (role === 'global_reviewer') {
    return { reportPath: paths.globalReviewerPath, stdoutPath: paths.globalReviewerStdoutPath };
  }
  throw new Error(`Unknown role: ${role}`);
}

function roleStatePath(paths, role) {
  if (role === 'producer') return paths.producerStatePath;
  if (role === 'reviewer_a') return paths.reviewerAStatePath;
  if (role === 'reviewer_b') return paths.reviewerBStatePath;
  if (role === 'global_reviewer') return paths.globalReviewerStatePath;
  throw new Error(`Unknown role: ${role}`);
}

function updateRoleState(paths, role, patch) {
  const statePath = roleStatePath(paths, role);
  const previous = fileExists(statePath) ? readJson(statePath) : { role };
  writeJson(statePath, {
    ...previous,
    ...patch,
    role,
    updatedAt: nowIso(),
  });
}

function terminateProcessTree(pid, { runDir = null, label = 'process' } = {}) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        encoding: 'utf8',
        timeout: 30_000,
        shell: false,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      const success = result.status === 0 || /not found|no running instance|not found/i.test(output);
      if (runDir) appendTimeline(runDir, `${success ? 'Terminated' : 'Failed to terminate'} ${label} process tree pid=${pid}${output ? ` (${output})` : ''}`);
      return success;
    }
    // Kill entire process group — negative pid sends signal to all processes
    // in the same process group. Fallback to direct pid kill if group kill
    // fails (e.g., process group already destroyed).
    try {
      process.kill(-pid, 'SIGKILL');
      if (runDir) appendTimeline(runDir, `Terminated ${label} process group pgid=${pid}`);
    } catch (groupErr) {
      if (groupErr.code === 'ESRCH') {
        // Process already dead — expected during normal cleanup
        if (runDir) appendTimeline(runDir, `${label} process already exited pid=${pid}`);
        return true;
      }
      process.kill(pid, 'SIGKILL');
      if (runDir) appendTimeline(runDir, `Terminated ${label} pid=${pid} (group kill failed: ${groupErr.message})`);
    }
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process already dead — expected during normal cleanup
      if (runDir) appendTimeline(runDir, `${label} process already exited pid=${pid}`);
      return true;
    }
    if (runDir) appendTimeline(runDir, `Failed to terminate ${label} pid=${pid}: ${err.message}`);
    return false;
  }
}

function cleanupRecordedRoleProcesses(paths, runDir) {
  const roles = ['producer', 'reviewer_a', 'reviewer_b', 'global_reviewer'];
  for (const role of roles) {
    const statePath = roleStatePath(paths, role);
    if (!fileExists(statePath)) continue;
    const roleState = readJson(statePath);
    if (roleState.lastPid) {
      const terminated = terminateProcessTree(roleState.lastPid, { runDir, label: role });
      if (terminated) {
        updateRoleState(paths, role, {
          status: roleState.status === 'completed' ? roleState.status : 'terminated',
          terminatedAt: nowIso(),
          lastPid: null,
        });
      } else {
        updateRoleState(paths, role, {
          lastError: roleState.lastError ?? `Failed to terminate recorded ${role} pid ${roleState.lastPid}`,
        });
      }
    }
  }
}

/**
 * ISOLATION ARTIFACT ALLOWLIST
 * Only these files can be collected from isolation directory to stage directory.
 * This prevents accidental collection of logs, temp files, or other runtime artifacts.
 */
export const ISOLATION_COLLECT_ALLOWLIST = [
  // Report files - the primary artifacts we want to collect
  'report.md',
  // Stage-specific report filenames
  'producer.md',
  'reviewer-a.md',
  'reviewer-b.md',
  'global-reviewer.md',
];

/**
 * Check if a filename is allowed to be collected from isolation directory.
 * @param {string} filename - The filename to check (basename only, no path)
 * @returns {boolean} True if the file is in the allowlist
 */
export function isIsolationCollectAllowed(filename) {
  return ISOLATION_COLLECT_ALLOWLIST.includes(filename);
}

/**
 * Get the isolation directory path for a specific run/stage/role.
 * This is the canonical isolation directory format: runtime/tmp/sprint-agent/{runId}/{stage}-{role}/
 *
 * @param {string} runId - The unique run identifier (e.g., "2026-04-02T14-24-34-009Z-task-name")
 * @param {string} stageName - The stage name (e.g., "implement", "verify")
 * @param {string} role - The role name (e.g., "producer", "reviewer_a")
 * @returns {string} The isolation directory path
 */
export function getIsolationDir(runId, stageName, role) {
  const roleDir = `${stageName}-${role}`;
  return path.join(tempRoot, 'sprint-agent', runId, roleDir);
}

/**
 * Find report in iflow isolation directory.
 * iflow writes to runtime/tmp/sprint-agent/{runId}/{stage}-{role}/{report}.md
 *
 * IMPORTANT: Uses runId directly for isolation lookup, not fragile timestamp extraction.
 * This ensures different runs have unique isolation directories and prevents cross-contamination.
 *
 * @param {object} options
 * @param {string} options.runId - The unique run identifier
 * @param {string} options.stageName - The stage name
 * @param {string} options.role - The role name
 * @param {string} options.reportFilename - The report filename to look for
 * @returns {string|null} The isolation report path if found and valid, null otherwise
 */
export function findIsolationReport({ runId, stageName, role, reportFilename }) {
  if (!runId) return null;

  const isolationDir = getIsolationDir(runId, stageName, role);
  const isolationReportPath = path.join(isolationDir, reportFilename);

  if (fileExists(isolationReportPath)) {
    const content = fs.readFileSync(isolationReportPath, 'utf8').trim();
    // Only return if it contains actual report content (not just session log)
    if (content && (content.includes('## VERDICT') || content.includes('## SUMMARY'))) {
      return isolationReportPath;
    }
  }
  return null;
}

/**
 * Collect allowed artifacts from isolation directory to stage directory.
 * Only files in ISOLATION_COLLECT_ALLOWLIST will be collected.
 *
 * @param {object} options
 * @param {string} options.runId - The unique run identifier
 * @param {string} options.stageName - The stage name
 * @param {string} options.role - The role name
 * @param {string} options.stageDir - The stage directory to collect to
 * @param {string} options.reportFilename - The expected report filename
 * @param {string} options.runDir - The run directory (for timeline logging)
 * @returns {{collected: string[], skipped: string[], isolationReportPath: string|null}} Lists of collected and skipped files, plus the isolation report path if valid
 */
export function collectIsolationArtifacts({ runId, stageName, role, stageDir, reportFilename, runDir }) {
  const result = { collected: [], skipped: [], isolationReportPath: null };

  if (!runId) return result;

  const isolationDir = getIsolationDir(runId, stageName, role);
  if (!fileExists(isolationDir)) return result;

  // Only collect the specific report file if it's in the allowlist
  if (!isIsolationCollectAllowed(reportFilename)) {
    result.skipped.push(reportFilename);
    return result;
  }

  const isolationReportPath = path.join(isolationDir, reportFilename);
  const stageReportPath = path.join(stageDir, reportFilename);

  if (!fileExists(isolationReportPath)) return result;

  const isolationContent = fs.readFileSync(isolationReportPath, 'utf8').trim();
  const stageContent = fileExists(stageReportPath) ? fs.readFileSync(stageReportPath, 'utf8').trim() : '';

  // Only collect if isolation report has actual content and stage report is missing or empty
  const isolationHasReport = isolationContent && (isolationContent.includes('## VERDICT') || isolationContent.includes('## SUMMARY'));
  const stageHasReport = stageContent && (stageContent.includes('## VERDICT') || stageContent.includes('## SUMMARY'));

  if (isolationHasReport) {
    result.isolationReportPath = isolationReportPath; // Always return path when valid content exists
    if (!stageHasReport) {
      writeText(stageReportPath, `${isolationContent}\n`);
      appendTimeline(runDir, `Collected isolation artifact: ${reportFilename}`);
      result.collected.push(reportFilename);
    } else {
      result.skipped.push(reportFilename);
    }
  } else {
    result.skipped.push(reportFilename);
  }

  return result;
}

function readRoleOutput({ reportPath, stdout, isolationReportPath = null }) {
  // First try the expected report path
  if (fileExists(reportPath)) {
    const report = fs.readFileSync(reportPath, 'utf8').trim();
    if (report) {
      return report;
    }
  }
  // Fallback to isolation directory if provided
  if (isolationReportPath && fileExists(isolationReportPath)) {
    const report = fs.readFileSync(isolationReportPath, 'utf8').trim();
    if (report) {
      return report;
    }
  }
  return String(stdout ?? '').trim();
}

function reportExistsAndNonEmpty(reportPath) {
  return fileExists(reportPath) && Boolean(fs.readFileSync(reportPath, 'utf8').trim());
}

const PROTECTED_CRITICAL = ['sprint.json', 'timeline.md', 'latest-summary.md'];
const PROTECTED_STAGE_CRITICAL = ['decision.md', 'scorecard.json'];

function protectedArtifacts(runDir, paths) {
  // Roles must not modify stage-level truth sources that are written only after role execution.
  // Do not include run-level timeline/latest-summary here: the orchestrator itself updates those
  // while roles are still running (timeouts, progress signals, state transitions), which would
  // create false protected-file violations.
  return [
    path.join(runDir, 'sprint.json'),
    paths.decisionPath,
    paths.scorecardPath,
  ];
}

function classifyProtectedFile(filePath, runDir) {
  const basename = path.basename(filePath);
  if (!runDir) {
    if (PROTECTED_CRITICAL.includes(basename) || PROTECTED_STAGE_CRITICAL.includes(basename)) {
      return 'critical';
    }
    return 'warn';
  }
  const stageDir = path.join(runDir, 'stages');
  if (filePath.startsWith(stageDir)) {
    return PROTECTED_STAGE_CRITICAL.includes(basename) ? 'critical' : 'warn';
  }
  return PROTECTED_CRITICAL.includes(basename) ? 'critical' : 'warn';
}

function snapshotProtectedFiles(files) {
  const snapshot = {};
  for (const file of files) {
    snapshot[file] = fileExists(file) ? fs.statSync(file).mtimeMs : null;
  }
  return snapshot;
}

function detectProtectedWriteViolation(files, snapshot, runDir) {
  for (const file of files) {
    const previous = snapshot[file] ?? null;
    const current = fileExists(file) ? fs.statSync(file).mtimeMs : null;
    if (previous !== current) {
      return { file, severity: classifyProtectedFile(file, runDir) };
    }
  }
  return null;
}

/**
 * Format a role-level validation result for decision.md.
 * @param {string} roleName - Display name (e.g., "Producer", "Reviewer A")
 * @param {{valid: boolean, missingSections?: string[], invalidFields?: string[], errorSummary?: string|null}} roleResult
 * @returns {string[]} Lines for decision.md
 */
export function formatRoleValidation(roleName, roleResult) {
  if (!roleResult) return [];
  const lines = [];
  const status = roleResult.valid ? '[OK]' : '[FAIL]';
  const mainLine = `- ${roleName}: ${status}`;
  
  if (roleResult.valid) {
    lines.push(mainLine);
  } else {
    // Show error summary if available
    const details = [];
    if (roleResult.missingSections?.length) {
      details.push(`missing: ${roleResult.missingSections.join(', ')}`);
    }
    if (roleResult.invalidFields?.length) {
      details.push(`invalid: ${roleResult.invalidFields.join(', ')}`);
    }
    lines.push(`${mainLine} ${details.join('; ')}`);
  }
  return lines;
}

/**
 * Validate that a report contains the minimum required markdown section headings.
 * Returns an array of missing section descriptions (empty = pass).
 *
 * WF-003 fix: reviewer report format enforcement — prevents stage_error from
 * reports that exist on disk but lack required sections.
 * WF-004 fix: producer report format enforcement — prevents max_rounds_exceeded
 * by giving explicit feedback about which sections are missing.
 */
function validateReportSections(text, requiredSections, reportLabel) {
  const missing = [];
  for (const section of requiredSections) {
    // Match ## or ### heading level, case-insensitive, word boundary after section name
    const safeSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^#{2,3}\\s+${safeSection}\\b`, 'im');
    if (!re.test(text)) {
      missing.push(`${reportLabel}: missing required section "${section}"`);
    }
  }
  return missing;
}

/**
 * Core reviewer-report minimum schema. Without these sections, the decision
 * engine cannot produce valid verdicts or blockers, and the stage will fail
 * with an opaque stage_error.
 */
const REQUIRED_REVIEWER_SECTIONS = ['VERDICT', 'FINDINGS', 'BLOCKERS', 'NEXT_FOCUS', 'CHECKS'];

export function decideAndPersist({ runDir, stageName, stageDir, decisionPath, scorecardPath, producerPath, reviewerAPath, reviewerBPath, globalReviewerPath, state, reviewerTimeouts = null, reviewerViolations = null }) {
  // Build lookup maps for reviewer timeout/error state
  const timeoutMap = new Map((reviewerTimeouts ?? []).map((r) => [r.role, r]));
  const missingFiles = [];
  if (!reportExistsAndNonEmpty(producerPath)) missingFiles.push(`producer: ${producerPath}${fileExists(producerPath) ? ' (empty)' : ''}`);
  if (!reportExistsAndNonEmpty(reviewerAPath)) {
    const info = timeoutMap.get('reviewer_a');
    if (info?.timedOut) missingFiles.push(`reviewer_a: ${reviewerAPath} (timed out, no report)`);
    else if (info) missingFiles.push(`reviewer_a: ${reviewerAPath} (error, no report)`);
    else missingFiles.push(`reviewer_a: ${reviewerAPath}${fileExists(reviewerAPath) ? ' (empty)' : ' (missing)'}`);
  }
  if (!reportExistsAndNonEmpty(reviewerBPath)) {
    const info = timeoutMap.get('reviewer_b');
    if (info?.timedOut) missingFiles.push(`reviewer_b: ${reviewerBPath} (timed out, no report)`);
    else if (info) missingFiles.push(`reviewer_b: ${reviewerBPath} (error, no report)`);
    else missingFiles.push(`reviewer_b: ${reviewerBPath}${fileExists(reviewerBPath) ? ' (empty)' : ' (missing)'}`);
  }

  const stageCriteria = loadSpec(state).stageCriteria?.[stageName] ?? {};
  const globalReviewerRequired = stageCriteria.globalReviewerRequired === true;
  if (globalReviewerRequired && globalReviewerPath && !reportExistsAndNonEmpty(globalReviewerPath)) {
    missingFiles.push(`global_reviewer: ${globalReviewerPath}${fileExists(globalReviewerPath) ? ' (empty — required for this stage)' : ' (missing — required for this stage)'}`);
  }

  if (missingFiles.length > 0) {
    const failure = inferFailureClassification({
      summary: `Missing reports: ${missingFiles.join('; ')}`,
      blockers: missingFiles,
      reviewerTimeouts,
      reviewerViolations,
    });
    writeText(decisionPath, [
      `# Decision`,
      '',
      `- Stage: ${stageName}`,
      `- Round: ${state.currentRound}`,
      `- Outcome: error`,
      '',
      `## Missing reports`,
      ...missingFiles.map((f) => `- ${f}`),
      '',
      `Cannot render stage decision because required role reports are missing.`,
      '',
    ].join('\n'));
    writeJson(scorecardPath, {
      stage: stageName,
      round: state.currentRound,
      outcome: 'error',
      summary: `Missing reports: ${missingFiles.join('; ')}`,
      missingReports: missingFiles,
      failureClassification: failure.failureClassification,
      failureSource: failure.failureSource,
      recommendedNextAction: failure.recommendedNextAction,
      reviewerTimeouts: reviewerTimeouts ?? null,
      updatedAt: nowIso(),
    });
    appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} decision: error (missing reports)`);
    updateSummaryWithClassification(runDir, [
      `Status: ${state.status}`,
      `Stage: ${stageName}`,
      `Round: ${state.currentRound}`,
      `Outcome: error`,
      `Missing: ${missingFiles.join('; ')}`,
    ], failure);
    return { outcome: 'error', summary: `Missing reports: ${missingFiles.join('; ')}`, blockers: missingFiles, metrics: {} };
  }

  const producer = fs.readFileSync(producerPath, 'utf8');
  const reviewerA = fs.readFileSync(reviewerAPath, 'utf8');
  const reviewerB = fs.readFileSync(reviewerBPath, 'utf8');
  const globalReviewer = (globalReviewerRequired && globalReviewerPath && reportExistsAndNonEmpty(globalReviewerPath))
    ? fs.readFileSync(globalReviewerPath, 'utf8')
    : null;

  // Read reviewer state JSON for dimensions fallback (agent may write dimensions to state but not report text)
  const reviewerAStatePath = path.join(stageDir, 'reviewer-a-state.json');
  const reviewerBStatePath = path.join(stageDir, 'reviewer-b-state.json');
  let reviewerADimensionsFallback = null;
  let reviewerBDimensionsFallback = null;
  try {
    if (fileExists(reviewerAStatePath)) {
      const aState = readJson(reviewerAStatePath);
      if (aState.dimensions && typeof aState.dimensions === 'object') reviewerADimensionsFallback = aState.dimensions;
    }
  } catch {}
  try {
    if (fileExists(reviewerBStatePath)) {
      const bState = readJson(reviewerBStatePath);
      if (bState.dimensions && typeof bState.dimensions === 'object') reviewerBDimensionsFallback = bState.dimensions;
    }
  } catch {}

  // WF-003/WF-004 fix: validate report schema before entering decision engine.
  // Reports that exist on disk but lack required sections cause opaque stage_error
  // or silent max_rounds_exceeded. By validating here, we get explicit error
  // messages that tell the agent exactly which sections are missing.
  //
  // Return 'error' outcome (which advanceState() maps to stage_error → halt).
  // This is intentional: if both reviewers fail schema validation simultaneously,
  // the stage cannot proceed. The explicit blockers tell the Executor exactly
  // what to fix in the next sprint.
  const schemaErrors = [];
  const missingReviewerA = validateReportSections(reviewerA, REQUIRED_REVIEWER_SECTIONS, 'reviewer_a');
  const missingReviewerB = validateReportSections(reviewerB, REQUIRED_REVIEWER_SECTIONS, 'reviewer_b');
  if (missingReviewerA.length) schemaErrors.push(...missingReviewerA);
  if (missingReviewerB.length) schemaErrors.push(...missingReviewerB);

  if (schemaErrors.length > 0) {
    const errorSummary = `Report schema violation: ${schemaErrors.join('; ')}`;
    const failure = inferFailureClassification({
      summary: errorSummary,
      blockers: schemaErrors,
      reviewerTimeouts,
      reviewerViolations,
    });
    writeText(decisionPath, [
      `# Decision`,
      '',
      `- Stage: ${stageName}`,
      `- Round: ${state.currentRound}`,
      `- Outcome: error`,
      '',
      `## Report Schema Violation`,
      ...schemaErrors.map((e) => `- ${e}`),
      '',
      `Cannot render stage decision because role reports are missing required sections.`,
      '',
    ].join('\n'));
    writeJson(scorecardPath, {
      stage: stageName,
      round: state.currentRound,
      outcome: 'error',
      summary: errorSummary,
      missingReports: schemaErrors,
      failureClassification: failure.failureClassification,
      failureSource: failure.failureSource,
      recommendedNextAction: failure.recommendedNextAction,
      reviewerTimeouts: reviewerTimeouts ?? null,
      updatedAt: nowIso(),
      schemaValidation: {
        reviewerA_sections: REQUIRED_REVIEWER_SECTIONS,
        reviewerA_missing: missingReviewerA,
        reviewerB_sections: REQUIRED_REVIEWER_SECTIONS,
        reviewerB_missing: missingReviewerB,
      },
    });
    appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} decision: error (report schema violation)`);
    updateSummaryWithClassification(runDir, [
      `Status: ${state.status}`,
      `Stage: ${stageName}`,
      `Round: ${state.currentRound}`,
      `Outcome: error`,
      `Schema violations: ${schemaErrors.join('; ')}`,
    ], failure);
    return { outcome: 'error', summary: errorSummary, blockers: schemaErrors, metrics: {} };
  }

  const decision = decideStage({
    stageCriteria: loadSpec(state).stageCriteria?.[stageName],
    producer,
    reviewerA,
    reviewerB,
    globalReviewer: globalReviewerRequired ? globalReviewer : null,
    currentRound: state.currentRound,
    maxRoundsPerStage: state.maxRoundsPerStage,
    reviewerViolations,
    reviewerADimensionsFallback,
    reviewerBDimensionsFallback,
  });

  const content = [
    `# Decision`,
    '',
    `- Stage: ${stageName}`,
    `- Round: ${state.currentRound}`,
    `- Outcome: ${decision.outcome}`,
    `- Output Quality: ${decision.outputQuality}`,
    '',
    `## Summary`,
    decision.summary,
    '',
    ...(decision.qualityReasons?.length
      ? [
        `## Quality Reasons`,
        ...decision.qualityReasons.map((r) => `- ${r}`),
        '',
      ]
      : []),
    ...(decision.nextRunRecommendation
      ? [
        `## Next Run Recommendation`,
        `- Type: ${decision.nextRunRecommendation.type}`,
        ...(decision.nextRunRecommendation.spec
          ? [`- Spec: ${decision.nextRunRecommendation.spec}`]
          : []),
        ...(decision.nextRunRecommendation.reasons?.length
          ? ['', 'Reasons:', ...decision.nextRunRecommendation.reasons.map((r) => `- ${r}`)]
          : []),
        '',
      ]
      : []),
    `## Validation`,
    `- Contract Valid: ${decision.validation?.valid ?? 'n/a'}`,
    ...(decision.validation?.producer
      ? formatRoleValidation('Producer', decision.validation.producer)
      : []),
    ...(decision.validation?.reviewerA
      ? formatRoleValidation('Reviewer A', decision.validation.reviewerA)
      : []),
    ...(decision.validation?.reviewerB
      ? formatRoleValidation('Reviewer B', decision.validation.reviewerB)
      : []),
    ...(decision.validation?.globalReviewer
      ? formatRoleValidation('Global Reviewer', decision.validation.globalReviewer)
      : []),
    ...(decision.validation?.errorSummary
      ? ['', `### Error Summary`, decision.validation.errorSummary]
      : []),
    '',
    `## Blockers`,
    ...(decision.blockers.length ? decision.blockers.map((b) => `- ${b}`) : ['- None.']),
    '',
    `## Metrics`,
    `- approvalCount: ${decision.metrics.approvalCount}`,
    `- blockerCount: ${decision.metrics.blockerCount}`,
    `- reviewerAVerdict: ${decision.metrics.reviewerAVerdict}`,
    `- reviewerBVerdict: ${decision.metrics.reviewerBVerdict}`,
    `- producerSectionChecks: ${JSON.stringify(decision.metrics.producerSectionChecks)}`,
    `- reviewerSectionChecks: ${JSON.stringify(decision.metrics.reviewerSectionChecks)}`,
    `- producerChecks: ${decision.metrics.producerChecks ?? 'n/a'}`,
    `- reviewerAChecks: ${decision.metrics.reviewerAChecks ?? 'n/a'}`,
    `- reviewerBChecks: ${decision.metrics.reviewerBChecks ?? 'n/a'}`,
    ...(decision.metrics.globalReviewerVerdict
      ? [
        `- globalReviewerVerdict: ${decision.metrics.globalReviewerVerdict}`,
        `- globalReviewerRequired: true`,
        `- globalReviewerChecks: ${decision.metrics.globalReviewerChecks ?? 'n/a'}`,
        `- macroAnswersSatisfied: ${decision.metrics.macroAnswersSatisfied ?? false}`,
      ]
      : []),
    ...(decision.metrics.scoringDimensions?.length
      ? [
        `- scoringDimensions: ${decision.metrics.scoringDimensions.join(', ')}`,
        `- reviewerADimensions: ${JSON.stringify(decision.metrics.reviewerADimensions)}`,
        `- reviewerBDimensions: ${JSON.stringify(decision.metrics.reviewerBDimensions)}`,
        `- dimensionFailures: ${decision.metrics.dimensionFailures.length}`,
      ]
      : []),
    ...(decision.metrics.contractItems?.length
      ? [
        `- contractDoneItems: ${decision.metrics.contractCheck.doneItems}/${decision.metrics.contractCheck.totalItems}`,
      ]
      : []),
    '',
    `## Files`,
    `- Producer: ${producerPath}`,
    `- Reviewer A: ${reviewerAPath}`,
    `- Reviewer B: ${reviewerBPath}`,
    ...(globalReviewerRequired ? [`- Global Reviewer: ${globalReviewerPath}`] : []),
  ].join('\n');

  writeText(decisionPath, `${content}\n`);

  const failure = decision.outcome === 'error'
    ? inferFailureClassification({
        summary: decision.summary,
        blockers: decision.blockers,
        reviewerTimeouts,
        reviewerViolations,
      })
    : null;

  const scorecard = {
    stage: stageName,
    round: state.currentRound,
    outcome: decision.outcome,
    outputQuality: decision.outputQuality,
    qualityReasons: decision.qualityReasons ?? [],
    nextRunRecommendation: decision.nextRunRecommendation ?? null,
    validation: {
      valid: decision.validation?.valid ?? true,
      errorSummary: decision.validation?.errorSummary ?? null,
      producer: decision.validation?.producer ?? null,
      reviewerA: decision.validation?.reviewerA ?? null,
      reviewerB: decision.validation?.reviewerB ?? null,
      globalReviewer: decision.validation?.globalReviewer ?? null,
    },
    summary: decision.summary,
    failureClassification: failure?.failureClassification ?? null,
    failureSource: failure?.failureSource ?? null,
    recommendedNextAction: failure?.recommendedNextAction ?? null,
    approvalCount: decision.metrics.approvalCount,
    blockerCount: decision.metrics.blockerCount,
    reviewerAVerdict: decision.metrics.reviewerAVerdict,
    reviewerBVerdict: decision.metrics.reviewerBVerdict,
    producerSectionChecks: decision.metrics.producerSectionChecks,
    reviewerSectionChecks: decision.metrics.reviewerSectionChecks,
    producerChecks: decision.metrics.producerChecks,
    reviewerAChecks: decision.metrics.reviewerAChecks,
    reviewerBChecks: decision.metrics.reviewerBChecks,
    ...(decision.metrics.globalReviewerVerdict
      ? {
        globalReviewerVerdict: decision.metrics.globalReviewerVerdict,
        globalReviewerRequired: true,
        globalReviewerChecks: decision.metrics.globalReviewerChecks,
        macroAnswersSatisfied: decision.metrics.macroAnswersSatisfied,
        macroAnswersRequired: decision.metrics.macroAnswersRequired ?? [],
        macroAnswersFound: decision.metrics.macroAnswersFound ?? [],
      }
      : {}),
    blockers: decision.blockers,
    ...(decision.metrics.scoringDimensions?.length
      ? {
        scoringDimensions: decision.metrics.scoringDimensions,
        reviewerADimensions: decision.metrics.reviewerADimensions,
        reviewerBDimensions: decision.metrics.reviewerBDimensions,
        dimensionFailures: decision.metrics.dimensionFailures,
      }
      : {}),
    ...(decision.metrics.contractItems?.length
      ? {
        contractItems: decision.metrics.contractItems,
        contractCheck: decision.metrics.contractCheck,
      }
      : {}),
    ...(reviewerTimeouts
      ? { reviewerTimeouts }
      : {}),
    updatedAt: nowIso(),
  };
  writeJson(scorecardPath, scorecard);

  // Build and write handoff for next round
  if (decision.outcome === 'revise') {
    const handoff = buildHandoff({
      reviewerA,
      reviewerB,
      globalReviewer,
      producer,
      metrics: decision.metrics,
      stageName,
      round: state.currentRound,
    });
    const handoffPath = path.join(stageDir, 'handoff.json');
    writeJson(handoffPath, handoff);
    writeCheckpointSummary(stageDir, {
      decision,
      handoff,
      producer,
      reviewerA,
      reviewerB,
      globalReviewer: globalReviewer ?? '',
    });
  } else {
    writeCheckpointSummary(stageDir, {
      decision,
      handoff: null,
      producer,
      reviewerA,
      reviewerB,
      globalReviewer: globalReviewer ?? '',
    });
  }
  appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} decision: ${decision.outcome}`);
  updateSummaryWithClassification(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    `Outcome: ${decision.outcome}`,
    `Approval count: ${decision.metrics.approvalCount}/2${decision.metrics.globalReviewerVerdict ? ` + global_reviewer: ${decision.metrics.globalReviewerVerdict}` : ''}`,
    `Blocker count: ${decision.metrics.blockerCount}`,
    ...(decision.blockers.length ? [`Top blocker: ${decision.blockers[0]}`] : ['Top blocker: none']),
  ], failure);
  return decision;
}

/**
 * Run merge gate: fetch origin and compare local vs remote PR/target branch HEAD SHA.
 *
 * IMPORTANT — targetBranch vs worktree.branchName:
 *   - targetBranch = spec.branch ?? 'main'   ← the REAL PR branch on remote (e.g. 'feat/my-feature')
 *   - worktree.branchName = sprint/<runId>/<stage>  ← internal temp branch, NEVER on remote
 *
 * Merge gate must NEVER use worktree.branchName — it does not exist on the remote.
 * If spec.branch is not set, merge gate compares against 'main' (safe default).
 *
 * Returns { localHeadSha, remoteHeadSha, shaMatch, targetBranch }.
 * Writes result to stages/<stage>/merge-gate.json.
 */
function runMergeGateCheck({ runDir, state, spec, mergeGatePath }) {
  const workspace = state.worktree?.worktreePath ?? spec.workspace;
  const remote = 'origin';

  // targetBranch is the REAL PR branch on remote — NEVER the internal sprint worktree branch
  const targetBranch = spec.branch ?? 'main';
  const remoteRef = `refs/remotes/${remote}/${targetBranch}`;

  try {
    // Fetch the specific remote branch via targeted refspec
    const fetchResult = spawnSync('git', ['fetch', remote, `refs/heads/${targetBranch}:refs/remotes/${remote}/${targetBranch}`], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 60_000,
    });

    // If fetch fails (branch doesn't exist on remote), record clearly
    if (fetchResult.status !== 0) {
      const fetchErr = fetchResult.stderr?.trim() || fetchResult.stdout?.trim() || 'unknown';
      appendTimeline(runDir, `Merge gate: target branch '${targetBranch}' does not exist on remote: ${fetchErr}`);
      const result = { localHeadSha: null, remoteHeadSha: null, shaMatch: false, targetBranch, error: `Branch '${targetBranch}' not found on remote. Has it been pushed?`, fetchFailed: true };
      writeJson(mergeGatePath, result);
      return result;
    }

    const localShaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace, encoding: 'utf8', timeout: 10_000,
    });
    if (localShaResult.status !== 0) {
      const errMsg = localShaResult.stderr?.trim() || localShaResult.stdout?.trim() || 'unknown';
      appendTimeline(runDir, `Merge gate: git rev-parse HEAD failed with status ${localShaResult.status}: ${errMsg}`);
      return { localHeadSha: null, remoteHeadSha: null, shaMatch: false, targetBranch, error: `git rev-parse HEAD failed: ${errMsg}` };
    }
    const localSha = (localShaResult.stdout ?? '').trim();

    const remoteShaResult = spawnSync('git', ['rev-parse', remoteRef], {
      cwd: workspace, encoding: 'utf8', timeout: 10_000,
    });
    if (remoteShaResult.status !== 0) {
      appendTimeline(runDir, `Merge gate: remote ref ${remoteRef} not found after fetch (git status ${remoteShaResult.status})`);
      return { localHeadSha: localSha, remoteHeadSha: null, shaMatch: false, targetBranch, error: `Remote ref '${remoteRef}' not found after fetch` };
    }
    const remoteSha = (remoteShaResult.stdout ?? '').trim();

    const shaMatch = localSha === remoteSha;

    const result = { localHeadSha: localSha, remoteHeadSha: remoteSha, shaMatch, targetBranch };

    writeJson(mergeGatePath, result);
    appendTimeline(runDir, `Merge gate: targetBranch=${targetBranch} local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)} match=${shaMatch}`);

    return result;
  } catch (gateErr) {
    appendTimeline(runDir, `Merge gate check failed: ${gateErr.message}`);
    return { localHeadSha: null, remoteHeadSha: null, shaMatch: false, targetBranch, error: gateErr.message };
  }
}

function advanceState(state, spec, decision, { runDir } = {}) {
  if (decision.outcome === 'advance') {
    if (state.currentStageIndex >= spec.stages.length - 1) {
      // Merge gate check before completing final stage
      if (runDir) {
        const finalStageDir = `${String(state.currentStageIndex + 1).padStart(2, '0')}-${state.currentStage}`;
        const mergeGatePath = path.join(runDir, 'stages', finalStageDir, 'merge-gate.json');
        const mergeGate = runMergeGateCheck({ runDir, state, spec, mergeGatePath });
        if (!mergeGate.shaMatch) {
          const fetchFailed = Boolean(mergeGate.fetchFailed);
          if (fetchFailed) {
            state.status = 'completed';
            state.mergePending = {
              targetBranch: mergeGate.targetBranch,
              reason: mergeGate.error,
              mergeGate,
              updatedAt: nowIso(),
            };
            state.haltReason = null;
            return;
          }
          state.status = 'halted';
          state.haltReason = {
            type: 'merge_gate_sha_mismatch',
            stage: state.currentStage,
            round: state.currentRound,
            targetBranch: mergeGate.targetBranch,
            details: `Merge gate failed: local SHA ${mergeGate.localHeadSha?.slice(0, 7) ?? '?'} != remote/${mergeGate.targetBranch} SHA ${mergeGate.remoteHeadSha?.slice(0, 7) ?? '?'}. Push or rebase before completing.`,
            blockers: ['Local SHA does not match remote target branch head. Push or rebase before completing.'],
            mergeGate,
          };
          return;
        }
      }
      state.mergePending = null;
      state.status = 'completed';
      return;
    }
    state.currentStageIndex += 1;
    state.currentStage = spec.stages[state.currentStageIndex];
    state.currentRound = 1;
    return;
  }

  if (decision.outcome === 'revise') {
    // Route implement-pass-1 revise → implement-pass-2 automatically
    if (state.currentStage === 'implement-pass-1') {
      state.currentStage = 'implement-pass-2';
      state.currentStageIndex = spec.stages.indexOf('implement-pass-2');
      state.currentRound = 1;
      return;
    }
    state.currentRound += 1;
    return;
  }

  // Both 'halt' and 'error' outcomes halt the sprint
  // WF-003 fix: schema violations have already been retried in execStage via
  // the 'revise' outcome path. If we reach here with 'error', it means retries
  // were exhausted or the error is from the standard decision engine.
  // Schema violation errors are now returned with a special flag to trigger retry
  // instead of halt. See the schema validation block in decideAndPersist().
  state.status = 'halted';
  state.haltReason = {
    type: decision.outcome === 'error' ? 'stage_error' : 'max_rounds_exceeded',
    stage: state.currentStage,
    round: state.currentRound,
    details: decision.summary,
    blockers: decision.blockers,
  };
}

function maybeAbort(runDir, state) {
  const fresh = readJson(path.join(runDir, 'sprint.json'));
  if (fresh.status === 'aborted' || fresh.status === 'paused') {
    Object.assign(state, fresh);
    throw new Error(`Sprint ${fresh.status} by operator.`);
  }
  Object.assign(state, fresh);
}

function pidExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reconcileRunState(runDir, state) {
  if (state.status !== 'running') return state;
  if (pidExists(state.orchestratorPid)) return state;

  // Clean up any orphaned acpx queue-owner daemons and agent processes
  // from the previous orchestrator run. acpx queue-owners are detached
  // processes that may outlive their parent acpx invocation.
  cleanupAcpxOrphans(runDir, state);

  // Detect which artifacts already exist on disk for the current stage/round
  const stageDirName = `${String(state.currentStageIndex + 1).padStart(2, '0')}-${state.currentStage}`;
  const stageDir = path.join(runDir, 'stages', stageDirName);
  const artifacts = {
    producer: reportExistsAndNonEmpty(path.join(stageDir, 'producer.md')),
    reviewerA: reportExistsAndNonEmpty(path.join(stageDir, 'reviewer-a.md')),
    reviewerB: reportExistsAndNonEmpty(path.join(stageDir, 'reviewer-b.md')),
    globalReviewer: reportExistsAndNonEmpty(path.join(stageDir, 'global-reviewer.md')),
    decision: reportExistsAndNonEmpty(path.join(stageDir, 'decision.md')),
  };

  const roleLabel = state.currentRole ?? 'unknown';
  const diskSummary = Object.entries(artifacts)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'none';

  state.status = 'halted';
  state.haltReason = {
    type: 'stale_orchestrator',
    stage: state.currentStage,
    round: state.currentRound,
    details: `Orchestrator pid ${state.orchestratorPid ?? 'unknown'} is no longer alive (was: ${roleLabel}). Artifacts on disk: ${diskSummary}.`,
    blockers: ['The sprint process ended before stage completion. Resume to continue.'],
    artifacts,
  };
  saveState(runDir, state);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${state.currentStage}`,
    `Round: ${state.currentRound}`,
    `Halt reason: ${state.haltReason.details}`,
    `Disk artifacts: ${diskSummary}`,
  ]);
  appendTimeline(runDir, `Sprint reconciled to halted: ${state.haltReason.details}`);
  const paths = ensureStagePaths(runDir, state.currentStageIndex, state.currentStage);
  cleanupRecordedRoleProcesses(paths, runDir);
  cleanupWorktree({ state, runDir });
  return state;
}

/**
 * Clean up orphaned acpx queue-owner daemons and agent processes.
 * acpx spawns detached queue-owner processes that may outlive the acpx CLI
 * that created them. On stale-run reconciliation, these should be cleaned up.
 */
function cleanupAcpxOrphans(runDir, state) {
  // Derive workspace from known-good sources only:
  // 1. worktree (most reliable — we created it)
  // 2. spec.workspace (loaded fresh, has clear semantic meaning)
  const spec = state.taskId ? (() => {
    try { return getTaskSpec(state.taskId, state.specPath); } catch { return null; }
  })() : null;

  const workspace = state.worktree?.worktreePath
    ?? (spec?.workspace && spec.workspace !== state.specPath ? spec.workspace : null);

  if (!workspace) {
    appendTimeline(runDir, 'acpx session cleanup skipped: no trusted workspace available');
    return;
  }

  // Try to close any active acpx sessions for the workspace+agent combo
  const agent = spec?.producer?.agent ?? null;

  if (agent) {
    try {
      // acpx <agent> sessions close — this removes the queue-owner lease
      // Use nodeBin + [acpxBin, ...] for consistency with runAgent spawn pattern
      const closeResult = spawnSync(nodeBin, [acpxBin, agent, 'sessions', 'close'],
        { cwd: workspace, encoding: 'utf8', timeout: 10_000, env: acpxEnv, shell: false });
      if (closeResult.status === 0) {
        appendTimeline(runDir, `Cleaned up acpx ${agent} sessions for stale run recovery`);
      }
    } catch (closeErr) {
      // Non-fatal — queue-owner may already be gone
      appendTimeline(runDir, `acpx session cleanup skipped: ${closeErr.message}`);
    }
  }
}

/**
 * Execute a single reviewer role asynchronously with independent timeout tracking.
 * Returns a result object: { role, output, timedOut, reportExisted, violatedFile }
 */
async function runReviewerRole({ runDir, state, spec, paths, role, worktreeInfo }) {
  const stageName = state.currentStage;
  const config = roleConfig(spec, role);
  const { reportPath, stdoutPath } = roleArtifactPaths(paths, role);
  const failLogBase = path.join(paths.stageDir, `${role.replace('_', '-')}-failure`);

  // Skip if report already exists
  if (fileExists(reportPath) && fs.readFileSync(reportPath, 'utf8').trim()) {
    updateRoleState(paths, role, {
      stage: stageName,
      round: state.currentRound,
      status: 'completed',
      lastPid: null,
      finishedAt: nowIso(),
      timeoutSeconds: stageRoleTimeout(spec, stageName, role),
      lastError: null,
    });
    return { role, output: fs.readFileSync(reportPath, 'utf8').trim(), timedOut: false, reportExisted: true, violatedFile: null };
  }

  const protectedFiles = protectedArtifacts(runDir, paths);
  const protectedSnapshot = snapshotProtectedFiles(protectedFiles);
  const prompt = buildRolePrompt({
    spec,
    stage: stageName,
    round: state.currentRound,
    role,
    runDir,
    stageDir: paths.stageDir,
    briefPath: paths.briefPath,
    producerPath: paths.producerPath,
    reviewerAPath: paths.reviewerAPath,
    reviewerBPath: paths.reviewerBPath,
    globalReviewerPath: paths.globalReviewerPath,
  });
  const timeoutSeconds = stageRoleTimeout(spec, stageName, role);
  // Reviewers must verify code in the same workspace where producer made changes
  // branchWorkspace may not exist — fall back to spec.workspace (always valid)
  const cwd = worktreeInfo?.worktreePath ?? (fileExists(spec.branchWorkspace) ? spec.branchWorkspace : spec.workspace);

  let output = null;
  let timedOut = false;
  let violatedFile = null;
  let reportExisted = false;
  const attemptErrors = [];
  const attempts = roleAttemptConfigs(config);

  for (let index = 0; index < attempts.length; index += 1) {
    const attemptConfig = attempts[index];
    const attemptLabel = attemptConfig.attemptLabel ?? `attempt_${index + 1}`;
    const attemptTimeoutSeconds = stageRoleTimeout(
      {
        ...spec,
        reviewerA: role === 'reviewer_a' ? attemptConfig : spec.reviewerA,
        reviewerB: role === 'reviewer_b' ? attemptConfig : spec.reviewerB,
      },
      stageName,
      role
    );
    const failLog = `${failLogBase}-${attemptLabel}.log`;

    updateRoleState(paths, role, {
      stage: stageName,
      round: state.currentRound,
      status: index === 0 ? 'running' : 'retrying',
      startedAt: nowIso(),
      finishedAt: null,
      terminatedAt: null,
      lastPid: null,
      timeoutSeconds: attemptTimeoutSeconds,
      lastError: null,
    });

    if (index > 0) {
      appendTimeline(
        runDir,
        `${role} retrying with ${attemptConfig.agent}/${attemptConfig.model} (${attemptLabel})`
      );
    }

    try {
      const result = await runAgentAsync({
        cwd,
        agent: attemptConfig.agent,
        model: attemptConfig.model,
        prompt,
        timeoutSeconds: attemptTimeoutSeconds,
        promptDir: runDir,
        runDir,
        roleLabel: role,
        onSpawn: (pid) => updateRoleState(paths, role, { lastPid: pid }),
      });
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';

      if (result.status !== 0) {
        ensureDir(path.dirname(failLog));
        writeText(
          failLog,
          `# Agent Failure Log\n\n- attempt: ${attemptLabel}\n- agent: ${attemptConfig.agent}\n- model: ${attemptConfig.model}\n- exitStatus: ${result.status}\n\n## stdout\n\n${stdout.slice(0, 2000)}\n\n## stderr\n\n${stderr.slice(0, 2000)}\n`
        );
        throw new Error(`Agent ${attemptConfig.agent} failed with status ${result.status}`);
      }

      output = stdout.trim();
      if (output) writeText(stdoutPath, `${output}\n`);
      updateRoleState(paths, role, {
        status: 'completed',
        lastPid: null,
        finishedAt: nowIso(),
        lastError: null,
      });
      break;
    } catch (err) {
      const errorMessage = err.message ?? String(err);
      const hasReport = fileExists(reportPath) && fs.readFileSync(reportPath, 'utf8').trim();

      if (hasReport) {
        output = null;
        timedOut = errorMessage.includes('timed out');
        reportExisted = true;
        updateRoleState(paths, role, {
          status: 'completed_after_timeout',
          lastPid: null,
          finishedAt: nowIso(),
          lastError: errorMessage,
        });
        break;
      }

      const isTimedOut = errorMessage.includes('timed out');
      attemptErrors.push({
        label: attemptLabel,
        agent: attemptConfig.agent,
        model: attemptConfig.model,
        error: errorMessage,
        timedOut: isTimedOut,
      });

      ensureDir(path.dirname(failLog));
      if (isTimedOut) {
        timedOut = true;
        writeText(
          failLog,
          `# Agent Timeout Log\n\n- attempt: ${attemptLabel}\n- agent: ${attemptConfig.agent}\n- model: ${attemptConfig.model}\n- timeout: ${attemptTimeoutSeconds}s\n- error: ${errorMessage}\n`
        );
        updateRoleState(paths, role, {
          status: 'timed_out',
          lastPid: null,
          finishedAt: nowIso(),
          terminatedAt: nowIso(),
          lastError: errorMessage,
        });
      } else {
        writeText(
          failLog,
          `# Agent Failure Log\n\n- attempt: ${attemptLabel}\n- agent: ${attemptConfig.agent}\n- model: ${attemptConfig.model}\n- error: ${errorMessage}\n`
        );
        updateRoleState(paths, role, {
          status: 'error',
          lastPid: null,
          finishedAt: nowIso(),
          lastError: errorMessage,
        });
      }

      if (index < attempts.length - 1) {
        continue;
      }

      if (!isTimedOut) {
        throw new Error(
          `${role} failed after ${attemptErrors.length} attempt(s): ${attemptErrors.map((item) => `${item.label}=${item.agent}/${item.model}: ${item.error}`).join(' | ')}`
        );
      }
    }
  }

  // Collect isolation artifacts using runId for unique isolation directory
  const reportFilename = path.basename(reportPath);
  const { collected, isolationReportPath } = collectIsolationArtifacts({
    runId: state.runId,
    stageName,
    role,
    stageDir: paths.stageDir,
    reportFilename,
    runDir,
  });

  const text = readRoleOutput({ reportPath, stdout: output ?? '', isolationReportPath });
  if (!text && output) {
    writeText(reportPath, `${output}\n`);
  } else if (text) {
    if (!fileExists(reportPath)) writeText(reportPath, `${text}\n`);
  }

  const violated = detectProtectedWriteViolation(protectedFiles, protectedSnapshot, runDir);
  if (violated) {
    violatedFile = violated.file;
  }

  return { role, output: text || output || null, timedOut, reportExisted, violatedFile, attemptErrors };
}

const MUTATING_STAGES = ['implement-pass-1', 'implement-pass-2'];

/**
 * Ensure a git worktree exists for the given mutating stage.
 * Reuses existing worktree if already present. Returns null if not applicable.
 *
 * Uses a legal git worktree add: git worktree add -b <newBranch> <worktreePath> <baseRef>
 * where baseRef is a real git ref (branch/tag/SHA), not a filesystem path.
 */
function ensureWorktree({ spec, runDir, state, stageName }) {
  if (!MUTATING_STAGES.includes(stageName)) return null;

  const baseWorkspace = spec.workspace;
  const baseBranch = spec.branch ?? 'main';
  const branchName = `sprint/${state.runId.slice(0, 25)}/${stageName}`;
  const worktreePath = path.join(runDir, 'worktrees', stageName);
  
  // Resolve baseRef with robust fallback chain:
  // 1. spec.branch (local branch)
  // 2. origin/{spec.branch} (remote branch)
  // 3. HEAD (current checkout)
  // 4. main (default branch)
  const resolveBaseRef = () => {
    const candidates = [
      { ref: baseBranch, label: `spec.branch '${baseBranch}'` },
      { ref: `origin/${baseBranch}`, label: `remote branch 'origin/${baseBranch}'` },
      { ref: 'HEAD', label: 'current HEAD' },
      { ref: 'main', label: 'default branch main' },
    ];
    
    for (const candidate of candidates) {
      const result = spawnSync('git', ['rev-parse', '--verify', candidate.ref], {
        cwd: baseWorkspace,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (result.status === 0 && result.stdout?.trim()) {
        if (candidate.ref !== baseBranch) {
          appendTimeline(runDir, `Base ref resolved to ${candidate.label}`);
        }
        return candidate.ref;
      }
    }
    // Last resort: return 'main' even if verification failed
    appendTimeline(runDir, `Warning: Could not verify any base ref, using 'main'`);
    return 'main';
  };
  
  const baseRef = resolveBaseRef();

  // Reuse existing worktree if already created for this stage
  if (state.worktree?.worktreePath && fileExists(state.worktree.worktreePath)) {
    appendTimeline(runDir, `Reusing existing worktree at ${state.worktree.worktreePath}`);
    return state.worktree;
  }
  
  // Also check if worktree directory exists on disk (state may have been lost)
  // This handles resume scenarios where sprint.json lost worktree state
  if (fileExists(worktreePath)) {
    // Verify it's a valid worktree by checking for .git file
    const gitFile = path.join(worktreePath, '.git');
    if (fileExists(gitFile)) {
      const headSha = (spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 10_000,
      }).stdout ?? '').trim();
      
      if (headSha) {
        const recoveredWorktree = {
          worktreePath,
          branchName,
          headSha,
          baseBranch,
          baseWorkspace,
          dirtyFiles: [],
        };
        state.worktree = recoveredWorktree;
        appendTimeline(runDir, `Recovered existing worktree at ${worktreePath} (branch: ${branchName}, sha: ${headSha})`);
        return recoveredWorktree;
      }
    }
    // Invalid worktree directory - remove it
    appendTimeline(runDir, `Removing invalid worktree directory at ${worktreePath}`);
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }

  try {
    ensureDir(path.dirname(worktreePath));

    // Create a new worktree with a new branch based on baseRef (a real git ref)
    // Syntax: git worktree add -b <newBranch> <path> <startPoint>
    // where <startPoint> is baseRef (e.g., 'main' or 'origin/main')
    const result = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
      cwd: baseWorkspace,
      encoding: 'utf8',
      timeout: 30_000,
    });

    if (result.status !== 0) {
      const errMsg = result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
      appendTimeline(runDir, `Worktree creation failed: ${errMsg} — falling back to base workspace`);
      return null;
    }

    const headSha = (spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    }).stdout ?? '').trim();

    const worktreeInfo = {
      worktreePath,
      branchName,
      headSha,
      baseBranch,
      baseWorkspace, // Store for cleanup cwd
      dirtyFiles: [],
    };

    state.worktree = worktreeInfo;
    appendTimeline(runDir, `Created worktree at ${worktreePath} (branch: ${branchName}, baseRef: ${baseRef}, sha: ${headSha})`);
    return worktreeInfo;
  } catch (wtErr) {
    appendTimeline(runDir, `Worktree creation failed: ${wtErr.message} — falling back to base workspace`);
    return null;
  }
}

/**
 * Capture git status for the worktree and write git-status.json to stageDir.
 */
function captureGitStatus({ worktreePath, runDir, stageDir, state }) {
  if (!worktreePath || !fileExists(worktreePath)) return null;
  try {
    const statusResult = spawnSync('git', ['status', '--short'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const dirtyFiles = ((statusResult.stdout ?? '').trim().split('\n').filter(Boolean) || []);

    const gitStatus = {
      branch: (branchResult.stdout ?? '').trim(),
      headSha: (shaResult.stdout ?? '').trim(),
      worktreePath,
      dirtyFiles,
      baseBranch: state.worktree?.baseBranch ?? null,
      remoteBranch: state.worktree?.branchName ? `origin/${state.worktree.branchName}` : null,
    };

    const gitStatusPath = path.join(stageDir, 'git-status.json');
    writeJson(gitStatusPath, gitStatus);
    appendTimeline(runDir, `Git status: ${dirtyFiles.length} dirty files, sha: ${gitStatus.headSha}`);
    return gitStatus;
  } catch (err) {
    appendTimeline(runDir, `Git status capture failed: ${err.message}`);
    return null;
  }
}

/**
 * Remove the worktree from the filesystem (on halt).
 * Uses the stored baseWorkspace as cwd (the git repo root), not the worktree's parent dir.
 */
function cleanupWorktree({ state, runDir }) {
  if (!state.worktree?.worktreePath) return;
  const { worktreePath, baseWorkspace } = state.worktree;
  // Use the git repo root (baseWorkspace) as cwd, not the worktree's parent dir
  const gitCwd = baseWorkspace ?? runDir;
  try {
    const result = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: gitCwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status === 0) {
      appendTimeline(runDir, `Cleaned up worktree at ${worktreePath}`);
      state.worktree = null;
      return;
    }
    const errMsg = result.stderr?.trim() || result.stdout?.trim() || `git exited ${result.status}`;
    appendTimeline(runDir, `Worktree cleanup failed for ${worktreePath}: ${errMsg} — manual cleanup may be required`);
  } catch (cleanupErr) {
    appendTimeline(runDir, `Worktree cleanup failed for ${worktreePath}: ${cleanupErr.message} — manual cleanup may be required`);
  }
}

async function executeStage(runDir, state, spec) {
  const stageName = state.currentStage;
  const previousDecisionPath = path.join(
    runDir,
    'stages',
    `${String(state.currentStageIndex + 1).padStart(2, '0')}-${stageName}`,
    'decision.md',
  );
  const previousDecision = fileExists(previousDecisionPath)
    ? fs.readFileSync(previousDecisionPath, 'utf8')
    : '';

  const paths = ensureStagePaths(
    runDir,
    state.currentStageIndex,
    stageName,
  );
  const { stageDir, briefPath, producerPath, reviewerAPath, reviewerBPath, globalReviewerPath, decisionPath, scorecardPath } = paths;
  const protectedFiles = protectedArtifacts(runDir, paths);

  // Read handoff data for structured carry forward
  const handoffPath = path.join(stageDir, 'handoff.json');
  const handoff = fileExists(handoffPath) ? readJson(handoffPath) : null;
  const checkpointSummaryPath = path.join(stageDir, 'checkpoint-summary.md');
  const checkpointSummary = fileExists(checkpointSummaryPath)
    ? fs.readFileSync(checkpointSummaryPath, 'utf8')
    : null;

  writeText(briefPath, `${buildStageBrief(spec, stageName, state.currentRound, previousDecision, handoff, checkpointSummary)}\n`);

  // On round > 1, clear previous round's role reports so agents must regenerate them
  if (state.currentRound > 1) {
    const staleReports = [producerPath, reviewerAPath, reviewerBPath, globalReviewerPath];
    for (const fp of staleReports) {
      if (fileExists(fp)) {
        fs.unlinkSync(fp);
      }
    }
    appendTimeline(runDir, `Cleared previous round reports for stage ${stageName} round ${state.currentRound}`);
  }

  const outputs = {};
  const stageStartedAt = Date.now();
  const stageTimeoutMs = (spec.stageTimeoutMinutes ?? 30) * 60_000;

  // ── Phase 1: Producer (sequential) ────────────────────────────────────────
  appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} started (producer)`);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    'Producer is running.',
  ]);

  maybeAbort(runDir, state);
  heartbeatState(runDir, state, { currentRole: 'producer' });

  // Per-stage runtime check before producer
  const stageElapsedProducer = Date.now() - stageStartedAt;
  if (stageElapsedProducer > stageTimeoutMs) {
    state.status = 'halted';
    state.haltReason = {
      type: 'stage_timeout',
      stage: stageName,
      round: state.currentRound,
      details: `Stage ${stageName} exceeded ${(stageTimeoutMs / 60_000).toFixed(0)} minutes before producer`,
      blockers: [`Stage timeout before producer started after ${(stageElapsedProducer / 60_000).toFixed(1)} minutes`],
    };
    saveState(runDir, state);
    appendTimeline(runDir, `Sprint halted: ${state.haltReason.details}`);
    writeStageFailureArtifacts({
      runDir,
      state,
      stageName,
      stageDir,
      decisionPath,
      scorecardPath,
      summary: state.haltReason.details,
      blockers: state.haltReason.blockers,
    });
    cleanupRecordedRoleProcesses(paths, runDir);
    return { outcome: 'halt', summary: state.haltReason.details, blockers: state.haltReason.blockers, metrics: {} };
  }

  const producerConfig = roleConfig(spec, 'producer');
  const producerTimeoutSeconds = stageRoleTimeout(spec, stageName, 'producer');
  const producerPrompt = buildRolePrompt({
    spec,
    stage: stageName,
    round: state.currentRound,
    role: 'producer',
    runDir,
    stageDir,
    briefPath,
    producerPath,
    reviewerAPath,
    reviewerBPath,
  });
  const { reportPath: producerReportPath, stdoutPath: producerStdoutPath } = roleArtifactPaths(paths, 'producer');

  // Worktree setup for mutating stages
  const worktreeInfo = ensureWorktree({ spec, runDir, state, stageName });
  // branchWorkspace may not exist — fall back to spec.workspace (always valid)
  const producerWorkspace = worktreeInfo?.worktreePath ?? (fileExists(spec.branchWorkspace) ? spec.branchWorkspace : spec.workspace);

  if (fileExists(producerReportPath) && fs.readFileSync(producerReportPath, 'utf8').trim()) {
    outputs.producer = fs.readFileSync(producerReportPath, 'utf8').trim();
    updateRoleState(paths, 'producer', {
      stage: stageName,
      round: state.currentRound,
      status: 'completed',
      lastPid: null,
      finishedAt: nowIso(),
      timeoutSeconds: producerTimeoutSeconds,
      lastError: null,
    });
    appendTimeline(runDir, `producer skipped (report already exists) stage ${stageName} round ${state.currentRound}`);
    // Capture git status even for skipped producer (worktree may have changed)
    if (worktreeInfo?.worktreePath) {
      captureGitStatus({ worktreePath: worktreeInfo.worktreePath, runDir, stageDir, state });
    }
  } else {
    updateRoleState(paths, 'producer', {
      stage: stageName,
      round: state.currentRound,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      terminatedAt: null,
      lastPid: null,
      timeoutSeconds: producerTimeoutSeconds,
      lastError: null,
    });
    const protectedSnapshot = snapshotProtectedFiles(protectedFiles);
    const producerFailLog = path.join(stageDir, 'producer-failure.log');
    const producerWorklogPath = paths.producerWorklogPath;
    let producerOutput;
    let producerTimedOut = false;
    let extensionsUsed = 0;
    try {
      const result = await runAgentWithProgressCheck({
        cwd: producerWorkspace,
        agent: producerConfig.agent,
        model: producerConfig.model,
        prompt: producerPrompt,
        timeoutSeconds: producerTimeoutSeconds,
        promptDir: runDir,
        runDir,
        roleLabel: 'producer',
        worktreePath: worktreeInfo?.worktreePath,
        worklogPath: producerWorklogPath,
      });
      producerOutput = result.stdout;
      extensionsUsed = result.extensionsUsed ?? 0;
      if (extensionsUsed > 0) {
        appendTimeline(runDir, `Producer used ${extensionsUsed} timeout extensions`);
      }
    } catch (agentErr) {
      // Track consecutive timeouts for fuse mechanism
      const isTimeout = agentErr.message?.includes('timed out') || agentErr.message?.includes('ETIMEDOUT');
      if (isTimeout) {
        // Initialize consecutiveTimeouts if not present (resume from old state)
        if (!state.consecutiveTimeouts) state.consecutiveTimeouts = {};
        state.consecutiveTimeouts[stageName] = (state.consecutiveTimeouts[stageName] || 0) + 1;
        appendTimeline(runDir, `Producer timeout #${state.consecutiveTimeouts[stageName]} for stage ${stageName}`);
        
        // Fuse: halt after 2 consecutive timeouts on same stage
        if (state.consecutiveTimeouts[stageName] >= 2) {
          state.status = 'halted';
          state.haltReason = {
            type: 'repeated_timeout',
            stage: stageName,
            round: state.currentRound,
            details: `Producer timed out ${state.consecutiveTimeouts[stageName]} times on stage ${stageName}. Timeout may be too short or task too complex.`,
            blockers: [
              'Repeated timeout suggests insufficient timeout or overly complex task.',
              'Consider: 1) Increase timeout in stageRoleTimeouts, 2) Simplify task scope, 3) Check for infinite loops in agent.',
            ],
          };
          saveState(runDir, state);
          appendTimeline(runDir, `Sprint halted: repeated timeout on stage ${stageName}`);
          writeStageFailureArtifacts({
            runDir,
            state,
            stageName,
            stageDir,
            decisionPath,
            scorecardPath,
            summary: state.haltReason.details,
            blockers: state.haltReason.blockers,
          });
          cleanupRecordedRoleProcesses(paths, runDir);
          cleanupWorktree({ state, runDir });
          throw new Error(state.haltReason.details);
        }
      } else {
        // Reset counter on non-timeout error
        if (!state.consecutiveTimeouts) state.consecutiveTimeouts = {};
        state.consecutiveTimeouts[stageName] = 0;
      }
      
      // Write failure log
      if (producerFailLog) {
        ensureDir(path.dirname(producerFailLog));
        writeText(producerFailLog, `# Agent Failure Log\n\n- agent: ${producerConfig.agent}\n- model: ${producerConfig.model}\n- error: ${agentErr.message ?? String(agentErr)}\n- extensionsUsed: ${extensionsUsed}\n\n`);
      }
      
      if (fileExists(producerReportPath) && fs.readFileSync(producerReportPath, 'utf8').trim()) {
        appendTimeline(runDir, `producer spawnSync timed out but report exists — recovering stage ${stageName} round ${state.currentRound}`);
        producerOutput = null;
        producerTimedOut = true;
        updateRoleState(paths, 'producer', {
          status: 'completed_after_timeout',
          lastPid: null,
          finishedAt: nowIso(),
          terminatedAt: nowIso(),
          lastError: agentErr.message ?? String(agentErr),
        });
      } else {
        updateRoleState(paths, 'producer', {
          status: isTimeout ? 'timed_out' : 'error',
          lastPid: null,
          finishedAt: nowIso(),
          terminatedAt: isTimeout ? nowIso() : null,
          lastError: agentErr.message ?? String(agentErr),
        });
        throw agentErr;
      }
    }
    if (producerOutput) writeText(producerStdoutPath, `${producerOutput}\n`);
    outputs.producer = readRoleOutput({ reportPath: producerReportPath, stdout: producerOutput ?? '' });
    if (!fileExists(producerReportPath) || !fs.readFileSync(producerReportPath, 'utf8').trim()) {
      writeText(producerReportPath, `${outputs.producer}\n`);
    }
    updateRoleState(paths, 'producer', {
      status: producerTimedOut ? 'completed_after_timeout' : 'completed',
      lastPid: null,
      finishedAt: nowIso(),
      lastError: producerTimedOut ? 'Recovered after timeout because report existed on disk.' : null,
    });
    // Skip mtime-based violation check during timeout recovery — the producer may have
    // been mid-write when interrupted, causing spurious mtime changes on protected files.
    const producerViolated = producerTimedOut ? null : detectProtectedWriteViolation(protectedFiles, protectedSnapshot, runDir);
    if (producerViolated) {
      state.status = 'halted';
      state.haltReason = {
        type: 'protected_file_modified',
        stage: stageName,
        round: state.currentRound,
        details: `producer modified orchestrator-owned file ${producerViolated.file}`,
        blockers: [`Protected file modified: ${producerViolated.file}`],
      };
      saveState(runDir, state);
      appendTimeline(runDir, `Sprint halted: producer modified protected file ${producerViolated.file}`);
      writeStageFailureArtifacts({
        runDir,
        state,
        stageName,
        stageDir,
        decisionPath,
        scorecardPath,
        summary: state.haltReason.details,
        blockers: state.haltReason.blockers,
      });
      cleanupRecordedRoleProcesses(paths, runDir);
      cleanupWorktree({ state, runDir });
      throw new Error(state.haltReason.details);
    }
    appendTimeline(runDir, `producer completed stage ${stageName} round ${state.currentRound}`);
    // Reset consecutive timeout counter on successful completion
    if (!state.consecutiveTimeouts) state.consecutiveTimeouts = {};
    if (state.consecutiveTimeouts[stageName]) {
      state.consecutiveTimeouts[stageName] = 0;
    }
    // Capture git status after producer completes for reviewers to reference
    if (worktreeInfo?.worktreePath) {
      captureGitStatus({ worktreePath: worktreeInfo.worktreePath, runDir, stageDir, state });
    }
  }
  heartbeatState(runDir, state, { currentRole: null });

  // ── Phase 2: Reviewers in parallel ────────────────────────────────────────
  maybeAbort(runDir, state);
  heartbeatState(runDir, state, { currentRole: 'reviewer_a || reviewer_b' });

  // Per-stage runtime check before launching reviewers
  const stageElapsedReviewers = Date.now() - stageStartedAt;
  if (stageElapsedReviewers > stageTimeoutMs) {
    state.status = 'halted';
    state.haltReason = {
      type: 'stage_timeout',
      stage: stageName,
      round: state.currentRound,
      details: `Stage ${stageName} exceeded ${(stageTimeoutMs / 60_000).toFixed(0)} minutes before reviewers`,
      blockers: [`Stage timeout before reviewers after ${(stageElapsedReviewers / 60_000).toFixed(1)} minutes`],
    };
    saveState(runDir, state);
    appendTimeline(runDir, `Sprint halted: ${state.haltReason.details}`);
    writeStageFailureArtifacts({
      runDir,
      state,
      stageName,
      stageDir,
      decisionPath,
      scorecardPath,
      summary: state.haltReason.details,
      blockers: state.haltReason.blockers,
    });
    cleanupRecordedRoleProcesses(paths, runDir);
    cleanupWorktree({ state, runDir });
    return { outcome: 'halt', summary: state.haltReason.details, blockers: state.haltReason.blockers, metrics: {} };
  }

  appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} reviewers launching in parallel`);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    'Reviewers are running in parallel.',
  ]);

  // Run both reviewers in parallel — each wrapped in try/catch so one failure doesn't cancel the other
  const reviewerResults = [];
  const [resultA, resultB] = await Promise.all([
    runReviewerRole({ runDir, state, spec, paths, role: 'reviewer_a', worktreeInfo }).catch((err) => {
      appendTimeline(runDir, `reviewer_a threw unhandled error: ${err.message}`);
      return { role: 'reviewer_a', output: null, timedOut: false, reportExisted: false, violatedFile: null, error: String(err) };
    }),
    runReviewerRole({ runDir, state, spec, paths, role: 'reviewer_b', worktreeInfo }).catch((err) => {
      appendTimeline(runDir, `reviewer_b threw unhandled error: ${err.message}`);
      return { role: 'reviewer_b', output: null, timedOut: false, reportExisted: false, violatedFile: null, error: String(err) };
    }),
  ]);
  reviewerResults.push(resultA, resultB);

  // Collect outputs and timeout flags
  const reviewerTimeouts = [];
  const reviewerViolations = [];
  for (const result of reviewerResults) {
    if (result.error) {
      appendTimeline(runDir, `${result.role} error: ${result.error}`);
    }
    outputs[result.role] = result.output;
    if (result.timedOut) {
      appendTimeline(runDir, `${result.role} timed out stage ${stageName} round ${state.currentRound}`);
      reviewerTimeouts.push({ role: result.role, timedOut: true, hadReport: result.reportExisted });
    }
    if (result.violatedFile) {
      appendTimeline(runDir, `${result.role} modified protected file ${result.violatedFile} — report invalidated`);
      reviewerViolations.push({ role: result.role, violatedFile: result.violatedFile });
    }
  }
  heartbeatState(runDir, state, { currentRole: null });

  // ── Phase 3: Global reviewer (sequential, only if required) ──────────────
  const stageCriteria = spec.stageCriteria?.[stageName] ?? {};
  const globalReviewerRequired = stageCriteria.globalReviewerRequired === true;
  let globalReviewerOutput = null;
  let globalReviewerTimedOut = false;

  if (globalReviewerRequired) {
    maybeAbort(runDir, state);
    heartbeatState(runDir, state, { currentRole: 'global_reviewer' });
    appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} global_reviewer is required — running sequentially after A/B`);

    const globalReviewerConfig = roleConfig(spec, 'global_reviewer');
    if (!globalReviewerConfig) {
      appendTimeline(runDir, `global_reviewer config not found in spec — skipping`);
    } else {
      const globalReviewerPrompt = buildRolePrompt({
        spec,
        stage: stageName,
        round: state.currentRound,
        role: 'global_reviewer',
        runDir,
        stageDir,
        briefPath,
        producerPath,
        reviewerAPath,
        reviewerBPath,
        globalReviewerPath: paths.globalReviewerPath,
      });
      const { reportPath: grReportPath, stdoutPath: grStdoutPath } = roleArtifactPaths(paths, 'global_reviewer');

      if (fileExists(grReportPath) && fs.readFileSync(grReportPath, 'utf8').trim()) {
        globalReviewerOutput = fs.readFileSync(grReportPath, 'utf8').trim();
        updateRoleState(paths, 'global_reviewer', {
          stage: stageName,
          round: state.currentRound,
          status: 'completed',
          lastPid: null,
          finishedAt: nowIso(),
          timeoutSeconds: stageRoleTimeout(spec, stageName, 'global_reviewer'),
          lastError: null,
        });
        appendTimeline(runDir, `global_reviewer skipped (report already exists) stage ${stageName} round ${state.currentRound}`);
      } else {
        updateRoleState(paths, 'global_reviewer', {
          stage: stageName,
          round: state.currentRound,
          status: 'running',
          startedAt: nowIso(),
          finishedAt: null,
          terminatedAt: null,
          lastPid: null,
          timeoutSeconds: stageRoleTimeout(spec, stageName, 'global_reviewer'),
          lastError: null,
        });
        const protectedSnapshot = snapshotProtectedFiles(protectedFiles);
        const grFailLog = path.join(stageDir, 'global-reviewer-failure.log');
        let grOutput;
        try {
          grOutput = runAgent({
            cwd: worktreeInfo?.worktreePath ?? (fileExists(spec.branchWorkspace) ? spec.branchWorkspace : spec.workspace),
            agent: globalReviewerConfig.agent,
            model: globalReviewerConfig.model,
            prompt: globalReviewerPrompt,
            timeoutSeconds: stageRoleTimeout(spec, stageName, 'global_reviewer'),
            failLogPath: grFailLog,
            promptDir: runDir,
            runDir,
            roleLabel: 'global_reviewer',
          });
        } catch (grErr) {
          appendTimeline(runDir, `global_reviewer error: ${grErr.message}`);
          grOutput = null;
          updateRoleState(paths, 'global_reviewer', {
            status: grErr.message?.includes('timed out') ? 'timed_out' : 'error',
            lastPid: null,
            finishedAt: nowIso(),
            terminatedAt: grErr.message?.includes('timed out') ? nowIso() : null,
            lastError: grErr.message ?? String(grErr),
          });
        }
        if (grOutput) writeText(grStdoutPath, `${grOutput}\n`);
        globalReviewerOutput = readRoleOutput({ reportPath: grReportPath, stdout: grOutput ?? '' });
        if (globalReviewerOutput && !reportExistsAndNonEmpty(grReportPath)) {
          writeText(grReportPath, `${globalReviewerOutput}\n`);
        }
        if (reportExistsAndNonEmpty(grReportPath)) {
          updateRoleState(paths, 'global_reviewer', {
            status: 'completed',
            lastPid: null,
            finishedAt: nowIso(),
            lastError: null,
          });
        }
        const grViolated = detectProtectedWriteViolation(protectedFiles, protectedSnapshot, runDir);
        if (grViolated) {
          appendTimeline(runDir, `global_reviewer modified protected file ${grViolated.file} — report invalidated`);
          reviewerViolations.push({ role: 'global_reviewer', violatedFile: grViolated.file });
        }
        if (reportExistsAndNonEmpty(grReportPath)) {
          appendTimeline(runDir, `global_reviewer completed stage ${stageName} round ${state.currentRound}`);
        } else {
          appendTimeline(runDir, `global_reviewer produced no report for stage ${stageName} round ${state.currentRound}`);
        }
      }
    }
    heartbeatState(runDir, state, { currentRole: null });
  }

  return decideAndPersist({
    runDir,
    stageName,
    stageDir,
    decisionPath,
    scorecardPath,
    producerPath,
    reviewerAPath,
    reviewerBPath,
    globalReviewerPath,
    state,
    reviewerTimeouts: reviewerTimeouts.length > 0 ? reviewerTimeouts : null,
    reviewerViolations: reviewerViolations.length > 0 ? reviewerViolations : null,
  });
}

function abortRun(runId) {
  const runDir = path.join(sprintRoot, runId);
  const sprintFile = path.join(runDir, 'sprint.json');
  if (!fileExists(sprintFile)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const state = readJson(sprintFile);
  state.status = 'aborted';
  state.haltReason = {
    type: 'operator_abort',
    stage: state.currentStage,
    round: state.currentRound,
    details: 'Aborted by operator',
    blockers: [],
  };
  saveState(runDir, state);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${state.currentStage}`,
    `Round: ${state.currentRound}`,
    'Operator aborted this sprint.',
  ]);
  const paths = ensureStagePaths(runDir, state.currentStageIndex, state.currentStage);
  cleanupRecordedRoleProcesses(paths, runDir);
  terminateProcessTree(state.orchestratorPid, { runDir, label: 'orchestrator' });
  cleanupWorktree({ state, runDir });
}

function pauseRun(runId) {
  const runDir = path.join(sprintRoot, runId);
  const sprintFile = path.join(runDir, 'sprint.json');
  if (!fileExists(sprintFile)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const state = readJson(sprintFile);
  state.status = 'paused';
  state.haltReason = {
    type: 'operator_pause',
    stage: state.currentStage,
    round: state.currentRound,
    details: 'Paused by operator',
    blockers: [],
  };
  saveState(runDir, state);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${state.currentStage}`,
    `Round: ${state.currentRound}`,
    'Operator paused this sprint.',
  ]);
  const paths = ensureStagePaths(runDir, state.currentStageIndex, state.currentStage);
  cleanupRecordedRoleProcesses(paths, runDir);
}

function listRuns() {
  ensureDir(sprintRoot);
  const entries = [];
  for (const entry of fs.readdirSync(sprintRoot)) {
    const sprintFile = path.join(sprintRoot, entry, 'sprint.json');
    if (!fileExists(sprintFile)) continue;
    try {
      const state = readJson(sprintFile);
      const elapsedMin = ((Date.now() - (Date.parse(state.createdAt) || Date.now())) / 60_000).toFixed(0);
      entries.push({
        runId: entry,
        task: state.taskId ?? '?',
        title: (state.title ?? '').slice(0, 40),
        status: state.status ?? '?',
        stage: `${state.currentStage ?? '?'} (${(state.currentStageIndex ?? 0) + 1})`,
        round: state.currentRound ?? '?',
        elapsed: `${elapsedMin}m`,
      });
    } catch {}
  }

  if (entries.length === 0) {
    console.log('No sprint runs found.');
    return;
  }

  // Sort by createdAt descending (newest first)
  entries.reverse();

  const statusIcon = (s) => s === 'completed' ? '[OK]' : s === 'running' ? '>>>' : s === 'halted' ? '[!!]' : s === 'paused' ? '[||]' : '[??]';

  const lines = [
    '=== Sprint Runs ===',
    '',
  ];

  for (const e of entries) {
    lines.push(`  ${statusIcon(e.status)} ${e.status.padEnd(10)} ${e.runId.slice(0, 50)}`);
    lines.push(`     ${e.task} | stage ${e.stage} | round ${e.round} | ${e.elapsed}`);
  }

  lines.push('');
  lines.push(`  Total: ${entries.length} runs`);
  console.log(lines.join('\n'));
}

function showStatus(runId) {
  const runDir = path.join(sprintRoot, runId);
  const sprintFile = path.join(runDir, 'sprint.json');
  if (!fileExists(sprintFile)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const state = reconcileRunState(runDir, readJson(sprintFile));
  const spec = loadSpec(state);
  const now = Date.now();
  const createdMs = Date.parse(state.createdAt) || now;
  const heartbeatMs = Date.parse(state.lastHeartbeatAt) || now;
  const elapsedMin = ((now - createdMs) / 60_000).toFixed(1);
  const heartbeatAgeSec = ((now - heartbeatMs) / 1000).toFixed(0);
  const maxRuntime = spec.maxRuntimeMinutes ?? 90;
  const maxRounds = state.maxRoundsPerStage ?? 3;

  // Find latest scorecard
  const stageDirName = `${String(state.currentStageIndex + 1).padStart(2, '0')}-${state.currentStage}`;
  const scorecardFile = path.join(runDir, 'stages', stageDirName, 'scorecard.json');
  const scorecard = fileExists(scorecardFile) ? readJson(scorecardFile) : null;

  // Count completed stages by scanning decision files
  const stagesDir = path.join(runDir, 'stages');
  const completedStages = [];
  if (fileExists(stagesDir)) {
    for (const entry of fs.readdirSync(stagesDir)) {
      const decFile = path.join(stagesDir, entry, 'decision.md');
      if (fileExists(decFile)) {
        const text = fs.readFileSync(decFile, 'utf8');
        const outcomeMatch = text.match(/Outcome:\s*(\w+)/);
        completedStages.push({ dir: entry, outcome: outcomeMatch?.[1] ?? 'unknown' });
      }
    }
  }

  // Latest timeline entries (last 8)
  const timelineFile = path.join(runDir, 'timeline.md');
  let recentEvents = [];
  if (fileExists(timelineFile)) {
    recentEvents = fs.readFileSync(timelineFile, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .slice(-8)
      .map((l) => l.replace(/^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\d{3}Z\s*/, ''));
  }

  // Build driver dashboard
  const statusIcon = state.status === 'running' ? '>>>' : state.status === 'completed' ? '[OK]' : '[!!]';
  const aliveHint = state.status === 'running'
    ? (parseInt(heartbeatAgeSec, 10) > 120 ? `WARNING: heartbeat ${heartbeatAgeSec}s ago` : `heartbeat ${heartbeatAgeSec}s ago`)
    : '';

  const lines = [
    `=== Sprint Dashboard ===`,
    '',
    `  ${statusIcon} ${state.status.toUpperCase()}`,
    `  Task:     ${state.title}`,
    `  Run:      ${runId}`,
    '',
    `  Stage:    ${state.currentStage}  (${state.currentStageIndex + 1}/${spec.stages.length})`,
    `  Round:    ${state.currentRound} / ${maxRounds}`,
    `  Role:     ${state.currentRole ?? 'idle'}`,
    '',
    `  Elapsed:  ${elapsedMin} min / ${maxRuntime} min max`,
    `  ${aliveHint}`,
    '',
  ];

  // Stage progress bar
  if (spec.stages.length > 0) {
    lines.push('  Stages:');
    for (const stage of spec.stages) {
      const done = completedStages.find((s) => s.dir.includes(stage));
      const isCurrent = stage === state.currentStage;
      const marker = done ? (done.outcome === 'advance' ? ' [PASS]' : ` [${done.outcome}]`) : (isCurrent ? ' >>' : ' --');
      lines.push(`    ${stage}${marker}`);
    }
    lines.push('');
  }

  // Latest scorecard
  if (scorecard) {
    lines.push('  Latest round verdict:');
    lines.push(`    reviewer_a: ${scorecard.reviewerAVerdict ?? '?'}`);
    lines.push(`    reviewer_b: ${scorecard.reviewerBVerdict ?? '?'}`);
    lines.push(`    approvals:  ${scorecard.approvalCount ?? 0} / 2 required`);
    if (scorecard.failureClassification) {
      lines.push(`    failure:    ${scorecard.failureClassification}`);
      lines.push(`    source:     ${scorecard.failureSource ?? 'n/a'}`);
    }
    if (scorecard.blockerCount > 0) {
      lines.push(`    blockers:   ${scorecard.blockerCount}`);
      for (const b of (scorecard.blockers ?? []).slice(0, 3)) {
        lines.push(`      - ${b.slice(0, 120)}`);
      }
    }
    lines.push('');
  }

  // Recent events
  if (recentEvents.length > 0) {
    lines.push('  Recent events:');
    for (const evt of recentEvents) {
      lines.push(`    ${evt}`);
    }
    lines.push('');
  }

  // Controls reminder
  lines.push('  Controls:');
  lines.push(`    npm run ai-sprint -- --status ${runId}`);
  lines.push(`    npm run ai-sprint -- --pause  ${runId}`);
  lines.push(`    npm run ai-sprint -- --abort  ${runId}`);
  lines.push(`    npm run ai-sprint -- --resume ${runId}`);
  lines.push('');

  console.log(lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log([
      'AI Sprint Orchestrator',
      '',
      'Usage:',
      '  node run.mjs --self-check                            Validate package-local environment',
      '  node run.mjs --task <task-id> [--task-spec <path>]   Start a new sprint',
      '  node run.mjs --resume <run-id>                        Resume a halted/aborted sprint',
      '  node run.mjs --status <run-id>                        Show sprint dashboard',
      '  node run.mjs --list                                   List all sprint runs',
      '  node run.mjs --pause <run-id>                         Pause a running sprint',
      '  node run.mjs --abort <run-id>                         Abort a sprint',
      '  node run.mjs --archive <run-id>                       Archive a completed/halted sprint',
      '  node run.mjs --task <task-id> --runtime-root <path>  Override runtime output root',
      '',
      'Sprints auto-archive on completion or halt.',
      `Task specs are loaded from ${path.relative(packageRoot, path.join(referencesRoot, 'specs'))}/<task-id>.json`,
      `Runtime output defaults to ${defaultRuntimeRoot}`,
      'Override with --task-spec <path> to use a custom spec file.',
    ].join('\n'));
    return;
  }

  if (args['self-check']) {
    if (args.runtimeRoot) {
      configureRuntimeRoots(args.runtimeRoot);
    } else {
      configureRuntimeRoots(runtimeRoot);
    }
    runSelfCheck();
    return;
  }

  if (args.list) {
    listRuns();
    return;
  }

  if (args.archive) {
    try {
      const archiveDir = archiveRunById(args.archive);
      console.log(`Archived: ${archiveDir}`);
    } catch (err) {
      console.error(`Archive failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.abort) {
    abortRun(args.abort);
    console.log(`Aborted sprint ${args.abort}`);
    return;
  }

  if (args.pause) {
    pauseRun(args.pause);
    console.log(`Paused sprint ${args.pause}`);
    return;
  }

  if (args.status) {
    showStatus(args.status);
    return;
  }

  if (args.runtimeRoot) {
    configureRuntimeRoots(args.runtimeRoot);
  } else {
    configureRuntimeRoots(runtimeRoot);
  }

  const { runDir, state } = loadOrInitState(args);
  const spec = loadSpec(state, args);

  // Register graceful shutdown handlers now that state and runDir are available.
  // This ensures uncaught exceptions during the sprint loop write the halted state
  // to disk instead of leaving it stuck at 'running'.
  const gracefulHalt = (signal, detail) => {
    if (state.status === 'running') {
      state.status = 'halted';
      state.haltReason = {
        type: 'uncaught_exception',
        stage: state.currentStage,
        round: state.currentRound,
        details: String(detail),
        blockers: [String(detail)],
      };
      try {
        saveState(runDir, state);
        appendTimeline(runDir, `Sprint halted by uncaught ${signal}: ${String(detail)}`);
      } catch (saveErr) {
        console.error(`Failed to write halted state: ${saveErr.message}`);
      }
    }
    console.error(`Fatal ${signal}: ${detail}`);
    process.exitCode = 1;
  };
  process.on('uncaughtException', (err) => {
    gracefulHalt('uncaughtException', err.stack ?? err.message);
  });
  process.on('unhandledRejection', (reason) => {
    gracefulHalt('unhandledRejection', String(reason));
  });

  // Pre-flight check: verify acpx is available (the actual execution entry point).
  // We do NOT check agent names with 'which' because acpx resolves agents via its
  // own registry (npx, built-in commands, etc.). Checking agent binaries directly
  // would cause false positives and is Linux-only.
  if (!args.status && !args.list && !args.archive && !args.abort && !args.pause) {
    const acpxCheck = checkAcpxAvailable();
    if (acpxCheck.status !== 0) {
      appendTimeline(runDir, `Pre-flight check FAILED: acpx not available`);
      throw new Error(`acpx not available. Install it first: npm install -g acpx`);
    }
    appendTimeline(runDir, `Pre-flight check OK: acpx available`);
  }

  const sprintStartedAt = Date.parse(state.createdAt) || Date.now();

  // Acquire exclusive lock to prevent concurrent orchestrators
  const lockPath = path.join(runDir, 'orchestrator.lock');
  if (fileExists(lockPath)) {
    const lockData = readJson(lockPath);
    const lockAge = Date.now() - Date.parse(lockData.acquiredAt || 0);
    if (lockData.pid && pidExists(lockData.pid) && lockData.pid !== process.pid) {
      if (lockAge < 30 * 60 * 1000) { // lock valid for 30 min
        throw new Error(`Another orchestrator (PID ${lockData.pid}) is running. Acquired at ${lockData.acquiredAt}. Aborting.`);
      }
    }
    // Clean up expired or stale lock
    if (lockAge >= 30 * 60 * 1000 || !pidExists(lockData.pid)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  writeJson(lockPath, { pid: process.pid, acquiredAt: nowIso() });

  appendTimeline(runDir, state.currentRound === 1 && state.currentStageIndex === 0 ? 'Sprint execution started' : 'Sprint resumed');

  try {
    while (state.status === 'running') {
      heartbeatState(runDir, state);

      // Global runtime check
      const elapsedMinutes = (Date.now() - sprintStartedAt) / 60_000;
      const maxRuntime = state.maxRuntimeMinutes ?? spec.maxRuntimeMinutes ?? 90;
      if (elapsedMinutes > maxRuntime) {
        state.status = 'halted';
        state.haltReason = {
          type: 'max_runtime_exceeded',
          stage: state.currentStage,
          round: state.currentRound,
          details: `Sprint exceeded ${maxRuntime} minutes (elapsed: ${elapsedMinutes.toFixed(1)}min)`,
          blockers: ['Runtime limit exceeded.'],
        };
        saveState(runDir, state);
        appendTimeline(runDir, `Sprint halted: ${state.haltReason.details}`);
        updateSummaryWithClassification(runDir, [
          `Status: ${state.status}`,
          `Stage: ${state.currentStage}`,
          `Round: ${state.currentRound}`,
          `Halt reason: ${state.haltReason.details}`,
        ], readStageFailureClassification(runDir, state));
        const paths = ensureStagePaths(runDir, state.currentStageIndex, state.currentStage);
        cleanupRecordedRoleProcesses(paths, runDir);
        break;
      }

      const decision = await executeStage(runDir, state, spec);
      advanceState(state, spec, decision, { runDir });
      saveState(runDir, state);
      if (state.status === 'completed') {
        cleanupWorktree({ state, runDir });
        appendTimeline(runDir, 'Sprint completed');
        updateSummary(runDir, [
          `Status: ${state.status}`,
          `Stage: ${state.currentStage}`,
          `Round: ${state.currentRound}`,
          ...(state.mergePending
            ? [`Merge pending: push branch '${state.mergePending.targetBranch}' before merge.`]
            : ['All stages finished.']),
        ]);
      }
      if (state.status === 'halted') {
        const paths = ensureStagePaths(runDir, state.currentStageIndex, state.currentStage);
        cleanupRecordedRoleProcesses(paths, runDir);
        cleanupWorktree({ state, runDir });
        appendTimeline(runDir, `Sprint halted: ${state.haltReason?.details ?? 'unknown reason'}`);
        updateSummaryWithClassification(runDir, [
          `Status: ${state.status}`,
          `Stage: ${state.currentStage}`,
          `Round: ${state.currentRound}`,
          `Halt reason: ${state.haltReason?.details ?? 'unknown reason'}`,
        ], readStageFailureClassification(runDir, state));
      }
    }
  } catch (error) {
    if (state.status !== 'halted') {
      state.status = 'halted';
      state.haltReason = {
        type: 'orchestrator_error',
        stage: state.currentStage,
        round: state.currentRound,
        details: String(error),
        blockers: [String(error)],
      };
      const paths = ensureStagePaths(runDir, state.currentStageIndex, state.currentStage);
      cleanupRecordedRoleProcesses(paths, runDir);
      cleanupWorktree({ state, runDir });
      saveState(runDir, state);
      appendTimeline(runDir, `Sprint halted by orchestrator error: ${String(error)}`);
      updateSummaryWithClassification(runDir, [
        `Status: ${state.status}`,
        `Stage: ${state.currentStage}`,
        `Round: ${state.currentRound}`,
        `Halt reason: ${String(error)}`,
      ], readStageFailureClassification(runDir, state) ?? inferFailureClassification({
        summary: String(error),
        blockers: [String(error)],
      }));
    }
  }

  // Auto-archive if sprint reached a terminal state
  if (state.status === 'completed' || state.status === 'halted') {
    try {
      const archiveDir = archiveRunById(args.resume || path.basename(runDir));
      appendTimeline(runDir, `Auto-archived to ${path.relative(runtimeRoot, archiveDir)}`);
      console.log(`Archived: ${archiveDir}`);
    } catch (archiveErr) {
      // Archive failure must not block orchestrator exit
      console.error(`Auto-archive failed: ${archiveErr.message}`);
    }
  }

  // Release lock
  try { fs.unlinkSync(lockPath); } catch {}

  console.log(runDir);
}

// Only run main() when executed directly, not when imported for testing
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // main() is async and may throw. The try/catch inside main() handles
    // errors within its body, but rejections from the Promise itself land here.
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
