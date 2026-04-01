import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { decideStage, buildStageMetrics, buildHandoff } from './lib/decision.mjs';
import { ensureDir, appendText, fileExists, readJson, writeJson, writeText } from './lib/state-store.mjs';
import { buildRolePrompt, buildStageBrief, getTaskSpec } from './lib/task-specs.mjs';
import { archiveRunById } from './lib/archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sprintRoot = path.join(repoRoot, 'ops', 'ai-sprints');

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
    worktree: null,  // { worktreePath, branchName, headSha, baseBranch } — set by ensureWorktree
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
    const state = readJson(sprintFile);
    if (state.status === 'halted' || state.status === 'aborted') {
      // Validate: if halted mid-stage, the previous stage must have advanced
      if (state.currentStageIndex > 0) {
        const prevStageName = loadSpec(state, args).stages[state.currentStageIndex - 1];
        const prevDecisionPath = path.join(runDir, 'stages', `${String(state.currentStageIndex).padStart(2, '0')}-${prevStageName}`, 'decision.md');
        if (fileExists(prevDecisionPath)) {
          const prevDecisionText = fs.readFileSync(prevDecisionPath, 'utf8');
          const outcomeMatch = prevDecisionText.match(/Outcome:\s*(\w+)/);
          if (outcomeMatch && outcomeMatch[1] !== 'advance') {
            throw new Error(`Cannot resume: previous stage "${prevStageName}" outcome was "${outcomeMatch[1]}" (expected "advance"). Fix the previous stage first.`);
          }
        }
      }
      const previousStatus = state.status;
      state.status = 'running';
      state.haltReason = null;
      state.updatedAt = nowIso();
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

function runAgent({ cwd, agent, model, prompt, timeoutSeconds = 1800, failLogPath = null }) {
  const promptFile = path.join(os.tmpdir(), `ai-sprint-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
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
        'acpx',
        ['--cwd', cwd, '--approve-all', '--model', model, '--timeout', String(timeoutSeconds), agent, 'exec', '-f', promptFile],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: (timeoutSeconds + 60) * 1000,
          shell: false,
        },
      );
    }
  } finally {
    fs.rmSync(promptFile, { force: true });
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error || result.status !== 0) {
    if (failLogPath) {
      ensureDir(path.dirname(failLogPath));
      writeText(failLogPath, `# Agent Failure Log\n\n- agent: ${agent}\n- model: ${model}\n- exitStatus: ${result.status ?? 'N/A'}\n- error: ${result.error?.message ?? 'none'}\n\n## stdout\n\n${stdout}\n\n## stderr\n\n${stderr}\n`);
    }
    if (result.error) throw result.error;
    throw new Error(`Agent ${agent} failed with status ${result.status}\n${stdout.slice(0, 2000)}\n${stderr.slice(0, 2000)}`);
  }

  return stdout.trim();
}

/**
 * Async agent runner using spawn (non-blocking) — used for parallel reviewer execution.
 * Returns a Promise that resolves with { stdout, stderr, status } or rejects on error.
 */
function runAgentAsync({ cwd, agent, model, prompt, timeoutSeconds = 1800 }) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const promptFile = path.join(os.tmpdir(), `ai-sprint-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);

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
        cleanup();
        try { proc?.kill(); } catch {}
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
        proc = spawn('acpx', [
          '--cwd', cwd, '--approve-all', '--model', model,
          '--timeout', String(timeoutSeconds), agent, 'exec', '-f', promptFile,
        ], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          shell: false,
        });
      }
    } catch (spawnErr) {
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Failed to spawn agent ${agent}: ${spawnErr.message}`));
      return;
    }

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status: code });
      }
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

