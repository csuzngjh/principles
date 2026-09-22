/**
 * Presentation-side grouping for the governance card's per-task lists (PRI-903).
 *
 * `governance.attention.items` and `governance.dataQuality.issues` are produced
 * one-entry-per-task by the core governance projection, and the per-entry
 * sourceRefs are real lineage — the data layer is correct. Rendering those
 * arrays 1:1 still floods the card with dozens of identical sentences when many
 * historical tasks share one reasonCode, drowning genuine single anomalies.
 * Grouping here is presentation-only: the projection contract and every
 * sourceRef stay intact.
 */

export interface HasReasonCode {
  reasonCode: string;
}

export interface ReasonGroup<T extends HasReasonCode> {
  reasonCode: string;
  /** How many entries share this reasonCode; integer ≥ 1 by construction. */
  count: number;
  /** Original entries in projection order — sourceRefs stay available to callers. */
  items: T[];
}

/**
 * Group items by reasonCode. Smaller groups sort first so singleton anomalies
 * (one failed task, one missing verdict) surface above large historical groups
 * of identical text; ties break by reasonCode for deterministic rendering.
 */
export function groupByReasonCode<T extends HasReasonCode>(items: T[]): ReasonGroup<T>[] {
  const groups = new Map<string, ReasonGroup<T>>();
  for (const item of items) {
    const existing = groups.get(item.reasonCode);
    if (existing === undefined) {
      groups.set(item.reasonCode, { reasonCode: item.reasonCode, count: 1, items: [item] });
    } else {
      existing.count += 1;
      existing.items.push(item);
    }
  }
  return [...groups.values()].sort((a, b) => a.count - b.count || a.reasonCode.localeCompare(b.reasonCode));
}
