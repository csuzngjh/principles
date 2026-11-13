/**
 * One read for both daily surfaces (今天 entry + 审查卡).
 *
 * The queue is assembled from the two reads the console already owns:
 * owner decisions and grouped approvals. Nothing is cached and nothing is
 * written; a new visit reads again (DESIGN_BRIEF D1: one refresh, no polling).
 */
import {
  fetchApprovalsGrouped,
  fetchGovernanceExperience,
  fetchOwnerDecisions,
} from '../../api.js';
import { describeApiError } from '../../utils/technical-detail.js';
import { buildReviewItems, type ReviewItem } from './review-items.js';
import type { Translate } from './review-narrative.js';

export interface ReviewLoadResult {
  items: ReviewItem[];
  /** Owner-facing reason a source could not be read (rc-9: never silent). */
  unavailable: string[];
  /** Non-null when nothing at all could be read. */
  fatal: string | null;
  /** Non-null when decisions must stay disabled, with the reason to show. */
  lockedReason: string | null;
  generatedAt: Date;
}

function ownerMessage(raw: string): string {
  return describeApiError(raw).text;
}

export async function loadReviewData(options: {
  featureFlags?: Record<string, { enabled: boolean } | undefined>;
  t: Translate;
}): Promise<ReviewLoadResult> {
  const { featureFlags, t } = options;
  const experienceMode = featureFlags?.governance_experience_v1?.enabled === true;
  const flagsResolved = featureFlags !== undefined;

  const [decisionsResult, approvalsResult, experienceResult] = await Promise.all([
    fetchOwnerDecisions().catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'unknown_error',
    })),
    fetchApprovalsGrouped().catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : 'unknown_error',
    })),
    experienceMode
      ? fetchGovernanceExperience().catch((error: unknown) => ({
        success: false as const,
        error: error instanceof Error ? error.message : 'unknown_error',
      }))
      : Promise.resolve(null),
  ]);

  const unavailable: string[] = [];
  const decisions = decisionsResult.success ? decisionsResult.data.items : [];
  if (!decisionsResult.success) {
    unavailable.push(t('pages.today.sources.decisions', { reason: ownerMessage(decisionsResult.error) }));
  }
  if (!approvalsResult.success) {
    unavailable.push(t('pages.today.sources.approvals', { reason: ownerMessage(approvalsResult.error) }));
  }
  const items = buildReviewItems(decisions, approvalsResult.success ? approvalsResult.data : null);

  const fatal = !decisionsResult.success && !approvalsResult.success
    ? ownerMessage(decisionsResult.error)
    : null;

  let lockedReason: string | null = null;
  if (!flagsResolved) {
    lockedReason = t('pages.focus.workbench.permissionsUnknown');
  } else if (experienceMode) {
    if (experienceResult === null || !experienceResult.success) {
      lockedReason = t('pages.focus.workbench.permissionsUnknown');
    } else {
      const { readiness } = experienceResult.data;
      if (readiness.ownerIdentityConfiguration !== 'configured') {
        lockedReason = t('pages.review.lockedIdentity');
      }
    }
  }

  return { items, unavailable, fatal, lockedReason, generatedAt: new Date() };
}
