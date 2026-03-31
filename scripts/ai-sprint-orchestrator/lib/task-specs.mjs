const DEFAULT_STAGE_ORDER = ['investigate', 'fix-plan', 'implement', 'verify'];

export function getTaskSpec(taskId) {
  if (taskId === 'empathy-runtime-fix') {
    return {
      id: 'empathy-runtime-fix',
      title: 'Fix empathy observer production failure',
      workspace: 'D:/Code/principles',
      branchWorkspace: 'D:/Code/principles-empathy-fix',
      maxRoundsPerStage: 3,
      maxRuntimeMinutes: 360,
      stageTimeoutMinutes: 30,
      stages: DEFAULT_STAGE_ORDER,
      producer: {
        agent: 'opencode',
        model: 'minimax-cn-coding-plan/MiniMax-M2.7',
        timeoutSeconds: 1200,
      },
      reviewerA: {
        agent: 'iflow',
        model: 'glm-5',
        timeoutSeconds: 900,
      },
      reviewerB: {
        agent: 'iflow',
        model: 'glm-5',
        timeoutSeconds: 900,
      },
      escalationReviewer: {
        agent: 'claude',
        model: 'GLM-5.1',
        timeoutSeconds: 900,
      },
      context: [
        'Use PD-only changes; do not modify OpenClaw.',
        'Focus on the empathy observer production failure and subagent lifecycle reliability.',
        'Keep code quality high and avoid unnecessary architectural expansion in the first fix.',
      ],
      stageGoals: {
        'investigate': [
          'Identify the most likely root cause chain for missing user_empathy persistence.',
          'Confirm whether observer prompt contamination is occurring on latest code.',
          'Confirm whether timeout/error/fallback paths can leave data unpersisted.',
        ],
        'fix-plan': [
          'Produce a minimal PD-only repair plan.',
          'Define tests, rollback points, and scope boundaries.',
        ],
        'implement': [
          'Implement the fix in the empathy observer path.',
          'Add focused tests and run targeted verification.',
        ],
        'verify': [
          'Verify the fix path with code and test evidence.',
          'Call out any remaining runtime assumptions or production gaps.',
        ],
      },
      stageCriteria: {
        'investigate': {
          requiredApprovals: 2,
          requiredProducerSections: ['SUMMARY', 'EVIDENCE', 'KEY_EVENTS', 'HYPOTHESIS_MATRIX', 'CHECKS'],
          requiredReviewerSections: ['VERDICT', 'BLOCKERS', 'FINDINGS', 'HYPOTHESIS_MATRIX', 'NEXT_FOCUS', 'CHECKS'],
        },
        'fix-plan': {
          requiredApprovals: 2,
          requiredProducerSections: ['SUMMARY', 'CHANGES', 'EVIDENCE', 'CHECKS'],
          requiredReviewerSections: ['VERDICT', 'BLOCKERS', 'FINDINGS', 'NEXT_FOCUS', 'CHECKS'],
        },
        'implement': {
          requiredApprovals: 2,
          requiredProducerSections: ['SUMMARY', 'CHANGES', 'EVIDENCE', 'CHECKS'],
          requiredReviewerSections: ['VERDICT', 'BLOCKERS', 'FINDINGS', 'NEXT_FOCUS', 'CHECKS'],
        },
        'verify': {
          requiredApprovals: 2,
          requiredProducerSections: ['SUMMARY', 'EVIDENCE', 'CHECKS'],
          requiredReviewerSections: ['VERDICT', 'BLOCKERS', 'FINDINGS', 'NEXT_FOCUS', 'CHECKS'],
        },
      },
      investigateHypotheses: [
        'prompt_contamination_from_prompt_ts',
        'wait_for_run_timeout_or_error_causes_non_persistence',
        'subagent_ended_fallback_is_not_reliable_enough',
        'workspace_dir_or_wrong_workspace_write',
        'lock_or_ttl_path_causes_observer_inactivity_or_data_loss',
      ],
    };
  }

  throw new Error(`Unknown task spec: ${taskId}`);
}

