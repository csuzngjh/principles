/**
 * Runtime validators and derivation logic for Pain Evidence page data.
 *
 * Derives behavior evidence from existing principles data — no new backend
 * route needed. Principles with `derivedFromPainIds` or `painPreventedCount > 0`
 * represent evidence that was captured and internalized.
 *
 * This follows H-section rules and ERR-001/005/009/010.
 */

// ── PainEvidence type (derived from existing principles data) ─────────────────

export interface PainEvidence {
  /** The principle ID that was derived from this pain evidence */
  id: string;
  /** Principle text — serves as the evidence title */
  title: string;
  /** The trigger pattern — describes the context where the deviation occurred */
  context: string;
  /** The action — describes what the agent should do instead */
  expectedBehavior: string;
  /** Source: always 'principle_derivation' since we derive from principles */
  source: 'principle_derivation';
  /** Maps principle status to recommendation state */
  recommendationState: 'pending' | 'candidate' | 'principle' | 'dismissed';
  /** Pain-related metadata from the principle */
  trajectorySummary: {
    principleId: string;
    painPreventedCount: number;
    lastPainPreventedAt: string;
    derivedFromPainIds: string[];
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

const VALID_PRINCIPLE_STATUSES: readonly string[] = ['candidate', 'active', 'archived', 'deprecated', 'probation'];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a principle status to a pain evidence recommendationState.
 * - candidate → pending (not yet reviewed)
 * - active → principle (internalized)
 * - probation → candidate (under review)
 * - archived/deprecated → dismissed
 */
function mapRecommendationState(status: string): PainEvidence['recommendationState'] {
  switch (status) {
    case 'candidate': return 'pending';
    case 'active': return 'principle';
    case 'probation': return 'candidate';
    case 'archived':
    case 'deprecated': return 'dismissed';
    default: return 'pending';
  }
}

/**
 * Derive a single PainEvidence from a principle list item + detail.
 * Returns null if the principle has no pain-related data.
 */
export function derivePainEvidenceFromPrinciple(
  listItem: unknown,
  detail?: unknown,
): PainEvidence | null {
  if (!isRecord(listItem)) return null;

  // Must have pain-related fields
  const { painPreventedCount, derivedFromPainIds, lastPainPreventedAt } =
    detail && isRecord(detail) ? detail : listItem;

  const painCount = isNumber(painPreventedCount) ? painPreventedCount : 0;
  const painIds = Array.isArray(derivedFromPainIds)
    ? derivedFromPainIds.filter(isString)
    : [];
  const lastPainAt = isString(lastPainPreventedAt) ? lastPainPreventedAt : '';

  // Only derive evidence if there's actual pain data
  if (painCount === 0 && painIds.length === 0 && !lastPainAt) {
    return null;
  }

  // Required fields from list item
  const { id, text, triggerPattern, action, status, createdAt } = listItem;

  if (!isString(id) || !isString(text)) return null;

  const principleStatus = isString(status) && VALID_PRINCIPLE_STATUSES.includes(status)
    ? status
    : 'candidate';

  return {
    id,
    title: isString(text) ? text : '',
    context: isString(triggerPattern) ? triggerPattern : '',
    expectedBehavior: isString(action) ? action : '',
    source: 'principle_derivation',
    recommendationState: mapRecommendationState(principleStatus),
    trajectorySummary: {
      principleId: id,
      painPreventedCount: painCount,
      lastPainPreventedAt: lastPainAt,
      derivedFromPainIds: painIds,
    },
    createdAt: isString(createdAt) ? createdAt : new Date().toISOString(),
  };
}

/**
 * Validate the principles list response and derive pain evidence.
 * Uses existing /api/principles data — no new backend route needed.
 */
export function derivePainEvidenceFromPrinciplesList(raw: unknown): PainEvidenceListData | PainEvidenceDegraded {
  if (!isRecord(raw)) {
    return {
      reason: 'Invalid response format from server',
      nextAction: 'Try refreshing the page. If the problem persists, check the Console API.',
    };
  }

  const { principles: rawPrinciples } = raw;
  if (!Array.isArray(rawPrinciples)) {
    return {
      reason: 'Response missing principles array',
      nextAction: 'Try refreshing the page.',
    };
  }

  // Derive evidence from each principle (ERR-005/007: validate array element types)
  const evidence: PainEvidence[] = [];
  for (const item of rawPrinciples) {
    const derived = derivePainEvidenceFromPrinciple(item);
    if (derived !== null) {
      evidence.push(derived);
    }
  }

  return {
    evidence,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Check if a parsed result is degraded (missing data).
 */
export function isDegraded(result: PainEvidenceListData | PainEvidenceDegraded): result is PainEvidenceDegraded {
  return !Object.hasOwn(result, 'evidence');
}

/**
 * Get error message from an unknown API error.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
