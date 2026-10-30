export interface RuleCodeShadowSummary {
  observed: number;
  matched: number;
  wouldBlock: number;
  wouldAllow: number;
  requireApproval: number;
  autoCorrect: number;
  errors: number;
  neutralControl: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/**
 * Aggregate the shadow evidence for one activation.
 *
 * SPEC-RULECODE-HOST-PROMOTION-001 B3: promotion shadow thresholds are
 * PER-HOST. When `targetHostKind` is supplied, only events whose
 * `data.hostKind` equals it are counted — a sample produced by another host
 * (e.g. OpenClaw rows in a workspace later governed by Codex) can never
 * satisfy this host's threshold, and rows persisted before the attribution
 * field existed count toward NO host (unattributed ≠ this host). Callers
 * that pass no target keep the historical unfiltered aggregate (exact
 * pre-SPEC behavior for surfaces that have not resolved a promotion host).
 */
export function summarizeRuleCodeShadowEvents(
  entries: readonly unknown[],
  activationId: string,
  targetHostKind?: string,
): RuleCodeShadowSummary {
  let observed = 0;
  let matched = 0;
  let wouldBlock = 0;
  let wouldAllow = 0;
  let requireApproval = 0;
  let autoCorrect = 0;
  let errors = 0;
  let neutralControl = 0;
  let firstObservedAt: string | null = null;
  let lastObservedAt: string | null = null;
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.data) || entry.data.activationId !== activationId) continue;
    // Review R3: host attribution gates EVERY event class that feeds this
    // summary — including `rulehost_unhealthy`. The unhealthy branch used to
    // run before the host filter, so a foreign host's anomaly inflated the
    // target host's error count (errors > 0 fails runtime_shadow_evidence)
    // and an unattributed legacy anomaly poisoned every host's threshold.
    // The target host's OWN anomalies still count (never silenced wholesale);
    // the no-target aggregate keeps its historical semantics.
    if (targetHostKind !== undefined && entry.data.hostKind !== targetHostKind) continue;
    if (entry.type === 'rulehost_unhealthy') {
      errors += 1;
      continue;
    }
    if (entry.type !== 'rulehost_evaluated' || entry.data.activationMode !== 'shadow') continue;
    if (targetHostKind !== undefined && entry.data.hostKind !== targetHostKind) continue;
    observed += 1;
    if (entry.data.matched === true) matched += 1;
    if (entry.data.decision === 'block') wouldBlock += 1;
    if (entry.data.decision === 'allow') wouldAllow += 1;
    if (entry.data.decision === 'requireApproval') requireApproval += 1;
    if (entry.data.decision === 'auto_correct') autoCorrect += 1;
    if (entry.data.matched === false && entry.data.decision === 'allow') neutralControl += 1;
    if (entry.category === 'failure') errors += 1;
    if (typeof entry.ts === 'string' && Number.isFinite(Date.parse(entry.ts))) {
      if (firstObservedAt === null || Date.parse(entry.ts) < Date.parse(firstObservedAt)) firstObservedAt = entry.ts;
      if (lastObservedAt === null || Date.parse(entry.ts) > Date.parse(lastObservedAt)) lastObservedAt = entry.ts;
    }
  }
  return {
    observed,
    matched,
    wouldBlock,
    wouldAllow,
    requireApproval,
    autoCorrect,
    errors,
    neutralControl,
    firstObservedAt,
    lastObservedAt,
  };
}
