export type BrokenArtifactScenarioName =
  | 'missing_artifact'
  | 'malformed_metadata'
  | 'source_task_id_mismatch'
  | 'duplicate_artifacts_ambiguous'
  | 'downstream_continues_on_missing'
  | 'integrity_report_structure'
  | 'repair_dry_run_idempotent';

export interface BrokenArtifactScenario {
  scenarioName: BrokenArtifactScenarioName;
  description: string;
  status: 'passed' | 'failed';
  brokenLinkType: string;
  reason: string;
  nextAction: string;
  evidence?: Record<string, unknown>;
}

export interface BrokenArtifactSimulationSummary {
  status: 'healthy' | 'degraded' | 'error';
  generatedAt: string;
  scenarios: BrokenArtifactScenario[];
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  recommendedNextIssue?: string;
}

export interface SimulatedUpstreamTask {
  taskId: string;
  taskKind: string;
  status: string;
  resultRef: string | null;
  diagnosticJson: string | null;
}

export interface SimulatedArtifact {
  artifactId: string;
  sourceTaskId: string;
  artifactKind: string;
  contentJson: string | null;
  metadataJson: string | null;
}

export interface SimulatedDownstreamTask {
  taskId: string;
  taskKind: string;
  status: string;
  dependencyTaskIds: string[];
  expectedArtifactKinds: string[];
}

export interface BrokenLinkDetection {
  type: string;
  severity: 'warning' | 'error';
  taskId?: string;
  artifactId?: string;
  reason: string;
  nextAction: string;
}

export interface ArtifactMetadataValidation {
  valid: boolean;
  errors: string[];
  artifactId: string;
}

export interface LineageConsistencyCheck {
  consistent: boolean;
  sourceTaskId: string;
  dependencyTaskId: string;
  mismatchReason?: string;
}

export interface DuplicateArtifactResolution {
  resolved: boolean;
  selectedArtifactId: string | null;
  candidateCount: number;
  reason: string;
}

export interface DownstreamGateDecision {
  allowed: boolean;
  reason: string;
  blockedBy?: string;
}

const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_JSON_LENGTH = 2000;

export function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  return reason.slice(0, MAX_REASON_LENGTH - 3) + '...';
}

function safeParseJson(text: string): { success: true; value: unknown } | { success: false } {
  try {
    return { success: true, value: JSON.parse(text) };
  } catch {
    return { success: false };
  }
}

export function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'bigint') return `${value}n`;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'object' && value !== null) {
      const proto = Object.getPrototypeOf(value);
      if (proto === null) {
        return JSON.stringify(Object.fromEntries(Object.entries(value)));
      }
    }
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function boundedEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  let json: string | null = null;
  try {
    json = JSON.stringify(evidence);
  } catch {
    // circular or BigInt — fall through to truncation
  }
  if (json !== null && json.length <= MAX_EVIDENCE_JSON_LENGTH) return evidence;
  const keys = Object.keys(evidence);
  const truncated: Record<string, unknown> = {};
  let budget = MAX_EVIDENCE_JSON_LENGTH - 2;
  let first = true;
  for (const key of keys) {
    const comma = first ? 0 : 1;
    const entry = `"${key}":${safeStringify(evidence[key])}`;
    if (entry.length + comma <= budget) {
      truncated[key] = safeStringify(evidence[key]);
      budget -= entry.length + comma;
      first = false;
    } else {
      truncated[key] = '[truncated]';
      break;
    }
  }
  const truncatedJson = JSON.stringify(truncated);
  if (truncatedJson.length > MAX_EVIDENCE_JSON_LENGTH) {
    const safeKeys = keys.slice(0, 3).map(k => k.length > 50 ? k.slice(0, 47) + '...' : k);
    return { _truncated: true, keys: safeKeys };
  }
  return truncated;
}

export function detectMissingArtifact(
  upstreamTask: SimulatedUpstreamTask,
  artifacts: SimulatedArtifact[],
  expectedKind: string,
): BrokenLinkDetection {
  if (upstreamTask.status !== 'succeeded') {
    return {
      type: 'upstream_not_succeeded',
      severity: 'warning',
      taskId: upstreamTask.taskId,
      reason: `Upstream task ${upstreamTask.taskId} status is '${upstreamTask.status}', not 'succeeded'`,
      nextAction: 'Wait for upstream task to succeed before checking artifact presence',
    };
  }

  const matching = artifacts.filter(a => a.sourceTaskId === upstreamTask.taskId && a.artifactKind === expectedKind);
  if (matching.length === 0) {
    return {
      type: 'missing_artifact',
      severity: 'error',
      taskId: upstreamTask.taskId,
      reason: `Succeeded upstream task ${upstreamTask.taskId} has no '${expectedKind}' artifact`,
      nextAction: 'Re-run the upstream task or investigate artifact commit failure',
    };
  }

  const [firstMatch] = matching;
  return {
    type: 'artifact_present',
    severity: 'warning',
    taskId: upstreamTask.taskId,
    artifactId: firstMatch?.artifactId,
    reason: `Succeeded upstream task ${upstreamTask.taskId} has '${expectedKind}' artifact`,
    nextAction: 'No action needed',
  };
}

