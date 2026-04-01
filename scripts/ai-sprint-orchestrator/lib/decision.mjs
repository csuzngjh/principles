const VERDICT_RE = /(?:VERDICT:\s*\*{0,2}|##\s*VERDICT\s*\n+\*{0,2}\s*)(APPROVE|REVISE|BLOCK)\b/i;
const DIMENSIONS_RE = /^DIMENSIONS:\s*(.+)$/im;
const CONTRACT_RE = /CONTRACT:\s*([\s\S]*?)(?:\n[A-Z_ ]+:|$)/i;
const CODE_EVIDENCE_RE = /CODE_EVIDENCE:\s*([\s\S]*?)(?:\n[A-Z_ ]+:|$)/i;
const FILES_CHECKED_RE = /files_check(?:ed|es):\s*\[([^\]]*)\]/i;
const FILES_VERIFIED_RE = /files_verified:\s*\[([^\]]*)\]/i;
const EVIDENCE_SOURCE_RE = /evidence_source:\s*(local|remote|both)/i;
const SHA_RE = /sha:\s*([a-f0-9]+)/i;
const BRANCH_RE = /branch\/worktree:\s*([^\n]+)/i;
const EVIDENCE_SCOPE_RE = /evidence_scope:\s*(principles|openclaw|both)/i;
const MACRO_ANSWERS_RE = /MACRO_ANSWERS:\s*([\s\S]*?)(?:\n[A-Z_ ]+:|$)/i;

export function normalizeVerdict(text) {
  const match = String(text ?? '').match(VERDICT_RE);
  return match ? match[1].toUpperCase() : 'REVISE';
}

export function hasExplicitVerdict(text) {
  return VERDICT_RE.test(String(text ?? ''));
}

export function extractBullets(text, heading) {
  const source = String(text ?? '');
  const pattern = new RegExp(`${heading}:\\s*([\\s\\S]*?)(?:\\n[A-Z_ ]+:|$)`, 'i');
  const match = source.match(pattern);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1).trim())
    .filter((line) => Boolean(line) && !/^none\.?\s*$/i.test(line));
}

export function hasSection(text, heading) {
  const pattern = new RegExp(`^${heading}:|^##\\s+${heading}\\b`, 'im');
  return pattern.test(String(text ?? ''));
}