function roleConfig(spec, role) {
  if (role === 'producer') return spec.producer;
  if (role === 'reviewer_a') return spec.reviewerA;
  if (role === 'reviewer_b') return spec.reviewerB;
  throw new Error(`Unknown role: ${role}`);
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
    decisionPath: path.join(stageDir, 'decision.md'),
    scorecardPath: path.join(stageDir, 'scorecard.json'),
    producerStdoutPath: path.join(stageDir, 'producer-stdout.log'),
    reviewerAStdoutPath: path.join(stageDir, 'reviewer-a-stdout.log'),
    reviewerBStdoutPath: path.join(stageDir, 'reviewer-b-stdout.log'),
    producerWorklogPath: path.join(stageDir, 'producer-worklog.md'),
    reviewerAWorklogPath: path.join(stageDir, 'reviewer-a-worklog.md'),
    reviewerBWorklogPath: path.join(stageDir, 'reviewer-b-worklog.md'),
    producerStatePath: path.join(stageDir, 'producer-state.json'),
    reviewerAStatePath: path.join(stageDir, 'reviewer-a-state.json'),
    reviewerBStatePath: path.join(stageDir, 'reviewer-b-state.json'),
  };

  const placeholderFiles = [
    paths.producerWorklogPath,
    paths.reviewerAWorklogPath,
    paths.reviewerBWorklogPath,
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
  ];
  for (const [file, role] of placeholderStates) {
    if (!fileExists(file)) {
      writeJson(file, {
        role,
        stage: stageName,
        round: 0,
        status: 'idle',
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
  return { reportPath: paths.reviewerBPath, stdoutPath: paths.reviewerBStdoutPath };
}

function readRoleOutput({ reportPath, stdout }) {
  if (fileExists(reportPath)) {
    const report = fs.readFileSync(reportPath, 'utf8').trim();
    if (report) {
      return report;
    }
  }
  return String(stdout ?? '').trim();
}

function protectedArtifacts(runDir, paths) {
  // Roles must not modify orchestrator-owned run-level and stage-level truth sources.
  // mtime checks are still useful to catch accidental writes by producer/reviewer roles.
  return [
    path.join(runDir, 'latest-summary.md'),
    path.join(runDir, 'timeline.md'),
    paths.decisionPath,
    paths.scorecardPath,
  ];
}

function snapshotProtectedFiles(files) {
  const snapshot = {};
  for (const file of files) {
    snapshot[file] = fileExists(file) ? fs.statSync(file).mtimeMs : null;
  }
  return snapshot;
}

function detectProtectedWriteViolation(files, snapshot) {
  for (const file of files) {
    const previous = snapshot[file] ?? null;
    const current = fileExists(file) ? fs.statSync(file).mtimeMs : null;
    if (previous !== current) return file;
  }
  return null;
}

function decideAndPersist({ runDir, stageName, stageDir, decisionPath, scorecardPath, producerPath, reviewerAPath, reviewerBPath, state, reviewerTimeouts = null }) {
  // Identify genuinely missing reports (not just timeouts with no report)
  const timedOutRoles = new Set((reviewerTimeouts ?? []).map((r) => r.role));
  const missingFiles = [];
  if (!fileExists(producerPath)) missingFiles.push(`producer: ${producerPath}`);
  if (!fileExists(reviewerAPath) && !timedOutRoles.has('reviewer_a')) missingFiles.push(`reviewer_a: ${reviewerAPath} (timed out)`);
  if (!fileExists(reviewerBPath) && !timedOutRoles.has('reviewer_b')) missingFiles.push(`reviewer_b: ${reviewerBPath} (timed out)`);

  if (missingFiles.length > 0) {
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
      reviewerTimeouts: reviewerTimeouts ?? null,
      updatedAt: nowIso(),
    });
    appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} decision: error (missing reports)`);
    updateSummary(runDir, [
      `Status: ${state.status}`,
      `Stage: ${stageName}`,
      `Round: ${state.currentRound}`,
      `Outcome: error`,
      `Missing: ${missingFiles.join('; ')}`,
    ]);
    return { outcome: 'error', summary: `Missing reports: ${missingFiles.join('; ')}`, blockers: missingFiles, metrics: {} };
  }

  const producer = fs.readFileSync(producerPath, 'utf8');
  const reviewerA = fs.readFileSync(reviewerAPath, 'utf8');
  const reviewerB = fs.readFileSync(reviewerBPath, 'utf8');
  const decision = decideStage({
    stageCriteria: loadSpec(state).stageCriteria?.[stageName],
    producer,
    reviewerA,
    reviewerB,
    currentRound: state.currentRound,
    maxRoundsPerStage: state.maxRoundsPerStage,
  });

  const content = [
    `# Decision`,
    '',
    `- Stage: ${stageName}`,
    `- Round: ${state.currentRound}`,
    `- Outcome: ${decision.outcome}`,
    '',
    `## Summary`,
    decision.summary,
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
  ].join('\n');

  writeText(decisionPath, `${content}\n`);

  const scorecard = {
    stage: stageName,
    round: state.currentRound,
    outcome: decision.outcome,
    summary: decision.summary,
    approvalCount: decision.metrics.approvalCount,
    blockerCount: decision.metrics.blockerCount,
    reviewerAVerdict: decision.metrics.reviewerAVerdict,
    reviewerBVerdict: decision.metrics.reviewerBVerdict,
    producerSectionChecks: decision.metrics.producerSectionChecks,
    reviewerSectionChecks: decision.metrics.reviewerSectionChecks,
    producerChecks: decision.metrics.producerChecks,
    reviewerAChecks: decision.metrics.reviewerAChecks,
    reviewerBChecks: decision.metrics.reviewerBChecks,
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
      producer,
      metrics: decision.metrics,
      stageName,
      round: state.currentRound,
    });
    const handoffPath = path.join(stageDir, 'handoff.json');
    writeJson(handoffPath, handoff);
  }
  appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} decision: ${decision.outcome}`);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    `Outcome: ${decision.outcome}`,
    `Approval count: ${decision.metrics.approvalCount}/2`,
    `Blocker count: ${decision.metrics.blockerCount}`,
    ...(decision.blockers.length ? [`Top blocker: ${decision.blockers[0]}`] : ['Top blocker: none']),
  ]);
  return decision;
}

/**
 * Run merge gate: fetch origin and compare local vs remote HEAD SHA.
 * Returns { localHeadSha, remoteHeadSha, shaMatch }.
 * Writes result to stages/<stage>/merge-gate.json.
 */
function runMergeGateCheck({ runDir, state, spec }) {
  const workspace = state.worktree?.worktreePath ?? spec.workspace;
  const remote = 'origin';

  try {
    // Fetch latest remote HEAD
    spawnSync('git', ['fetch', remote], { cwd: workspace, encoding: 'utf8', timeout: 60_000 });

    const localSha = (spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace, encoding: 'utf8', timeout: 10_000,
    }).stdout ?? '').trim();

    const remoteSha = (spawnSync('git', ['rev-parse', `${remote}/HEAD`], {
      cwd: workspace, encoding: 'utf8', timeout: 10_000,
    }).stdout ?? '').trim();

    const shaMatch = localSha === remoteSha;

    const result = { localHeadSha: localSha, remoteHeadSha: remoteSha, shaMatch };

    // Write to verify stage directory
    const stageDirName = `${String(state.currentStageIndex + 1).padStart(2, '0')}-${state.currentStage}`;
    const mergeGatePath = path.join(runDir, 'stages', stageDirName, 'merge-gate.json');
    writeJson(mergeGatePath, result);
    appendTimeline(runDir, `Merge gate: local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)} match=${shaMatch}`);

    return result;
  } catch (gateErr) {
    appendTimeline(runDir, `Merge gate check failed: ${gateErr.message}`);
    return { localHeadSha: null, remoteHeadSha: null, shaMatch: false, error: gateErr.message };
  }
}

function advanceState(state, spec, decision, { runDir } = {}) {
  if (decision.outcome === 'advance') {
    if (state.currentStageIndex >= spec.stages.length - 1) {
      // Merge gate check before completing final stage
      if (runDir) {
        const mergeGate = runMergeGateCheck({ runDir, state, spec });
        if (!mergeGate.shaMatch) {
          state.status = 'halted';
          state.haltReason = {
            type: 'merge_gate_failed',
            stage: state.currentStage,
            round: state.currentRound,
            details: `Merge gate failed: local SHA ${mergeGate.localHeadSha?.slice(0, 7) ?? '?'} != remote HEAD ${mergeGate.remoteHeadSha?.slice(0, 7) ?? '?'}. Push or merge before completing.`,
            blockers: ['Local SHA does not match remote PR head. Fetch and merge or rebase before completing.'],
            mergeGate,
          };
          return;
        }
      }
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
      state.currentRound = 1;
      return;
    }
    state.currentRound += 1;
    return;
  }

  // Both 'halt' and 'error' outcomes halt the sprint
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

  state.status = 'halted';
  state.haltReason = {
    type: 'stale_orchestrator',
    stage: state.currentStage,
    round: state.currentRound,
    details: `Orchestrator pid ${state.orchestratorPid ?? 'unknown'} is no longer alive.`,
    blockers: ['The sprint process ended before stage completion. Resume or restart the run.'],
  };
  saveState(runDir, state);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${state.currentStage}`,
    `Round: ${state.currentRound}`,
    `Halt reason: ${state.haltReason.details}`,
  ]);
  appendTimeline(runDir, `Sprint reconciled to halted: ${state.haltReason.details}`);
  cleanupWorktree({ state, runDir });
  return state;
}

