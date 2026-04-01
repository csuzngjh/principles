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

function roleTimeout(spec, role) {
  const config = roleConfig(spec, role);
  return config.timeoutSeconds ?? 600;
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

function decideAndPersist({ runDir, stageName, stageDir, decisionPath, scorecardPath, producerPath, reviewerAPath, reviewerBPath, state }) {
  const missingFiles = [];
  if (!fileExists(producerPath)) missingFiles.push(`producer: ${producerPath}`);
  if (!fileExists(reviewerAPath)) missingFiles.push(`reviewer_a: ${reviewerAPath}`);
  if (!fileExists(reviewerBPath)) missingFiles.push(`reviewer_b: ${reviewerBPath}`);

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

function advanceState(state, spec, decision) {
  if (decision.outcome === 'advance') {
    if (state.currentStageIndex >= spec.stages.length - 1) {
      state.status = 'completed';
      return;
    }
    state.currentStageIndex += 1;
    state.currentStage = spec.stages[state.currentStageIndex];
    state.currentRound = 1;
    return;
  }

  if (decision.outcome === 'revise') {
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
  return state;
}

function executeStage(runDir, state, spec) {
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

  appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} started`);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    'Producer is running.',
  ]);

  const roles = ['producer', 'reviewer_a', 'reviewer_b'];
  const outputs = {};
  const stageStartedAt = Date.now();
  const stageTimeoutMs = (spec.stageTimeoutMinutes ?? 30) * 60_000;

  for (const role of roles) {
    maybeAbort(runDir, state);
    heartbeatState(runDir, state, { currentRole: role });

    // Per-stage runtime check
    const stageElapsed = Date.now() - stageStartedAt;
    if (stageElapsed > stageTimeoutMs) {
      state.status = 'halted';
      state.haltReason = {
        type: 'stage_timeout',
        stage: stageName,
        round: state.currentRound,
        details: `Stage ${stageName} exceeded ${(stageTimeoutMs / 60_000).toFixed(0)} minutes at role ${role}`,
        blockers: [`Stage timeout at role ${role} after ${(stageElapsed / 60_000).toFixed(1)} minutes`],
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
    const config = roleConfig(spec, role);
    const prompt = buildRolePrompt({
      spec,
      stage: stageName,
      round: state.currentRound,
      role,
      runDir,
      stageDir,
      briefPath,
      producerPath,
      reviewerAPath,
      reviewerBPath,
    });
    // P3: skip role if report already exists and is non-empty
    const { reportPath, stdoutPath } = roleArtifactPaths(paths, role);
    if (fileExists(reportPath) && fs.readFileSync(reportPath, 'utf8').trim()) {
      outputs[role] = fs.readFileSync(reportPath, 'utf8').trim();
      appendTimeline(runDir, `${role} skipped (report already exists) stage ${stageName} round ${state.currentRound}`);
      continue;
    }
    const protectedSnapshot = snapshotProtectedFiles(protectedFiles);
    const failLog = path.join(stageDir, `${role.replace('_', '-')}-failure.log`);
    let output;
    let agentTimedOut = false;
    try {
      output = runAgent({
        cwd: role === 'producer' ? (spec.branchWorkspace || spec.workspace) : spec.workspace,
        agent: config.agent,
        model: config.model,
        prompt,
        timeoutSeconds: roleTimeout(spec, role),
        failLogPath: failLog,
      });
    } catch (agentErr) {
      // If spawnSync timed out but the agent wrote its report, continue instead of halting
      if (fileExists(reportPath) && fs.readFileSync(reportPath, 'utf8').trim()) {
        appendTimeline(runDir, `${role} spawnSync timed out but report exists — recovering stage ${stageName} round ${state.currentRound}`);
        output = null;
        agentTimedOut = true;
      } else {
        throw agentErr;
      }
    }
    if (output) writeText(stdoutPath, `${output}\n`);
    outputs[role] = readRoleOutput({ reportPath, stdout: output ?? '' });

    if (!fileExists(reportPath) || !fs.readFileSync(reportPath, 'utf8').trim()) {
      writeText(reportPath, `${outputs[role]}\n`);
    }
    const violatedFile = detectProtectedWriteViolation(protectedFiles, protectedSnapshot);
    if (violatedFile) {
      state.status = 'halted';
      state.haltReason = {
        type: 'protected_file_modified',
        stage: stageName,
        round: state.currentRound,
        details: `${role} modified orchestrator-owned file ${violatedFile}`,
        blockers: [`Protected file modified: ${violatedFile}`],
      };
      saveState(runDir, state);
      appendTimeline(runDir, `Sprint halted: ${role} modified protected file ${violatedFile}`);
      updateSummary(runDir, [
        `Status: ${state.status}`,
        `Stage: ${stageName}`,
        `Round: ${state.currentRound}`,
        `Halt reason: ${state.haltReason.details}`,
      ]);
      throw new Error(state.haltReason.details);
    }
    appendTimeline(runDir, `${role} completed stage ${stageName} round ${state.currentRound}`);
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
    state,
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

function main() {
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

      const decision = executeStage(runDir, state, spec);
      advanceState(state, spec, decision);
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

main();
