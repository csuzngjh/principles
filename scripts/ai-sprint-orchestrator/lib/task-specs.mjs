import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const SPECS_DIR = path.join(repoRoot, 'ops', 'ai-sprints', 'specs');

export function getTaskSpec(taskId, specPath) {
  // Priority: explicit path > filesystem spec > error
  const candidates = specPath
    ? [specPath]
    : [
        path.join(SPECS_DIR, `${taskId}.json`),
        path.join(SPECS_DIR, taskId),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
  }

  throw new Error(`Unknown task spec: ${taskId}. Place a spec file in ${SPECS_DIR}/<task-id>.json or pass --task-spec <path>.`);
}

export function buildStageBrief(spec, stage, round, previousDecision, handoff = null) {
  const goals = spec.stageGoals[stage] ?? [];
  const hypotheses = stage === 'investigate' ? (spec.investigateHypotheses ?? []) : [];
  const stageCriteria = spec.stageCriteria?.[stage];
  const scoringDimensions = stageCriteria?.scoringDimensions ?? [];
  const dimensionThreshold = stageCriteria?.dimensionThreshold ?? 3;
  const requiredDeliverables = stageCriteria?.requiredDeliverables ?? [];

  // Build structured carry forward from handoff or fall back to raw decision text
  let carryForward;
  if (handoff) {
    const accomplished = handoff.contractItems?.filter((i) => i.status === 'DONE') ?? [];
    const incomplete = handoff.contractItems?.filter((i) => i.status !== 'DONE') ?? [];
    carryForward = [
      '## Carry Forward',
      '',
      '### What was accomplished',
      ...(accomplished.length > 0 ? accomplished.map((i) => `- ${i.deliverable}`) : ['- None.']),
      '',
      '### What needs to change',
      ...(handoff.blockers?.length > 0 ? handoff.blockers.map((b) => `- ${b}`) : ['- No blockers from previous round.']),
      '',
      '### Focus for this round',
      ...(handoff.focusForNextRound ? [handoff.focusForNextRound] : ['- Follow stage goals.']),
      '',
    ].join('\n');
  } else if (previousDecision) {
    carryForward = `## Carry Forward\n\n${previousDecision}\n`;
  } else {
    carryForward = '## Carry Forward\n\n- None.\n';
  }

  return [
    `# Stage Brief`,
    '',
    `- Task: ${spec.title}`,
    `- Stage: ${stage}`,
    `- Round: ${round}`,
    '',
    `## Goals`,
    ...goals.map((goal) => `- ${goal}`),
    '',
    ...(hypotheses.length
      ? [
        `## Required Hypotheses`,
        ...hypotheses.map((item) => `- ${item}`),
        '',
      ]
      : []),
    carryForward.trimEnd(),
    '',
    `## Constraints`,
    ...spec.context.map((line) => `- ${line}`),
    '',
    ...(scoringDimensions.length > 0
      ? [
        `## Scoring Dimensions`,
        `Reviewers will score this stage on a 1-5 scale across these dimensions:`,
        ...scoringDimensions.map((d) => `- ${d}`),
        `Threshold: each dimension must score at least ${dimensionThreshold}/5.`,
        '',
      ]
      : []),
    ...(requiredDeliverables.length > 0
      ? [
        `## Contract Template`,
        `The producer must include a CONTRACT section declaring the status of each deliverable.`,
        `Required deliverables:`,
        ...requiredDeliverables.map((d) => `- ${d}`),
        `Format: CONTRACT: followed by bullets like: - <description> status: DONE|PARTIAL|TODO`,
        '',
      ]
      : []),
    `## Exit Criteria`,
    `- Both reviewers return VERDICT: APPROVE`,
    `- No unresolved blocker remains in reviewer outputs`,
    ...(scoringDimensions.length > 0
      ? [`- All scoring dimensions meet threshold (${dimensionThreshold}/5)`]
      : []),
    ...(requiredDeliverables.length > 0
      ? ['- All contract deliverables reach status: DONE']
      : []),
    ...(stageCriteria?.requiredProducerSections?.length
      ? [`- Producer report must contain sections: ${stageCriteria.requiredProducerSections.join(', ')}`]
      : []),
    ...(stageCriteria?.requiredReviewerSections?.length
      ? [`- Reviewer reports must contain sections: ${stageCriteria.requiredReviewerSections.join(', ')}`]
      : []),
    '',
  ].join('\n');
}