/**
 * Execute a single reviewer role asynchronously with independent timeout tracking.
 * Returns a result object: { role, output, timedOut, reportExisted, violatedFile }
 */
async function runReviewerRole({ runDir, state, spec, paths, role }) {
  const stageName = state.currentStage;
  const config = roleConfig(spec, role);
  const { reportPath, stdoutPath } = roleArtifactPaths(paths, role);
  const failLog = path.join(paths.stageDir, `${role.replace('_', '-')}-failure.log`);

  // Skip if report already exists
  if (fileExists(reportPath) && fs.readFileSync(reportPath, 'utf8').trim()) {
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
  });
  const timeoutSeconds = stageRoleTimeout(spec, stageName, role);
  const cwd = spec.workspace;

  let output = null;
  let timedOut = false;
  let violatedFile = null;

  try {
    const result = await runAgentAsync({ cwd, agent: config.agent, model: config.model, prompt, timeoutSeconds });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    if (result.status !== 0) {
      // Agent returned non-zero exit
      ensureDir(path.dirname(failLog));
      writeText(failLog, `# Agent Failure Log\n\n- agent: ${config.agent}\n- model: ${config.model}\n- exitStatus: ${result.status}\n\n## stdout\n\n${stdout.slice(0, 2000)}\n\n## stderr\n\n${stderr.slice(0, 2000)}\n`);
      throw new Error(`Agent ${config.agent} failed with status ${result.status}`);
    }

    output = stdout.trim();
    if (output) writeText(stdoutPath, `${output}\n`);
  } catch (err) {
    // Check if the agent wrote its report despite the error
    if (fileExists(reportPath) && fs.readFileSync(reportPath, 'utf8').trim()) {
      output = null;
      timedOut = true;
    } else if (err.message?.includes('timed out')) {
      timedOut = true;
      ensureDir(path.dirname(failLog));
      writeText(failLog, `# Agent Timeout Log\n\n- agent: ${config.agent}\n- model: ${config.model}\n- timeout: ${timeoutSeconds}s\n- error: ${err.message}\n`);
    } else {
      // Re-throw unexpected errors (but don't lose the fail log)
      ensureDir(path.dirname(failLog));
      writeText(failLog, `# Agent Failure Log\n\n- agent: ${config.agent}\n- model: ${config.model}\n- error: ${err.message}\n`);
      throw err;
    }
  }

  const text = readRoleOutput({ reportPath, stdout: output ?? '' });
  if (!text && output) {
    writeText(reportPath, `${output}\n`);
  } else if (text) {
    if (!fileExists(reportPath)) writeText(reportPath, `${text}\n`);
  }

  const violated = detectProtectedWriteViolation(protectedFiles, protectedSnapshot);
  if (violated) {
    violatedFile = violated;
  }

  return { role, output: text || output || null, timedOut, reportExisted: false, violatedFile };
}

