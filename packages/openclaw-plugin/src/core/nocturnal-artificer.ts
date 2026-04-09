import type { NocturnalSessionSnapshot } from './nocturnal-trajectory-extractor.js';
import {
  getPrincipleSubtree,
  listImplementationsForRule,
  listRuleImplementationsByState,
} from './principle-tree-ledger.js';
import type { LedgerRule } from './principle-tree-ledger.js';

export type ArtificerArtifactKind = 'rule-implementation-candidate';

export interface ArtificerLineageMetadata {
  artifactKind: ArtificerArtifactKind;
  sourceSnapshotRef: string;
  sourcePainIds: string[];
  sourceGateBlockIds: string[];
}

export interface ArtificerInput {
  principleId: string;
  ruleId: string;
  snapshot: NocturnalSessionSnapshot;
  scribeArtifact: {
    sessionId: string;
    badDecision: string;
    betterDecision: string;
    rationale: string;
    sourceSnapshotRef: string;
  };
  lineage: ArtificerLineageMetadata;
}

export interface ArtificerOutput {
  ruleId: string;
  implementationType: 'code';
  candidateSource: string;
  helperUsage: string[];
  expectedDecision: 'allow' | 'block' | 'requireApproval';
  rationale: string;
  lineage: ArtificerLineageMetadata;
}

export interface ArtificerTargetRuleScore {
  ruleId: string;
  score: number;
  matchedSignals: string[];
}

export type ArtificerTargetRuleResolution =
  | {
      status: 'selected';
      ruleId: string;
      reason: 'single-rule' | 'evidence-winner';
      scores: ArtificerTargetRuleScore[];
    }
  | {
      status: 'skip';
      reason:
        | 'principle-not-found'
        | 'no-rules'
        | 'ambiguous-target-rule'
        | 'no-deterministic-signal';
      scores: ArtificerTargetRuleScore[];
    };

export interface TrinityArtificerContext {
  principleId: string;
  resolution: ArtificerTargetRuleResolution;
  eligible: boolean;
}

function tokenize(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function countMatches(tokens: string[], haystacks: string[]): number {
  return tokens.reduce((total, token) => {
    if (haystacks.some((haystack) => haystack.includes(token))) {
      return total + 1;
    }
    return total;
  }, 0);
}

function scoreRule(
  stateDir: string,
  rule: LedgerRule,
  snapshot: NocturnalSessionSnapshot
): ArtificerTargetRuleScore {
  const toolNames = snapshot.toolCalls.map((toolCall) => toolCall.toolName.toLowerCase());
  const painReasons = snapshot.painEvents
    .map((painEvent) => painEvent.reason?.toLowerCase())
    .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
  const gateReasons = snapshot.gateBlocks.map((gateBlock) => gateBlock.reason.toLowerCase());
  const ruleTokens = [
    ...tokenize(rule.name),
    ...tokenize(rule.description),
    ...tokenize(rule.triggerCondition),
    ...tokenize(rule.action),
  ];

  const gateMatches = countMatches(ruleTokens, gateReasons);
  const painMatches = countMatches(ruleTokens, painReasons);
  const toolMatches = countMatches(ruleTokens, toolNames);
  const candidateImplCount = listRuleImplementationsByState(stateDir, rule.id, 'candidate').length;
  const totalImplCount = listImplementationsForRule(stateDir, rule.id).length;
  const implementationSignal = Math.max(totalImplCount - candidateImplCount, 0);
  const score = gateMatches * 1000 + painMatches * 100 + toolMatches * 10 + implementationSignal;
  const matchedSignals: string[] = [];

  if (gateMatches > 0) {
    matchedSignals.push(`gate:${gateMatches}`);
  }
  if (painMatches > 0) {
    matchedSignals.push(`pain:${painMatches}`);
  }
  if (toolMatches > 0) {
    matchedSignals.push(`tool:${toolMatches}`);
  }
  if (implementationSignal > 0) {
    matchedSignals.push(`impl:${implementationSignal}`);
  }

  return {
    ruleId: rule.id,
    score,
    matchedSignals,
  };
}

export function resolveArtificerTargetRule(
  stateDir: string,
  principleId: string,
  snapshot: NocturnalSessionSnapshot
): ArtificerTargetRuleResolution {
  const subtree = getPrincipleSubtree(stateDir, principleId);
  if (!subtree) {
    return {
      status: 'skip',
      reason: 'principle-not-found',
      scores: [],
    };
  }

  const eligibleRules = subtree.rules
    .map((entry) => entry.rule)
    .filter((rule) => rule.status !== 'retired');

  if (eligibleRules.length === 0) {
    return {
      status: 'skip',
      reason: 'no-rules',
      scores: [],
    };
  }

  if (eligibleRules.length === 1) {
    return {
      status: 'selected',
      ruleId: eligibleRules[0].id,
      reason: 'single-rule',
      scores: [
        {
          ruleId: eligibleRules[0].id,
          score: 1,
          matchedSignals: ['single-rule'],
        },
      ],
    };
  }

  const scores = eligibleRules.map((rule) => scoreRule(stateDir, rule, snapshot));
  const sorted = [...scores].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.ruleId.localeCompare(right.ruleId);
  });
  const winner = sorted[0];
  const runnerUp = sorted[1];

  if (!winner || winner.score === 0) {
    return {
      status: 'skip',
      reason: 'no-deterministic-signal',
      scores: sorted,
    };
  }

  if (runnerUp && runnerUp.score === winner.score) {
    return {
      status: 'skip',
      reason: 'ambiguous-target-rule',
      scores: sorted,
    };
  }

  return {
    status: 'selected',
    ruleId: winner.ruleId,
    reason: 'evidence-winner',
    scores: sorted,
  };
}

export function shouldRunArtificer(
  snapshot: NocturnalSessionSnapshot,
  resolution: ArtificerTargetRuleResolution,
  minimumSignalCount = 2
): boolean {
  if (resolution.status !== 'selected') {
    return false;
  }

  const signalCount =
    snapshot.stats.totalPainEvents +
    snapshot.stats.totalGateBlocks +
    snapshot.stats.failureCount;

  return signalCount >= minimumSignalCount;
}

export function parseArtificerOutput(payload: string): ArtificerOutput | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ArtificerOutput>;
    if (
      typeof parsed.ruleId !== 'string' ||
      typeof parsed.candidateSource !== 'string' ||
      !Array.isArray(parsed.helperUsage) ||
      typeof parsed.expectedDecision !== 'string' ||
      typeof parsed.rationale !== 'string' ||
      !parsed.lineage
    ) {
      return null;
    }

    return {
      ruleId: parsed.ruleId,
      implementationType: 'code',
      candidateSource: parsed.candidateSource,
      helperUsage: parsed.helperUsage.filter(
        (value): value is string => typeof value === 'string'
      ),
      expectedDecision: parsed.expectedDecision,
      rationale: parsed.rationale,
      lineage: parsed.lineage,
    };
  } catch {
    return null;
  }
}