export function extractMetricValue(text, key) {
  const match = String(text ?? '').match(new RegExp(`${key}:\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : null;
}

export function parseDimensions(text) {
  const source = String(text ?? '');
  const match = source.match(DIMENSIONS_RE);
  if (!match) return {};
  return match[1]
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return acc;
      const key = pair.slice(0, eq).trim();
      const value = Number(pair.slice(eq + 1).trim());
      if (key && !Number.isNaN(value)) acc[key] = value;
      return acc;
    }, {});
}

export function checkDimensionThresholds(dimensionScores, requiredDimensions, threshold = 3) {
  const failures = [];
  const checks = {};
  for (const dim of requiredDimensions) {
    const score = dimensionScores[dim];
    if (score === undefined) {
      failures.push(`Dimension "${dim}" not scored by reviewer.`);
      checks[dim] = null;
    } else if (score < threshold) {
      failures.push(`Dimension "${dim}" scored ${score}/5 (below threshold ${threshold}).`);
      checks[dim] = false;
    } else {
      checks[dim] = true;
    }
  }
  return { failures, checks };
}

export function extractContractItems(text) {
  const source = String(text ?? '');
  const match = source.match(CONTRACT_RE);
  if (!match) return [];
  const items = [];
  const blocks = match[1].split(/\r?\n/).filter((l) => l.trim().startsWith('-'));
  for (const block of blocks) {
    const deliverable = block.replace(/^-\s*/, '').trim();
    const statusMatch = deliverable.match(/status:\s*(DONE|PARTIAL|TODO)/i);
    items.push({
      deliverable: deliverable.replace(/\s*status:\s*\w+\s*/i, '').replace(/evidence:\s*"[^"]*"/i, '').trim(),
      status: statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN',
    });
  }
  return items;
}

export function checkContractCompletion(contractItems) {
  const incomplete = contractItems.filter((item) => item.status !== 'DONE');
  return {
    allDone: incomplete.length === 0 && contractItems.length > 0,
    incompleteItems: incomplete,
    totalItems: contractItems.length,
    doneItems: contractItems.length - incomplete.length,
  };
}

export function extractCodeEvidence(text) {
  const source = String(text ?? '');
  const match = source.match(CODE_EVIDENCE_RE);
  if (!match) return null;

  const body = match[1];
  // Try files_checked (producer style) or files_verified (reviewer style)
  const filesCheckedMatch = body.match(FILES_CHECKED_RE) || body.match(FILES_VERIFIED_RE);
  const evidenceSourceMatch = body.match(EVIDENCE_SOURCE_RE);
  const shaMatch = body.match(SHA_RE);
  const branchMatch = body.match(BRANCH_RE);
  const scopeMatch = body.match(EVIDENCE_SCOPE_RE);

  const parseFileList = (str) => {
    if (!str) return [];
    return str.split(',').map((f) => f.trim()).filter(Boolean);
  };

  return {
    filesChecked: filesCheckedMatch ? parseFileList(filesCheckedMatch[1]) : [],
    evidenceSource: evidenceSourceMatch ? evidenceSourceMatch[1] : null,
    sha: shaMatch ? shaMatch[1] : null,
    branchWorktree: branchMatch ? branchMatch[1].trim() : null,
    evidenceScope: scopeMatch ? scopeMatch[1] : null,
  };
}

export function hasCodeEvidence(text) {
  return CODE_EVIDENCE_RE.test(String(text ?? ''));
}

export function extractMacroAnswers(text, requiredQuestions = []) {
  const source = String(text ?? '');
  const match = source.match(MACRO_ANSWERS_RE);
  if (!match) return { found: [], satisfied: [], allSatisfied: false };
  const body = match[1];
  const found = [];
  const satisfied = [];
  for (const q of requiredQuestions) {
    const pattern = new RegExp(`\\b${q}\\b[^\\n]*`, 'i');
    const qMatch = body.match(pattern);
    if (qMatch) {
      found.push(q);
      // Consider satisfied if it has a non-empty answer (not just "Q1:" with nothing after)
      const answerText = qMatch[0].replace(/^[A-Z]\d+:\s*/i, '').trim();
      if (answerText && !/^n\/a|^none|^pending/i.test(answerText)) {
        satisfied.push(q);
      }
    }
  }
  return {
    found,
    satisfied,
    allSatisfied: requiredQuestions.length > 0 && satisfied.length === requiredQuestions.length,
  };
}

export function buildHandoff({ reviewerA, reviewerB, globalReviewer, producer, metrics, stageName, round }) {
  const blockersA = extractBullets(reviewerA, 'BLOCKERS');
  const blockersB = extractBullets(reviewerB, 'BLOCKERS');
  const blockersGlobal = globalReviewer ? extractBullets(globalReviewer, 'BLOCKERS') : [];
  const focusA = extractMetricValue(reviewerA, 'NEXT_FOCUS');
  const focusB = extractMetricValue(reviewerB, 'NEXT_FOCUS');
  const focusGlobal = globalReviewer ? extractMetricValue(globalReviewer, 'NEXT_FOCUS') : null;
  const producerChecks = extractMetricValue(producer, 'CHECKS');
  const contractItems = extractContractItems(producer);

  return {
    blockers: [...blockersA, ...blockersB, ...blockersGlobal],
    focusForNextRound: [focusA, focusB, focusGlobal].filter(Boolean).join('; ') || null,
    producerChecks,
    dimensionScores: {
      reviewerA: metrics?.reviewerADimensions ?? {},
      reviewerB: metrics?.reviewerBDimensions ?? {},
      globalReviewer: metrics?.globalReviewerVerdict ?? null,
    },
    contractItems,
    producerCodeEvidence: extractCodeEvidence(producer),
    reviewerACodeEvidence: extractCodeEvidence(reviewerA),
    reviewerBCodeEvidence: extractCodeEvidence(reviewerB),
    globalReviewerCodeEvidence: globalReviewer ? extractCodeEvidence(globalReviewer) : null,
    stageName,
    round,
    generatedAt: new Date().toISOString(),
  };
}

export function buildStageMetrics({ stageCriteria, producer, reviewerA, reviewerB, globalReviewer }) {
  const reviewerAVerdict = normalizeVerdict(reviewerA);
  const reviewerBVerdict = normalizeVerdict(reviewerB);
  const globalReviewerVerdict = globalReviewer ? normalizeVerdict(globalReviewer) : null;
  const globalReviewerRequired = stageCriteria?.globalReviewerRequired === true;
  const blockers = [
    ...extractBullets(reviewerA, 'BLOCKERS'),
    ...extractBullets(reviewerB, 'BLOCKERS'),
    ...(globalReviewerRequired ? extractBullets(globalReviewer, 'BLOCKERS') : []),
  ];
  const requiredProducerSections = stageCriteria?.requiredProducerSections ?? [];
  const requiredReviewerSections = stageCriteria?.requiredReviewerSections ?? [];
  const requiredGlobalReviewerSections = stageCriteria?.requiredGlobalReviewerSections ?? [];
  const producerSectionChecks = Object.fromEntries(
    requiredProducerSections.map((heading) => [heading, hasSection(producer, heading)]),
  );
  const reviewerSectionChecks = Object.fromEntries(
    requiredReviewerSections.map((heading) => [
      heading,
      hasSection(reviewerA, heading) && hasSection(reviewerB, heading),
    ]),
  );
  const globalReviewerChecks = Object.fromEntries(
    requiredGlobalReviewerSections.map((heading) => [heading, globalReviewer ? hasSection(globalReviewer, heading) : false]),
  );
  const requiredMacroAnswers = stageCriteria?.globalReviewerMustAnswer ?? [];
  const macroAnswers = globalReviewer ? extractMacroAnswers(globalReviewer, requiredMacroAnswers) : { found: [], satisfied: [], allSatisfied: false };
  const approvalCount = [
    reviewerAVerdict,
    reviewerBVerdict,
    ...(globalReviewerRequired ? [globalReviewerVerdict] : []),
  ].filter((v) => v === 'APPROVE').length;

  const scoringDimensions = stageCriteria?.scoringDimensions ?? [];
  const dimensionThreshold = stageCriteria?.dimensionThreshold ?? 3;
  const reviewerADimensions = parseDimensions(reviewerA);
  const reviewerBDimensions = parseDimensions(reviewerB);
  const dimensionCheckA = checkDimensionThresholds(reviewerADimensions, scoringDimensions, dimensionThreshold);
  const dimensionCheckB = checkDimensionThresholds(reviewerBDimensions, scoringDimensions, dimensionThreshold);

  const requiredDeliverables = stageCriteria?.requiredDeliverables ?? [];
  const contractItems = extractContractItems(producer);
  const contractCheck = checkContractCompletion(contractItems);

  return {
    approvalCount,
    blockerCount: blockers.length,
    reviewerAVerdict,
    reviewerBVerdict,
    reviewerAHasExplicitVerdict: hasExplicitVerdict(reviewerA),
    reviewerBHasExplicitVerdict: hasExplicitVerdict(reviewerB),
    blockers,
    producerSectionChecks,
    reviewerSectionChecks,
    producerChecks: extractMetricValue(producer, 'CHECKS'),
    reviewerAChecks: extractMetricValue(reviewerA, 'CHECKS'),
    reviewerBChecks: extractMetricValue(reviewerB, 'CHECKS'),
    scoringDimensions,
    reviewerADimensions,
    reviewerBDimensions,
    dimensionCheckA,
    dimensionCheckB,
    dimensionFailures: [...dimensionCheckA.failures, ...dimensionCheckB.failures],
    contractItems,
    contractCheck,
    requiredDeliverables,
    producerCodeEvidence: extractCodeEvidence(producer),
    reviewerACodeEvidence: extractCodeEvidence(reviewerA),
    reviewerBCodeEvidence: extractCodeEvidence(reviewerB),
    producerHasCodeEvidence: hasCodeEvidence(producer),
    reviewerAHasCodeEvidence: hasCodeEvidence(reviewerA),
    reviewerBHasCodeEvidence: hasCodeEvidence(reviewerB),
    // global reviewer fields
    globalReviewerVerdict,
    globalReviewerHasExplicitVerdict: globalReviewer ? hasExplicitVerdict(globalReviewer) : false,
    globalReviewerChecks,
    globalReviewerRequired,
    macroAnswersFound: macroAnswers.found,
    macroAnswersSatisfied: macroAnswers.satisfied,
    macroAnswersAllSatisfied: macroAnswers.allSatisfied,
    requiredMacroAnswers,
  };
}

export function decideStage({ stageCriteria, producer, reviewerA, reviewerB, globalReviewer, currentRound, maxRoundsPerStage }) {
  const verdictA = normalizeVerdict(reviewerA);
  const verdictB = normalizeVerdict(reviewerB);
  const globalReviewerRequired = stageCriteria?.globalReviewerRequired === true;
  const metrics = buildStageMetrics({ stageCriteria, producer, reviewerA, reviewerB, globalReviewer });
  const blockers = metrics.blockers;
  const producerSectionsSatisfied = Object.values(metrics.producerSectionChecks).every(Boolean);
  const reviewerSectionsSatisfied = Object.values(metrics.reviewerSectionChecks).every(Boolean);
  const globalReviewerSectionsSatisfied = globalReviewerRequired
    ? Object.values(metrics.globalReviewerChecks).every(Boolean)
    : true;
  const requiredApprovals = stageCriteria?.requiredApprovals ?? (globalReviewerRequired ? 3 : 2);
  const explicitVerdictsOk = metrics.reviewerAHasExplicitVerdict &&
    metrics.reviewerBHasExplicitVerdict &&
    (!globalReviewerRequired || metrics.globalReviewerHasExplicitVerdict);
  const structuralBlockers = [];

  if (!explicitVerdictsOk) {
    if (globalReviewerRequired && !metrics.globalReviewerHasExplicitVerdict) {
      structuralBlockers.push('Global reviewer did not emit a strict VERDICT: APPROVE|REVISE|BLOCK line.');
    }
    if (!metrics.reviewerAHasExplicitVerdict) {
      structuralBlockers.push('Reviewer A did not emit a strict VERDICT: APPROVE|REVISE|BLOCK line.');
    }
    if (!metrics.reviewerBHasExplicitVerdict) {
      structuralBlockers.push('Reviewer B did not emit a strict VERDICT: APPROVE|REVISE|BLOCK line.');
    }
  }

  // Dimension threshold failures become structural blockers
  if (metrics.dimensionFailures.length > 0) {
    structuralBlockers.push(...metrics.dimensionFailures);
  }

  // Contract completion check: if requiredDeliverables are defined, all contract items must be DONE
  if (metrics.requiredDeliverables.length > 0 && !metrics.contractCheck.allDone) {
    const incomplete = metrics.contractCheck.incompleteItems
      .map((item) => `"${item.deliverable}" is ${item.status}`)
      .join('; ');
    structuralBlockers.push(`Contract not fulfilled: ${incomplete}`);
  }

  // Global reviewer macro answers check
  if (globalReviewerRequired && metrics.requiredMacroAnswers.length > 0 && !metrics.macroAnswersAllSatisfied) {
    const missing = metrics.requiredMacroAnswers.filter((q) => !metrics.macroAnswersSatisfied.includes(q));
    structuralBlockers.push(`Global reviewer missing or incomplete macro answers: ${missing.join(', ')}`);
  }

  // Global reviewer sections check
  if (globalReviewerRequired && !globalReviewerSectionsSatisfied) {
    const missing = Object.entries(metrics.globalReviewerChecks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    structuralBlockers.push(`Global reviewer missing required sections: ${missing.join(', ')}`);
  }

  // Global BLOCK is always a structural blocker
  if (globalReviewerRequired && metrics.globalReviewerVerdict === 'BLOCK') {
    const globalBlockers = extractBullets(globalReviewer, 'BLOCKERS');
    if (globalBlockers.length > 0) {
      structuralBlockers.push(...globalBlockers.map((b) => `[GLOBAL] ${b}`));
    } else {
      structuralBlockers.push('Global reviewer BLOCKED with no specific blockers listed.');
    }
  }

  const allBlockers = [...structuralBlockers, ...blockers];

  if (
    verdictA === 'APPROVE' &&
    verdictB === 'APPROVE' &&
    (!globalReviewerRequired || metrics.globalReviewerVerdict === 'APPROVE') &&
    explicitVerdictsOk &&
    metrics.approvalCount >= requiredApprovals &&
    producerSectionsSatisfied &&
    reviewerSectionsSatisfied &&
    globalReviewerSectionsSatisfied &&
    allBlockers.length === 0
  ) {
    return {
      outcome: 'advance',
      blockers: allBlockers,
      metrics,
      summary: 'All reviewers approved the stage output.',
    };
  }

  if (currentRound >= maxRoundsPerStage) {
    return {
      outcome: 'halt',
      blockers: [...structuralBlockers, ...blockers],
      metrics,
      summary: 'Stage exceeded maximum rounds without all required approvals.',
    };
  }

  return {
    outcome: 'revise',
    blockers: [...structuralBlockers, ...blockers],
    metrics,
    summary: 'At least one reviewer requested revision or blocked progress.',
  };
}
