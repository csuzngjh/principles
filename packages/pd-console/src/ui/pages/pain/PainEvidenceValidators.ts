/**
 * Runtime validators for Pain Evidence page data.
 *
 * All data from the backend is treated as `unknown` and validated at the boundary.
 * This follows H-section rules and ERR-001/005/009/010.
 */

// ── PainEvidence type (matches G.2 data contract) ────────────────────────────

export interface PainEvidence {
  id: string;
  title: string;
  context: string;
  agentBehavior: string;
  expectedBehavior: string;
  source: 'tool_call' | 'prompt';
  recommendationState: 'pending' | 'candidate' | 'principle' | 'dismissed';
  trajectorySummary: {
    taskId: string;
    toolName: string;
    timestamp: string;
  };
  createdAt: string;
}

export interface PainEvidenceListData {
  evidence: PainEvidence[];
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely zero */
  note?: string;
}

export interface PainEvidenceDegraded {
  reason: string;
  nextAction: string;
}

// ── Validators ────────────────────────────────────────────────────────────────

const VALID_SOURCES: readonly string[] = ['tool_call', 'prompt'];
const VALID_RECOMMENDATION_STATES: readonly string[] = ['pending', 'candidate', 'principle', 'dismissed'];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a single trajectory summary object.
 * Returns null if required fields are missing or malformed.
 */
export function parseTrajectorySummary(raw: unknown): PainEvidence['trajectorySummary'] | null {
  if (!isRecord(raw)) return null;

  const { taskId, toolName, timestamp } = raw;

  if (!isString(taskId) || !isString(toolName) || !isString(timestamp)) {
    return null;
  }

  return { taskId, toolName, timestamp };
}

/**
 * Validate a single PainEvidence record from backend data.
 * Returns null if required fields are missing or malformed (ERR-009/010).
 */
export function parsePainEvidence(raw: unknown): PainEvidence | null {
  if (!isRecord(raw)) return null;

  // Required string fields
  const { id, title, context, agentBehavior, createdAt } = raw;

  if (!isString(id) || !isString(title) || !isString(context) || !isString(agentBehavior) || !isString(createdAt)) {
    return null;
  }

  // Optional string fields
  const { expectedBehavior: rawExpectedBehavior } = raw;
  const expectedBehavior = isString(rawExpectedBehavior) ? rawExpectedBehavior : '';

  // Enum fields
  const { source, recommendationState } = raw;
  if (!isString(source) || !VALID_SOURCES.includes(source)) {
    return null;
  }

  if (!isString(recommendationState) || !VALID_RECOMMENDATION_STATES.includes(recommendationState)) {
    return null;
  }

  // Nested object
  const trajectorySummary = parseTrajectorySummary(raw.trajectorySummary);
  if (!trajectorySummary) {
    return null;
  }

  return {
    id,
    title,
    context,
    agentBehavior,
    expectedBehavior,
    source: source as 'tool_call' | 'prompt',
    recommendationState: recommendationState as 'pending' | 'candidate' | 'principle' | 'dismissed',
    trajectorySummary,
    createdAt,
  };
}

/**
 * Validate the full PainEvidenceListData response.
 * Returns a degraded result with reason if the envelope is malformed (ERR-002).
 */
export function parsePainEvidenceListResponse(raw: unknown): PainEvidenceListData | PainEvidenceDegraded {
  if (!isRecord(raw)) {
    return {
      reason: 'Invalid response format from server',
      nextAction: 'Try refreshing the page. If the problem persists, check the Console API.',
    };
  }

  const { generatedAt, evidence: rawEvidence, note: rawNote } = raw;
  if (!isString(generatedAt)) {
    return {
      reason: 'Response missing generatedAt timestamp',
      nextAction: 'Try refreshing the page.',
    };
  }

  if (!Array.isArray(rawEvidence)) {
    // Missing evidence array could mean the endpoint doesn't exist yet
    const note = isString(rawNote) ? rawNote : undefined;
    return {
      evidence: [],
      generatedAt,
      ...(note ? { note } : {}),
    };
  }

  // Validate each element (ERR-005/007: validate array element types)
  const evidence: PainEvidence[] = [];
  for (const item of rawEvidence) {
    const parsed = parsePainEvidence(item);
    if (parsed !== null) {
      evidence.push(parsed);
    }
  }

  const note = isString(rawNote) ? rawNote : undefined;

  return {
    evidence,
    generatedAt,
    ...(note ? { note } : {}),
  };
}

/**
 * Check if a parsed result is degraded (missing data).
 */
export function isDegraded(result: PainEvidenceListData | PainEvidenceDegraded): result is PainEvidenceDegraded {
  return !('evidence' in result);
}

/**
 * Get error message from an unknown API error.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