export function validateArtifactMetadata(
  artifact: SimulatedArtifact,
): ArtifactMetadataValidation {
  const errors: string[] = [];

  if (artifact.metadataJson === null) {
    errors.push('metadataJson is null — artifact metadata missing');
  } else {
    const parseResult = safeParseJson(artifact.metadataJson);
    if (!parseResult.success) {
      errors.push(`metadataJson is not valid JSON: ${truncateReason(artifact.metadataJson.slice(0, 100))}`);
      return { valid: false, errors, artifactId: artifact.artifactId };
    }

    const parsed = parseResult.value;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push(`metadataJson parsed to ${typeof parsed} instead of object`);
    } else {
      const parsedObj = parsed as Record<string, unknown>;
      if (!Object.hasOwn(parsed, 'sourceTaskId')) {
        errors.push('metadataJson missing required field: sourceTaskId');
      } else {
        const { sourceTaskId } = parsedObj;
        if (typeof sourceTaskId !== 'string') {
          errors.push(`metadataJson.sourceTaskId is ${typeof sourceTaskId}, expected string`);
        } else if (sourceTaskId !== artifact.sourceTaskId) {
          errors.push(`metadataJson.sourceTaskId '${sourceTaskId}' does not match artifact.sourceTaskId '${artifact.sourceTaskId}'`);
        }
      }

      if (!Object.hasOwn(parsed, 'artifactKind')) {
        errors.push('metadataJson missing required field: artifactKind');
      } else {
        const { artifactKind } = parsedObj;
        if (typeof artifactKind !== 'string') {
          errors.push(`metadataJson.artifactKind is ${typeof artifactKind}, expected string`);
        }
      }
    }
  }

  if (artifact.contentJson === null) {
    errors.push('contentJson is null — artifact content missing');
  }

  return {
    valid: errors.length === 0,
    errors,
    artifactId: artifact.artifactId,
  };
}

export function checkLineageConsistency(
  artifact: SimulatedArtifact,
  dependencyTaskId: string,
): LineageConsistencyCheck {
  if (artifact.sourceTaskId === dependencyTaskId) {
    return {
      consistent: true,
      sourceTaskId: artifact.sourceTaskId,
      dependencyTaskId,
    };
  }

  return {
    consistent: false,
    sourceTaskId: artifact.sourceTaskId,
    dependencyTaskId,
    mismatchReason: `artifact.sourceTaskId '${artifact.sourceTaskId}' does not match dependencyTaskId '${dependencyTaskId}'`,
  };
}

export function resolveDuplicateArtifacts(
  artifacts: SimulatedArtifact[],
  sourceTaskId: string,
  artifactKind: string,
): DuplicateArtifactResolution {
  const candidates = artifacts.filter(
    a => a.sourceTaskId === sourceTaskId && a.artifactKind === artifactKind,
  );

  if (candidates.length === 0) {
    return {
      resolved: false,
      selectedArtifactId: null,
      candidateCount: 0,
      reason: `No artifacts found for sourceTaskId '${sourceTaskId}' and kind '${artifactKind}'`,
    };
  }

  if (candidates.length === 1) {
    const [candidate] = candidates;
    return {
      resolved: true,
      selectedArtifactId: candidate ? candidate.artifactId : null,
      candidateCount: 1,
      reason: 'Single artifact found — deterministic selection',
    };
  }

  const sorted = [...candidates].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const [firstSorted] = sorted;
  return {
    resolved: false,
    selectedArtifactId: firstSorted ? firstSorted.artifactId : null,
    candidateCount: candidates.length,
    reason: `Multiple artifacts (${candidates.length}) found for sourceTaskId '${sourceTaskId}' and kind '${artifactKind}' — deterministic sort by artifactId selected first, but ambiguity requires operator review`,
  };
}