const MUTATING_STAGES = ['implement-pass-1', 'implement-pass-2'];

/**
 * Ensure a git worktree exists for the given mutating stage.
 * Reuses existing worktree if already present. Returns null if not applicable.
 */
function ensureWorktree({ spec, runDir, state, stageName }) {
  if (!MUTATING_STAGES.includes(stageName)) return null;

  const baseWorkspace = spec.workspace;
  const baseBranch = spec.branch ?? 'main';

  // Reuse existing worktree if already created for this stage
  if (state.worktree?.worktreePath && fileExists(state.worktree.worktreePath)) {
    appendTimeline(runDir, `Reusing existing worktree at ${state.worktree.worktreePath}`);
    return state.worktree;
  }

  const branchName = `sprint/${state.runId.slice(0, 12)}/${stageName}`;
  const worktreePath = path.join(runDir, 'worktrees', stageName);

  try {
    ensureDir(path.dirname(worktreePath));

    // Try to create a new worktree with a new branch
    let result = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseWorkspace], {
      cwd: baseWorkspace,
      encoding: 'utf8',
      timeout: 30_000,
    });

    if (result.status !== 0) {
      // Branch may already exist locally — try adding with existing branch
      result = spawnSync('git', ['worktree', 'add', worktreePath, branchName], {
        cwd: baseWorkspace,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (result.status !== 0) {
        appendTimeline(runDir, `Worktree creation failed: ${result.stderr} — falling back to base workspace`);
        return null;
      }
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
      dirtyFiles: [],
    };

    state.worktree = worktreeInfo;
    appendTimeline(runDir, `Created worktree at ${worktreePath} (branch: ${branchName}, sha: ${headSha})`);
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
      remoteBranch: null,
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
 */
function cleanupWorktree({ state, runDir }) {
  if (!state.worktree?.worktreePath) return;
  const { worktreePath } = state.worktree;
  try {
    spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: path.dirname(worktreePath),
      encoding: 'utf8',
      timeout: 30_000,
    });
    appendTimeline(runDir, `Cleaned up worktree at ${worktreePath}`);
    state.worktree = null;
  } catch {
    appendTimeline(runDir, `Worktree cleanup failed for ${worktreePath} — manual cleanup required`);
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
  const { stageDir, briefPath, producerPath, reviewerAPath, reviewerBPath, decisionPath, scorecardPath } = paths;
  const protectedFiles = protectedArtifacts(runDir, paths);

  // Read handoff data for structured carry forward
  const handoffPath = path.join(stageDir, 'handoff.json');
  const handoff = fileExists(handoffPath) ? readJson(handoffPath) : null;

  writeText(briefPath, `${buildStageBrief(spec, stageName, state.currentRound, previousDecision, handoff)}\n`);

  // On round > 1, clear previous round's role reports so agents must regenerate them
  if (state.currentRound > 1) {
    const staleReports = [producerPath, reviewerAPath, reviewerBPath];
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
    updateSummary(runDir, [
      `Status: ${state.status}`,
      `Stage: ${stageName}`,
      `Round: ${state.currentRound}`,
      `Halt reason: ${state.haltReason.details}`,
    ]);
    return { outcome: 'halt', summary: state.haltReason.details, blockers: state.haltReason.blockers, metrics: {} };
  }

  const producerConfig = roleConfig(spec, 'producer');
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
  const producerWorkspace = worktreeInfo?.worktreePath ?? (spec.branchWorkspace || spec.workspace);

  if (fileExists(producerReportPath) && fs.readFileSync(producerReportPath, 'utf8').trim()) {
    outputs.producer = fs.readFileSync(producerReportPath, 'utf8').trim();
    appendTimeline(runDir, `producer skipped (report already exists) stage ${stageName} round ${state.currentRound}`);
    // Capture git status even for skipped producer (worktree may have changed)
    if (worktreeInfo?.worktreePath) {
      captureGitStatus({ worktreePath: worktreeInfo.worktreePath, runDir, stageDir, state });
    }
  } else {
    const protectedSnapshot = snapshotProtectedFiles(protectedFiles);
    const producerFailLog = path.join(stageDir, 'producer-failure.log');
    let producerOutput;
    try {
      producerOutput = runAgent({
        cwd: producerWorkspace,
        agent: producerConfig.agent,
        model: producerConfig.model,
        prompt: producerPrompt,
        timeoutSeconds: stageRoleTimeout(spec, stageName, 'producer'),
        failLogPath: producerFailLog,
      });
    } catch (agentErr) {
      if (fileExists(producerReportPath) && fs.readFileSync(producerReportPath, 'utf8').trim()) {
        appendTimeline(runDir, `producer spawnSync timed out but report exists — recovering stage ${stageName} round ${state.currentRound}`);
        producerOutput = null;
      } else {
        throw agentErr;
      }
    }
    if (producerOutput) writeText(producerStdoutPath, `${producerOutput}\n`);
    outputs.producer = readRoleOutput({ reportPath: producerReportPath, stdout: producerOutput ?? '' });
    if (!fileExists(producerReportPath) || !fs.readFileSync(producerReportPath, 'utf8').trim()) {
      writeText(producerReportPath, `${outputs.producer}\n`);
    }
    const producerViolated = detectProtectedWriteViolation(protectedFiles, protectedSnapshot);
    if (producerViolated) {
      state.status = 'halted';
      state.haltReason = {
        type: 'protected_file_modified',
        stage: stageName,
        round: state.currentRound,
        details: `producer modified orchestrator-owned file ${producerViolated}`,
        blockers: [`Protected file modified: ${producerViolated}`],
      };
      saveState(runDir, state);
      appendTimeline(runDir, `Sprint halted: producer modified protected file ${producerViolated}`);
      updateSummary(runDir, [
        `Status: ${state.status}`,
        `Stage: ${stageName}`,
        `Round: ${state.currentRound}`,
        `Halt reason: ${state.haltReason.details}`,
      ]);
      cleanupWorktree({ state, runDir });
      throw new Error(state.haltReason.details);
    }
    appendTimeline(runDir, `producer completed stage ${stageName} round ${state.currentRound}`);
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
    updateSummary(runDir, [
      `Status: ${state.status}`,
      `Stage: ${stageName}`,
      `Round: ${state.currentRound}`,
      `Halt reason: ${state.haltReason.details}`,
    ]);
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

  // Run both reviewers in parallel
  const reviewerResults = await Promise.all([
    runReviewerRole({ runDir, state, spec, paths, role: 'reviewer_a' }),
    runReviewerRole({ runDir, state, spec, paths, role: 'reviewer_b' }),
  ]);

  // Collect outputs and timeout flags
  const reviewerTimeouts = [];
  for (const result of reviewerResults) {
    outputs[result.role] = result.output;
    if (result.timedOut) {
      appendTimeline(runDir, `${result.role} timed out stage ${stageName} round ${state.currentRound}`);
      reviewerTimeouts.push({ role: result.role, timedOut: true, hadReport: result.reportExisted });
    }
    if (result.violatedFile) {
      appendTimeline(runDir, `${result.role} modified protected file ${result.violatedFile}`);
    }
  }
  heartbeatState(runDir, state, { currentRole: null });

  return decideAndPersist({
    runDir,
    stageName,
    stageDir,
    decisionPath,
    scorecardPath,
    producerPath,
    reviewerAPath,
    reviewerBPath,
    state,
    reviewerTimeouts: reviewerTimeouts.length > 0 ? reviewerTimeouts : null,
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
      '  node run.mjs --task <task-id> [--task-spec <path>]   Start a new sprint',
      '  node run.mjs --resume <run-id>                        Resume a halted/aborted sprint',
      '  node run.mjs --status <run-id>                        Show sprint dashboard',
      '  node run.mjs --list                                   List all sprint runs',
      '  node run.mjs --pause <run-id>                         Pause a running sprint',
      '  node run.mjs --abort <run-id>                         Abort a sprint',
      '  node run.mjs --archive <run-id>                       Archive a completed/halted sprint',
      '',
      'Sprints auto-archive on completion or halt.',
      'Task specs are loaded from ops/ai-sprints/specs/<task-id>.json',
      'Override with --task-spec <path> to use a custom spec file.',
    ].join('\n'));
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

  const { runDir, state } = loadOrInitState(args);
  const spec = loadSpec(state, args);
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
        updateSummary(runDir, [
          `Status: ${state.status}`,
          `Stage: ${state.currentStage}`,
          `Round: ${state.currentRound}`,
          `Halt reason: ${state.haltReason.details}`,
        ]);
        break;
      }

      const decision = await executeStage(runDir, state, spec);
      advanceState(state, spec, decision, { runDir });
      saveState(runDir, state);
      if (state.status === 'completed') {
        appendTimeline(runDir, 'Sprint completed');
        updateSummary(runDir, [
          `Status: ${state.status}`,
          `Stage: ${state.currentStage}`,
          `Round: ${state.currentRound}`,
          'All stages finished.',
        ]);
      }
      if (state.status === 'halted') {
        appendTimeline(runDir, `Sprint halted: ${state.haltReason?.details ?? 'unknown reason'}`);
        updateSummary(runDir, [
          `Status: ${state.status}`,
          `Stage: ${state.currentStage}`,
          `Round: ${state.currentRound}`,
          `Halt reason: ${state.haltReason?.details ?? 'unknown reason'}`,
        ]);
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
      saveState(runDir, state);
      appendTimeline(runDir, `Sprint halted by orchestrator error: ${String(error)}`);
      updateSummary(runDir, [
        `Status: ${state.status}`,
        `Stage: ${state.currentStage}`,
        `Round: ${state.currentRound}`,
        `Halt reason: ${String(error)}`,
      ]);
    }
  }

  // Auto-archive if sprint reached a terminal state
  if (state.status === 'completed' || state.status === 'halted') {
    try {
      const archiveDir = archiveRunById(args.resume || path.basename(runDir));
      appendTimeline(runDir, `Auto-archived to ${path.relative(path.join(repoRoot, 'ops', 'ai-sprints'), archiveDir)}`);
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

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
