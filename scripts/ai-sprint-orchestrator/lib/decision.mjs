const VERDICT_RE = /(?:VERDICT:\s*\*{0,2}|##\s*VERDICT\s*\n+\*{0,2}\s*)(APPROVE|REVISE|BLOCK)\b/i;

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
    .filter(Boolean);
}

export function hasSection(text, heading) {
  const pattern = new RegExp(`^${heading}:|^##\\s+${heading}\\b`, 'im');
  return pattern.test(String(text ?? ''));
}

export function extractMetricValue(text, key) {
  const match = String(text ?? '').match(new RegExp(`${key}:\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : null;
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

  if (
    verdictA === 'APPROVE' &&
    verdictB === 'APPROVE' &&
    explicitVerdictsOk &&
    metrics.approvalCount >= requiredApprovals &&
    producerSectionsSatisfied &&
    reviewerSectionsSatisfied
  ) {
    return {
      outcome: 'advance',
      blockers: [...structuralBlockers, ...blockers],
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
