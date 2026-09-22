/**
 * Presentation-side grouping for the governance card's per-task lists (PRI-903).
 *
 * `governance.attention.items` and `governance.dataQuality.issues` are produced
 * one-entry-per-task by the core governance projection — the data layer is
 * correct, and its per-entry sourceRefs stay intact there. Rendering those
 * arrays 1:1 still floods the card with dozens of identical sentences when many
 * historical tasks share one reasonCode, drowning genuine single anomalies.
 * Grouping here is presentation-only.
 */

export interface HasReasonCode {
  reasonCode: string;
}

export interface ReasonGroup {
  reasonCode: string;
  /** How many entries share this reasonCode; integer ≥ 1 by construction. */
  count: number;
}

export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

const SAME_REASON_COUNT_KEY = 'principles.detail.governance.sameReasonCount';

/**
 * Localize one grouped list line (PRI-903 review round).
 *
 * `templatePrefix` is the i18n block holding the per-reasonCode sentence
 * (e.g. `principles.detail.governance.attention`). The count suffix is appended
 * only when the reason recurs; its `{{n}}` template receives the group count,
 * which is a locally derived integer — never raw unknown data.
 */
export function formatGroupedReasonLine(t: TranslateFn, templatePrefix: string, group: ReasonGroup): string {
  const sentence = t(`${templatePrefix}.${group.reasonCode}`, { defaultValue: group.reasonCode });
  return group.count > 1 ? sentence + t(SAME_REASON_COUNT_KEY, { n: group.count }) : sentence;
}

/**
 * Group items by reasonCode. Smaller groups sort first so singleton anomalies
 * (one failed task, one missing verdict) surface above large historical groups
 * of identical text. The sort is stable, so equal-count groups keep the order
 * in which their reason first appears in the projection input.
 */
export function groupByReasonCode(items: HasReasonCode[]): ReasonGroup[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.reasonCode, (counts.get(item.reasonCode) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const groups: ReasonGroup[] = [];
  for (const item of items) {
    if (seen.has(item.reasonCode)) continue;
    seen.add(item.reasonCode);
    const count = counts.get(item.reasonCode);
    if (count !== undefined) groups.push({ reasonCode: item.reasonCode, count });
  }
  return groups.sort((a, b) => a.count - b.count);
}
