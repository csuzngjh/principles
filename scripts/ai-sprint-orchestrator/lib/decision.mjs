const VERDICT_RE = /(?:VERDICT:\s*\*{0,2}|##\s*VERDICT\s*\n+\*{0,2}\s*)(APPROVE|REVISE|BLOCK)\b/i;
const DIMENSIONS_RE = /^DIMENSIONS:\s*(.+)$/im;
const CONTRACT_RE = /CONTRACT:\s*([\s\S]*?)(?:\n[A-Z_ ]+:|$)/i;

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

export function buildHandoff({ reviewerA, reviewerB, producer, metrics, stageName, round }) {
  const blockersA = extractBullets(reviewerA, 'BLOCKERS');
  const blockersB = extractBullets(reviewerB, 'BLOCKERS');
  const focusA = extractMetricValue(reviewerA, 'NEXT_FOCUS');
  const focusB = extractMetricValue(reviewerB, 'NEXT_FOCUS');
  const producerChecks = extractMetricValue(producer, 'CHECKS');
  const contractItems = extractContractItems(producer);

  return {
    blockers: [...blockersA, ...blockersB],
    focusForNextRound: [focusA, focusB].filter(Boolean).join('; ') || null,
    producerChecks,
    dimensionScores: {
      reviewerA: metrics?.reviewerADimensions ?? {},
      reviewerB: metrics?.reviewerBDimensions ?? {},
    },
    contractItems,
    stageName,
    round,
    generatedAt: new Date().toISOString(),
  };
}

export function buildStageMetrics({ stageCriteria, producer, reviewerA, reviewerB }) {
  const reviewerAVerdict = normalizeVerdict(reviewerA);
  const reviewerBVerdict = normalizeVerdict(reviewerB);
  const blockers = [
    ...extractBullets(reviewerA, 'BLOCKERS'),
    ...extractBullets(reviewerB, 'BLOCKERS'),
  ];
  const requiredProducerSections = stageCriteria?.requiredProducerSections ?? [];
  const requiredReviewerSections = stageCriteria?.requiredReviewerSections ?? [];
  const producerSectionChecks = Object.fromEntries(
    requiredProducerSections.map((heading) => [heading, hasSection(producer, heading)]),
  );
  const reviewerSectionChecks = Object.fromEntries(
    requiredReviewerSections.map((heading) => [
      heading,
      hasSection(reviewerA, heading) && hasSection(reviewerB, heading),
    ]),
  );
  const approvalCount = [reviewerAVerdict, reviewerBVerdict].filter((v) => v === 'APPROVE').length;

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
  };
}

export function decideStage({ stageCriteria, producer, reviewerA, reviewerB, currentRound, maxRoundsPerStage }) {
  const verdictA = normalizeVerdict(reviewerA);
  const verdictB = normalizeVerdict(reviewerB);
  const metrics = buildStageMetrics({ stageCriteria, producer, reviewerA, reviewerB });
  const blockers = metrics.blockers;
  const producerSectionsSatisfied = Object.values(metrics.producerSectionChecks).every(Boolean);
  const reviewerSectionsSatisfied = Object.values(metrics.reviewerSectionChecks).every(Boolean);
  const requiredApprovals = stageCriteria?.requiredApprovals ?? 2;
  const explicitVerdictsOk = metrics.reviewerAHasExplicitVerdict && metrics.reviewerBHasExplicitVerdict;
  const structuralBlockers = [];

  if (!explicitVerdictsOk) {
    structuralBlockers.push('One or more reviewers did not emit a strict VERDICT: APPROVE|REVISE|BLOCK line.');
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

  const allBlockers = [...structuralBlockers, ...blockers];

  if (
    verdictA === 'APPROVE' &&
    verdictB === 'APPROVE' &&
    explicitVerdictsOk &&
    metrics.approvalCount >= requiredApprovals &&
    producerSectionsSatisfied &&
    reviewerSectionsSatisfied &&
    allBlockers.length === 0
  ) {
    return {
      outcome: 'advance',
      blockers: allBlockers,
      metrics,
      summary: 'Both reviewers approved the stage output.',
    };
  }

  if (currentRound >= maxRoundsPerStage) {
    return {
      outcome: 'halt',
      blockers: [...structuralBlockers, ...blockers],
      metrics,
      summary: 'Stage exceeded maximum rounds without both reviewers approving.',
    };
  }

  return {
    outcome: 'revise',
    blockers: [...structuralBlockers, ...blockers],
    metrics,
    summary: 'At least one reviewer requested revision or blocked progress.',
  };
}