export function decideDownstreamGate(
  downstreamTask: SimulatedDownstreamTask,
  artifacts: SimulatedArtifact[],
): DownstreamGateDecision {
  if (downstreamTask.dependencyTaskIds.length === 0) {
    return {
      allowed: true,
      reason: 'No dependencies — downstream task can proceed',
    };
  }

  for (const depId of downstreamTask.dependencyTaskIds) {
    for (const expectedKind of downstreamTask.expectedArtifactKinds) {
      const matching = artifacts.filter(
        a => a.sourceTaskId === depId && a.artifactKind === expectedKind,
      );

      if (matching.length === 0) {
        const wrongSourceArtifacts = artifacts.filter(
          a => a.artifactKind === expectedKind && a.sourceTaskId !== depId,
        );
        if (wrongSourceArtifacts.length > 0) {
          const [wrongArtifact] = wrongSourceArtifacts;
          if (wrongArtifact) {
            const lineageCheck = checkLineageConsistency(wrongArtifact, depId);
            return {
              allowed: false,
              reason: `Lineage mismatch: ${lineageCheck.mismatchReason}`,
              blockedBy: `lineage_mismatch:${depId}`,
            };
          }
        }

        return {
          allowed: false,
          reason: `Missing artifact: dependency '${depId}' has no '${expectedKind}' artifact`,
          blockedBy: `missing_artifact:${depId}:${expectedKind}`,
        };
      }

      const [matchedArtifact] = matching;
      if (!matchedArtifact) {
        return {
          allowed: false,
          reason: `Missing artifact: dependency '${depId}' has no '${expectedKind}' artifact`,
          blockedBy: `missing_artifact:${depId}:${expectedKind}`,
        };
      }

      const lineageCheck = checkLineageConsistency(matchedArtifact, depId);
      if (!lineageCheck.consistent) {
        return {
          allowed: false,
          reason: `Lineage mismatch: ${lineageCheck.mismatchReason}`,
          blockedBy: `lineage_mismatch:${depId}`,
        };
      }

      const metaValidation = validateArtifactMetadata(matchedArtifact);
      if (!metaValidation.valid) {
        return {
          allowed: false,
          reason: `Malformed artifact metadata: ${metaValidation.errors.join('; ')}`,
          blockedBy: `malformed_metadata:${matchedArtifact.artifactId}`,
        };
      }
    }
  }

  return {
    allowed: true,
    reason: 'All dependency artifacts present, valid, and lineage-consistent',
  };
}

export function computeSimulationStatus(scenarios: BrokenArtifactScenario[]): 'healthy' | 'degraded' | 'error' {
  const hasFailed = scenarios.some(s => s.status === 'failed');
  const hasPassed = scenarios.some(s => s.status === 'passed');
  if (!hasPassed) return 'error';
  if (hasFailed) return 'degraded';
  return 'healthy';
}

export function recommendNextIssue(scenarios: BrokenArtifactScenario[]): string | undefined {
  const firstFailed = scenarios.find(s => s.status === 'failed');
  if (!firstFailed) return undefined;
  switch (firstFailed.scenarioName) {
    case 'missing_artifact':
      return 'PRI-209: Missing artifact not detected — check integrity read model missing_artifact detection';
    case 'malformed_metadata':
      return 'PRI-209: Malformed metadata not caught — check artifact metadata runtime validation';
    case 'source_task_id_mismatch':
      return 'PRI-209: SourceTaskId mismatch not caught — check lineage consistency validation';
    case 'duplicate_artifacts_ambiguous':
      return 'PRI-209: Duplicate artifacts not resolved — check deterministic artifact selection';
    case 'downstream_continues_on_missing':
      return 'PRI-209: Downstream runner proceeds despite missing artifact — check dependency gate';
    case 'integrity_report_structure':
      return 'PRI-209: Integrity report missing required fields — check BrokenLink type contract';
    case 'repair_dry_run_idempotent':
      return 'PRI-209: Repair not idempotent — check remediation dry-run/confirm semantics';
    default:
      return undefined;
  }
}

export function buildSimulationSummary(
  scenarios: BrokenArtifactScenario[],
): BrokenArtifactSimulationSummary {
  const passed = scenarios.filter(s => s.status === 'passed').length;
  const failed = scenarios.filter(s => s.status === 'failed').length;

  return {
    status: computeSimulationStatus(scenarios),
    generatedAt: new Date().toISOString(),
    scenarios,
    totalScenarios: scenarios.length,
    passedScenarios: passed,
    failedScenarios: failed,
    recommendedNextIssue: recommendNextIssue(scenarios),
  };
}
