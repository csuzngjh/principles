export function normalizeVerdict(text) {
  const match = String(text ?? '').match(/VERDICT:\s*(APPROVE|REVISE|BLOCK)\b/i);
  return match ? match[1].toUpperCase() : 'REVISE';
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

export function decideStage({ reviewerA, reviewerB, currentRound, maxRoundsPerStage }) {
  const verdictA = normalizeVerdict(reviewerA);
  const verdictB = normalizeVerdict(reviewerB);
  const blockers = [
    ...extractBullets(reviewerA, 'BLOCKERS'),
    ...extractBullets(reviewerB, 'BLOCKERS'),
  ];

  if (verdictA === 'APPROVE' && verdictB === 'APPROVE') {
    return {
      outcome: 'advance',
      blockers,
      summary: 'Both reviewers approved the stage output.',
    };
  }

  if (currentRound >= maxRoundsPerStage) {
    return {
      outcome: 'halt',
      blockers,
      summary: 'Stage exceeded maximum rounds without both reviewers approving.',
    };
  }

  return {
    outcome: 'revise',
    blockers,
    summary: 'At least one reviewer requested revision or blocked progress.',
  };
}
