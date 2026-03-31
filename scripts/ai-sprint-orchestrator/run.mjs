import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { decideStage } from './lib/decision.mjs';
import { ensureDir, appendText, fileExists, readJson, writeJson, writeText } from './lib/state-store.mjs';
import { buildRolePrompt, buildStageBrief, getTaskSpec } from './lib/task-specs.mjs';

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

function createSprintState(spec, runId) {
  return {
    runId,
    taskId: spec.id,
    title: spec.title,
    status: 'running',
    currentStageIndex: 0,
    currentStage: spec.stages[0],
    currentRound: 1,
    maxRoundsPerStage: spec.maxRoundsPerStage,
    maxRuntimeMinutes: spec.maxRuntimeMinutes,
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
    return { runDir, state: readJson(sprintFile), resumed: true };
  }

  if (!args.task) {
    throw new Error('Missing required --task <task-id>');
  }

  const spec = getTaskSpec(args.task);
  const runId = makeRunId(spec.id);
  const runDir = path.join(sprintRoot, runId);
  const state = createSprintState(spec, runId);
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

function updateSummary(runDir, lines) {
  writeText(path.join(runDir, 'latest-summary.md'), `# Latest Summary\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
}

function appendTimeline(runDir, line) {
  appendText(path.join(runDir, 'timeline.md'), `- ${nowIso()} ${line}\n`);
}

function runAgent({ cwd, agent, model, prompt, timeoutSeconds = 1800 }) {
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
          `acpx --cwd $env:AI_SPRINT_CWD --approve-all --model $env:AI_SPRINT_MODEL ${agent} exec -f $env:AI_SPRINT_PROMPT`,
        ],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeoutSeconds * 1000,
          shell: false,
          env: {
            ...process.env,
            AI_SPRINT_CWD: cwd,
            AI_SPRINT_MODEL: model,
            AI_SPRINT_PROMPT: promptFile,
          },
        },
      );
    } else {
      result = spawnSync(
        'acpx',
        ['--cwd', cwd, '--approve-all', '--model', model, agent, 'exec', '-f', promptFile],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeoutSeconds * 1000,
          shell: false,
        },
      );
    }
  } finally {
    fs.rmSync(promptFile, { force: true });
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Agent ${agent} failed with status ${result.status}\n${stdout}\n${stderr}`);
  }

  return stdout.trim();
}

function roleConfig(spec, role) {
  if (role === 'producer') return spec.producer;
  if (role === 'reviewer_a') return spec.reviewerA;
  if (role === 'reviewer_b') return spec.reviewerB;
  throw new Error(`Unknown role: ${role}`);
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

function decideAndPersist({ runDir, stageName, stageDir, decisionPath, producerPath, reviewerAPath, reviewerBPath, state }) {
  const producer = fs.readFileSync(producerPath, 'utf8');
  const reviewerA = fs.readFileSync(reviewerAPath, 'utf8');
  const reviewerB = fs.readFileSync(reviewerBPath, 'utf8');
  const decision = decideStage({
    stageCriteria: getTaskSpec(state.taskId).stageCriteria?.[stageName],
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
    '',
    `## Files`,
    `- Producer: ${producerPath}`,
    `- Reviewer A: ${reviewerAPath}`,
    `- Reviewer B: ${reviewerBPath}`,
  ].join('\n');

  writeText(decisionPath, `${content}\n`);
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

  state.status = 'halted';
  state.haltReason = {
    type: 'max_rounds_exceeded',
    stage: state.currentStage,
    round: state.currentRound,
    details: decision.summary,
    blockers: decision.blockers,
  };
}

function maybeAbort(runDir, state) {
  const fresh = readJson(path.join(runDir, 'sprint.json'));
  if (fresh.status === 'aborted' || fresh.status === 'paused') {
    throw new Error(`Sprint ${fresh.status} by operator.`);
  }
  Object.assign(state, fresh);
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

  const { stageDir, briefPath, producerPath, reviewerAPath, reviewerBPath, decisionPath } = ensureStagePaths(
    runDir,
    state.currentStageIndex,
    stageName,
  );

  writeText(briefPath, `${buildStageBrief(spec, stageName, state.currentRound, previousDecision)}\n`);
  appendTimeline(runDir, `Stage ${stageName} round ${state.currentRound} started`);
  updateSummary(runDir, [
    `Status: ${state.status}`,
    `Stage: ${stageName}`,
    `Round: ${state.currentRound}`,
    'Producer is running.',
  ]);

  const roles = ['producer', 'reviewer_a', 'reviewer_b'];
  const outputs = {};

  for (const role of roles) {
    maybeAbort(runDir, state);
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
    const output = runAgent({
      cwd: role === 'producer' ? (spec.branchWorkspace || spec.workspace) : spec.workspace,
      agent: config.agent,
      model: config.model,
      prompt,
    });
    outputs[role] = output;

    const outputPath = role === 'producer' ? producerPath : role === 'reviewer_a' ? reviewerAPath : reviewerBPath;
    writeText(outputPath, `${output}\n`);
    appendTimeline(runDir, `${role} completed stage ${stageName} round ${state.currentRound}`);
  }

  return decideAndPersist({
    runDir,
    stageName,
    stageDir,
    decisionPath,
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

function showStatus(runId) {
  const runDir = path.join(sprintRoot, runId);
  const sprintFile = path.join(runDir, 'sprint.json');
  const summaryFile = path.join(runDir, 'latest-summary.md');
  if (!fileExists(sprintFile)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const state = readJson(sprintFile);
  const summary = fileExists(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '';
  console.log(JSON.stringify({ state, summary }, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

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
  const spec = getTaskSpec(state.taskId);

  appendTimeline(runDir, state.currentRound === 1 && state.currentStageIndex === 0 ? 'Sprint execution started' : 'Sprint resumed');

  while (state.status === 'running') {
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

  console.log(runDir);
}

main();
