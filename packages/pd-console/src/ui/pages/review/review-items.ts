/**
 * The daily review queue — ONE ordered list built from the two existing
 * read surfaces the console already had:
 *
 * - owner decisions  (`/api/governance/owner-decisions`)
 * - pending approvals (`/api/approvals/grouped`)
 *
 * This module is presentation-only. It does not create a second source of
 * truth: the queue is derived on every visit from those responses, and the
 * server stays authoritative about what is still pending.
 *
 * REVIEW_SESSION_SPEC §2.2: today's items come first (oldest first), then the
 * items left over from earlier days (oldest first). Nothing is persisted here.
 */
import type {
  ApprovalsGroupedData,
  ApprovalGroupData,
  ApprovalGroupRecordData,
  OwnerDecisionItemData,
} from '../../utils/validators.js';

export type ReviewItemKind = 'decision' | 'approval';

export interface ReviewApprovalItem {
  group: ApprovalGroupData;
  record: ApprovalGroupRecordData;
}

export interface ReviewItem {
  /** Route key: `d:<reviewKey>` or `a:<approvalId>`. */
  id: string;
  kind: ReviewItemKind;
  title: string;
  createdAt: string;
  decision?: OwnerDecisionItemData;
  approval?: ReviewApprovalItem;
}

export function decisionRouteId(reviewKey: string): string {
  return `d:${reviewKey}`;
}

export function approvalRouteId(approvalId: string): string {
  return `a:${approvalId}`;
}

function byCreatedAt(a: ReviewItem, b: ReviewItem): number {
  const left = new Date(a.createdAt).getTime();
  const right = new Date(b.createdAt).getTime();
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return left - right;
}

/**
 * Build the queue. Approvals whose principle is already represented by a
 * decision card are skipped: the same fact must not be judged twice in one
 * session (SPEC-PD-UIUX-001 R2).
 */
export function buildReviewItems(
  decisions: readonly OwnerDecisionItemData[],
  approvals: ApprovalsGroupedData | null,
): ReviewItem[] {
  const items: ReviewItem[] = [];
  const groups = (approvals?.groups ?? []).filter((group) => group.status === 'pending');
  const approvalPrinciples = new Set(groups.map((group) => group.principleId));

  for (const decision of decisions) {
    // Deployment approvals are judged through the approval group, which carries
    // the candidate wording this card needs. The decision projection is a thin
    // duplicate of the same fact (single truth, one card).
    if (decision.kind === 'activation_approval') continue;
    // RuleCode shadow promotion has its own promote/reject-after-shadow
    // contract on the workbench; it is not a two-button daily decision.
    if (decision.kind === 'rulecode_decision') continue;
    if (decision.principleId !== undefined && approvalPrinciples.has(decision.principleId)) continue;
    items.push({
      id: decisionRouteId(decision.reviewKey),
      kind: 'decision',
      title: decision.title,
      createdAt: decision.createdAt,
      decision,
    });
  }
  for (const group of groups) {
    for (const record of group.records) {
      if (record.status !== 'pending') continue;
      items.push({
        id: approvalRouteId(record.id),
        kind: 'approval',
        title: group.candidateDescription ?? group.principleTitle,
        createdAt: record.createdAt,
        approval: { group, record },
      });
    }
  }
  return items.sort(byCreatedAt);
}

/** Local midnight for "today", used to split today's items from leftovers. */
export function startOfLocalDay(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function isToday(iso: string, now: Date = new Date()): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() >= startOfLocalDay(now).getTime();
}

export interface ReviewQueue {
  today: ReviewItem[];
  leftover: ReviewItem[];
  /** Today first, then leftovers — the order the session walks in. */
  ordered: ReviewItem[];
}

export function splitReviewQueue(items: readonly ReviewItem[], now: Date = new Date()): ReviewQueue {
  const today = items.filter((item) => isToday(item.createdAt, now));
  const leftover = items.filter((item) => !isToday(item.createdAt, now));
  return { today, leftover, ordered: [...today, ...leftover] };
}

export function findReviewItem(items: readonly ReviewItem[], id: string): ReviewItem | undefined {
  return items.find((item) => item.id === id);
}

/** Whole days an item has been waiting; 0 when the timestamp is unreadable. */
export function daysWaiting(iso: string, now: Date = new Date()): number {
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return 0;
  const diff = startOfLocalDay(now).getTime() - startOfLocalDay(created).getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
}
