import type { DiagnosticianOutputV1 } from './diagnostician-output.js';

export type SyntheticBaselineStageName =
  | 'pain_intake'
  | 'diagnostician_task_created'
  | 'candidate_created'
  | 'ledger_consistent'
  | 'internalization_queue_ready'
  | 'canary_health';

export type SyntheticBaselineFailStage =
  | 'before_pain_intake'
  | 'after_pain_intake'
  | 'after_candidate_created'
  | 'after_ledger_consistent';

export interface SyntheticBaselineStage {
  name: SyntheticBaselineStageName;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface SyntheticBaselineSummary {
  status: 'passed' | 'failed' | 'degraded';
  workspaceMode: 'temp' | 'explicit_workspace';
  generatedAt: string;
  stages: SyntheticBaselineStage[];
  recommendedNextIssue?: string;
}

export interface SyntheticBaselineOptions {
  workspaceDir: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  failAfterStage?: SyntheticBaselineFailStage;
}

const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_JSON_LENGTH = 2000;

export function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  return reason.slice(0, MAX_REASON_LENGTH - 3) + '...';
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

export function makeDeterministicDiagnosticianOutput(painId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `synth-diag-${painId}`,
    summary: 'Synthetic baseline: deterministic diagnostician output',
    rootCause: 'Synthetic baseline: tool failure pattern detected',
    violatedPrinciples: [],
    evidence: [
      {
        sourceRef: `pain://${painId}`,
        note: 'Synthetic baseline pain signal evidence',
      },
    ],
    recommendations: [
      {
        kind: 'principle',
        description: 'Synthetic baseline: avoid repeating this tool failure pattern',
        abstractedPrinciple: 'Synthetic baseline principle: handle tool failures gracefully',
      },
    ],
    confidence: 0.95,
  };
}

export function computeOverallStatus(stages: SyntheticBaselineStage[]): 'passed' | 'failed' | 'degraded' {
  const hasFailed = stages.some(s => s.status === 'failed');
  const hasSkipped = stages.some(s => s.status === 'skipped');
  const hasPassed = stages.some(s => s.status === 'passed');
  if (hasFailed && !hasPassed) return 'failed';
  if (hasFailed || hasSkipped) return 'degraded';
  return 'passed';
}

export function recommendNextIssue(stages: SyntheticBaselineStage[]): string | undefined {
  const firstFailed = stages.find(s => s.status === 'failed');
  if (!firstFailed) return undefined;
  switch (firstFailed.name) {
    case 'pain_intake':
      return 'PRI-207: Pain intake pipeline broken — check PainSignalBridge and DiagnosticianRunner';
    case 'diagnostician_task_created':
      return 'PRI-207: Diagnostician task not created — check RuntimeStateManager task creation';
    case 'candidate_created':
      return 'PRI-207: Candidate not created — check DiagnosticianCommitter and artifact storage';
    case 'ledger_consistent':
      return 'PRI-209: Ledger consistency broken — check CandidateIntakeService and PrincipleTreeLedgerAdapter';
    case 'internalization_queue_ready':
      return 'PRI-209: Internalization queue not ready — check IntakeToInternalizationBridge and PI task creation';
    case 'canary_health':
      return 'PRI-208: Canary health check failed — check OperatorHealthReadModel and read model infrastructure';
    default:
      return undefined;
  }
}
