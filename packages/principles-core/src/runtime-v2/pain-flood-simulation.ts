export type PainFloodScenarioName =
  | 'identical_flood'
  | 'similar_flood'
  | 'duplicate_submission'
  | 'tool_failure_flood'
  | 'stress_test';

export interface PainFloodStage {
  scenarioName: PainFloodScenarioName;
  status: 'passed' | 'failed' | 'skipped';
  inputCount: number;
  acceptedCount: number;
  skippedCount: number;
  taskCount: number;
  candidateCount: number;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface PainFloodSimulationSummary {
  status: 'healthy' | 'degraded' | 'error';
  workspaceMode: 'temp' | 'explicit_workspace';
  generatedAt: string;
  inputPainCount: number;
  acceptedPainCount: number;
  skippedDuplicateCount: number;
  candidateCount: number;
  taskCount: number;
  maxEvidencePreviewLength: number;
  contextBudgetSummary: string;
  stages: PainFloodStage[];
  recommendedNextIssue?: string;
}

export interface PainFloodSimulationOptions {
  workspaceDir: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  identicalCount?: number;
  similarCount?: number;
  stressCount?: number;
}

const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_JSON_LENGTH = 2000;

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

export function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  return reason.slice(0, MAX_REASON_LENGTH - 3) + '...';
}

export function boundedFloodEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
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

export function computeFloodTotals(stages: PainFloodStage[]): {
  inputPainCount: number;
  acceptedPainCount: number;
  skippedDuplicateCount: number;
  candidateCount: number;
  taskCount: number;
} {
  let inputPainCount = 0;
  let acceptedPainCount = 0;
  let candidateCount = 0;
  let taskCount = 0;

  for (const stage of stages) {
    if (stage.status === 'skipped') continue;
    inputPainCount += stage.inputCount;
    acceptedPainCount += stage.acceptedCount;
    candidateCount += stage.candidateCount;
    taskCount += stage.taskCount;
  }

  return {
    inputPainCount,
    acceptedPainCount,
    skippedDuplicateCount: inputPainCount - acceptedPainCount,
    candidateCount,
    taskCount,
  };
}

export function computeFloodStatus(stages: PainFloodStage[]): 'healthy' | 'degraded' | 'error' {
  const hasFailed = stages.some(s => s.status === 'failed');
  const hasPassed = stages.some(s => s.status === 'passed');
  if (!hasPassed) return 'error';
  if (hasFailed) return 'degraded';
  return 'healthy';
}

export function formatContextBudgetSummary(maxPreviewLength: number): string {
  if (maxPreviewLength <= 0) return 'no evidence produced';
  if (maxPreviewLength <= 100) return `bounded (max ${maxPreviewLength} chars)`;
  if (maxPreviewLength <= 500) return `moderate (max ${maxPreviewLength} chars)`;
  if (maxPreviewLength <= 2000) return `large (max ${maxPreviewLength} chars)`;
  return `unbounded (max ${maxPreviewLength} chars) — exceeds budget recommendation`;
}

export function recommendFloodNextIssue(stages: PainFloodStage[]): string | undefined {
  const firstFailed = stages.find(s => s.status === 'failed');
  if (!firstFailed) return undefined;
  switch (firstFailed.scenarioName) {
    case 'identical_flood':
      return 'PRI-208: Identical pain dedup failed — check PainSignalBridge idempotent upsert logic';
    case 'similar_flood':
      return 'PRI-208: Similar pain flood caused unbounded task creation — check dedup and evidence budget';
    case 'duplicate_submission':
      return 'PRI-208: Duplicate pain submission not skipped — check buildExistingResult path';
    case 'tool_failure_flood':
      return 'PRI-208: Tool failure flood dedup failed — check error-hash-based dedup logic';
    case 'stress_test':
      return 'PRI-208: Stress test produced unbounded evidence — check context budget enforcement';
    default:
      return undefined;
  }
}

export function maxEvidencePreviewLength(stages: PainFloodStage[]): number {
  let max = 0;
  for (const stage of stages) {
    if (stage.evidence) {
      const json = JSON.stringify(stage.evidence);
      if (json.length > max) max = json.length;
    }
  }
  return max;
}