export function buildStageBrief(spec, stage, round, previousDecision) {
  const goals = spec.stageGoals[stage] ?? [];
  const hypotheses = stage === 'investigate' ? (spec.investigateHypotheses ?? []) : [];
  const carryForward = previousDecision
    ? `## Carry Forward\n\n${previousDecision}\n`
    : '## Carry Forward\n\n- None.\n';

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
    `## Exit Criteria`,
    `- Both reviewers return VERDICT: APPROVE`,
    `- No unresolved blocker remains in reviewer outputs`,
    ...(spec.stageCriteria?.[stage]?.requiredProducerSections?.length
      ? [`- Producer report must contain sections: ${spec.stageCriteria[stage].requiredProducerSections.join(', ')}`]
      : []),
    ...(spec.stageCriteria?.[stage]?.requiredReviewerSections?.length
      ? [`- Reviewer reports must contain sections: ${spec.stageCriteria[stage].requiredReviewerSections.join(', ')}`]
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
  const sharedSkills = [
    'C:/Users/Administrator/.codex/skills/acpx/SKILL.md',
    'C:/Users/Administrator/.codex/superpowers/skills/systematic-debugging/SKILL.md',
    'C:/Users/Administrator/.codex/superpowers/skills/verification-before-completion/SKILL.md',
    'C:/Users/Administrator/.agents/skills/self-improving-agent/SKILL.md',
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
    return [
      ...base,
      `You may inspect and modify repository code when the stage requires implementation.`,
      `You are expected to work autonomously within this stage until you either satisfy the stage goals or hit a concrete blocker.`,
      `Persist your intermediate findings frequently so a future agent can resume without relying on chat context.`,
      `At the end, write a markdown report to ${outputPath} with exactly these sections: SUMMARY, CHANGES, EVIDENCE, KEY_EVENTS, HYPOTHESIS_MATRIX, CHECKS, OPEN_RISKS.`,
      `KEY_EVENTS should be bullets describing concrete completed milestones or validated events.`,
      stage === 'investigate'
        ? `HYPOTHESIS_MATRIX must include one bullet per required hypothesis in this exact shape: - <hypothesis_id>: SUPPORTED|REFUTED|UNPROVEN — <brief evidence>.`
        : `HYPOTHESIS_MATRIX should capture any remaining competing explanations or risk assumptions.`,
      `CHECKS should be a single-line machine-readable summary such as: CHECKS: evidence=ok;tests=not-run;scope=pd-only;prompt-isolation=confirmed`,
      `Do not dump long reasoning logs to stdout. Stdout should only contain a short completion line such as: ROLE_STATUS: completed; report=${outputPath}`,
      `Stay within Principles. Do not modify OpenClaw.`,
    ].join('\n');
  }

  const counterpart = role === 'reviewer_a' ? producerPath : producerPath;

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

  return [
    ...base,
    `Read the producer report: ${counterpart}`,
    ...reviewerFocus,
    `Review independently. Do not modify repository files unless explicitly needed for evidence collection.`,
    `You are expected to challenge weak assumptions and record checkpoints while reviewing, not just emit a final verdict.`,
    `At the end, write a markdown report to ${outputPath} with exactly these sections: VERDICT, BLOCKERS, FINDINGS, HYPOTHESIS_MATRIX, NEXT_FOCUS, CHECKS.`,
    stage === 'investigate'
      ? `HYPOTHESIS_MATRIX must classify each required hypothesis with one bullet in this exact shape: - <hypothesis_id>: SUPPORTED|REFUTED|UNPROVEN — <brief evidence>.`
      : `HYPOTHESIS_MATRIX should capture any remaining competing explanations or risk assumptions.`,
    `CHECKS should be a single-line machine-readable summary such as: CHECKS: criteria=met;blockers=0;verification=partial`,
    `VERDICT must be exactly one of: APPROVE, REVISE, BLOCK.`,
    `Do not dump long reasoning logs to stdout. Stdout should only contain a short completion line such as: ROLE_STATUS: completed; report=${outputPath}`,
  ].join('\n');
}