export function buildRolePrompt({ spec, stage, round, role, runDir, stageDir, briefPath, producerPath, reviewerAPath, reviewerBPath }) {
  const outputPathMap = {
    producer: producerPath,
    reviewer_a: reviewerAPath,
    reviewer_b: reviewerBPath,
  };
  const outputPath = outputPathMap[role];
  const worklogPath = role === 'producer'
    ? `${stageDir}/producer-worklog.md`
    : role === 'reviewer_a'
      ? `${stageDir}/reviewer-a-worklog.md`
      : `${stageDir}/reviewer-b-worklog.md`;
  const roleStatePath = role === 'producer'
    ? `${stageDir}/producer-state.json`
    : role === 'reviewer_a'
      ? `${stageDir}/reviewer-a-state.json`
      : `${stageDir}/reviewer-b-state.json`;
  const home = os.homedir();
  const sharedSkills = [
    path.join(home, '.codex', 'skills', 'acpx', 'SKILL.md'),
    path.join(home, '.codex', 'superpowers', 'skills', 'systematic-debugging', 'SKILL.md'),
    path.join(home, '.codex', 'superpowers', 'skills', 'verification-before-completion', 'SKILL.md'),
    path.join(home, '.agents', 'skills', 'self-improving-agent', 'SKILL.md'),
  ];
  const base = [
    `You are acting as ${role} in an AI sprint orchestrator for the Principles repository.`,
    `Current task: ${spec.title}`,
    `Stage: ${stage}`,
    `Round: ${round}`,
    `Working directory for task artifacts: ${stageDir}`,
    `Overall sprint directory: ${runDir}`,
    `Read the stage brief first: ${briefPath}`,
    `Your final report file: ${outputPath}`,
    `Your worklog file: ${worklogPath}`,
    `Your role state file: ${roleStatePath}`,
    `Protected orchestrator-owned files that you must NOT modify: ${runDir}/sprint.json, ${runDir}/timeline.md, ${runDir}/latest-summary.md, ${stageDir}/decision.md, ${stageDir}/scorecard.json`,
    `Shared skill references are available at:`,
    ...sharedSkills.map((skill) => `- ${skill}`),
    `Before substantial work, create or update your role state file with: role, stage, round, status, checklist, updatedAt.`,
    `During work, append short checkpoints to your worklog whenever you complete a meaningful investigation step, code change, review finding, or verification step.`,
    `If you get stuck, record the concrete blocker and next best action in both the role state file and worklog before ending.`,
    `Prefer shell commands for file updates when direct write/edit tools are flaky in long sessions.`,
  ];

  if (role === 'producer') {
    const stageCriteria = spec.stageCriteria?.[stage];
    const requiredDeliverables = stageCriteria?.requiredDeliverables ?? [];
    const contractInstruction = requiredDeliverables.length > 0
      ? [
          `Your report must include a CONTRACT section listing each deliverable with its status.`,
          `Format: CONTRACT: followed by bullets like: - <deliverable description> status: DONE|PARTIAL|TODO`,
          `Required deliverables for this stage: ${requiredDeliverables.join(', ')}`,
          `All deliverables must reach status: DONE for the stage to advance.`,
        ]
      : [];
    const codeEvidenceInstruction = [
      `Your report must include a CODE_EVIDENCE section. Format:`,
      `- files_checked: <comma-separated list of files you examined>`,
      `- evidence_source: local|remote|both`,
      `- sha: <HEAD SHA at time of evidence collection>`,
      `- branch/worktree: <branch name or worktree path if applicable>`,
      `When OpenClaw runtime semantics are involved, add: evidence_scope: principles|openclaw|both`,
    ].join('\n');

    return [
      ...base,
      `You may inspect and modify repository code when the stage requires implementation.`,
      `You are expected to work autonomously within this stage until you either satisfy the stage goals or hit a concrete blocker.`,
      `Persist your intermediate findings frequently so a future agent can resume without relying on chat context.`,
      `At the end, write a markdown report to ${outputPath} with exactly these sections: SUMMARY, CHANGES, EVIDENCE, CODE_EVIDENCE, KEY_EVENTS, HYPOTHESIS_MATRIX, CHECKS, OPEN_RISKS${requiredDeliverables.length > 0 ? ', CONTRACT' : ''}.`,
      `KEY_EVENTS should be bullets describing concrete completed milestones or validated events.`,
      stage === 'investigate'
        ? `HYPOTHESIS_MATRIX must include one bullet per required hypothesis in this exact shape: - <hypothesis_id>: SUPPORTED|REFUTED|UNPROVEN — <brief evidence>.`
        : `HYPOTHESIS_MATRIX should capture any remaining competing explanations or risk assumptions.`,
      `CHECKS should be a single-line machine-readable summary such as: CHECKS: evidence=ok;tests=not-run;scope=pd-only;prompt-isolation=confirmed`,
      codeEvidenceInstruction,
      ...contractInstruction,
      `Do not dump long reasoning logs to stdout. Stdout should only contain a short completion line such as: ROLE_STATUS: completed; report=${outputPath}`,
      `Stay within Principles. Do not modify OpenClaw.`,
    ].join('\n');
  }

  const counterpart = role === 'reviewer_a' ? producerPath : producerPath;

  const stageCriteria = spec.stageCriteria?.[stage];
  const scoringDimensions = stageCriteria?.scoringDimensions ?? [];
  const dimensionThreshold = stageCriteria?.dimensionThreshold ?? 3;
  const requiredDeliverables = stageCriteria?.requiredDeliverables ?? [];

  const reviewerFocus = role === 'reviewer_a'
    ? [
        `Your primary focus: correctness and root-cause analysis.`,
        `Challenge whether the producer's evidence actually supports the claimed conclusions.`,
        `Check for logical gaps, untested edge cases, and missing error paths.`,
        `Verify that code citations (file paths, line numbers) are accurate by reading the referenced files.`,
      ]
    : [
        `Your primary focus: scope control, regression risk, and test coverage.`,
        `Check whether the producer's changes are the smallest sufficient fix, or if scope has crept.`,
        `Identify missing tests, insufficient coverage, and potential side effects.`,
        `Flag any unnecessary architectural expansion or gold-plating.`,
      ];

  const codeEvidenceReviewerInstruction = [
    `Your report must include a CODE_EVIDENCE section. Format:`,
    `- files_verified: <comma-separated list of files you read or checked for evidence>`,
    `- evidence_source: local|remote|both`,
    `- sha: <the SHA you verified against>`,
    `When OpenClaw runtime semantics are involved, add: evidence_scope: principles|openclaw|both`,
  ].join('\n');

  return [
    ...base,
    `Read the producer report: ${counterpart}`,
    ...reviewerFocus,
    `Review independently. Do not modify repository files unless explicitly needed for evidence collection.`,
    `You are expected to challenge weak assumptions and record checkpoints while reviewing, not just emit a final verdict.`,
    `At the end, write a markdown report to ${outputPath} with exactly these sections: VERDICT, BLOCKERS, FINDINGS, CODE_EVIDENCE, HYPOTHESIS_MATRIX, NEXT_FOCUS, CHECKS.`,
    stage === 'investigate'
      ? `HYPOTHESIS_MATRIX must classify each required hypothesis with one bullet in this exact shape: - <hypothesis_id>: SUPPORTED|REFUTED|UNPROVEN — <brief evidence>.`
      : `HYPOTHESIS_MATRIX should capture any remaining competing explanations or risk assumptions.`,
    `CHECKS should be a single-line machine-readable summary such as: CHECKS: criteria=met;blockers=0;verification=partial`,
    scoringDimensions.length > 0
      ? `You must include a DIMENSIONS line scoring each dimension 1-5. Format: DIMENSIONS: ${scoringDimensions.map((d) => `${d}=N`).join('; ')}. Any dimension below ${dimensionThreshold}/5 is a failure. Be honest and calibrated — do not inflate scores.`
      : '',
    requiredDeliverables.length > 0
      ? `Check the producer's CONTRACT section. Verify each deliverable's status is honestly assessed. Flag any deliverable marked DONE that lacks convincing evidence.`
      : '',
    codeEvidenceReviewerInstruction,
    `VERDICT must be exactly one of: APPROVE, REVISE, BLOCK.`,
    `Do not dump long reasoning logs to stdout. Stdout should only contain a short completion line such as: ROLE_STATUS: completed; report=${outputPath}`,
  ].filter(Boolean).join('\n');
}
