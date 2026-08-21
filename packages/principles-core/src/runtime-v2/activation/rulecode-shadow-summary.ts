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

export function summarizeRuleCodeShadowEvents(entries: readonly unknown[], activationId: string): RuleCodeShadowSummary {
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
    if (entry.type === 'rulehost_unhealthy') {
      errors += 1;
      continue;
    }
    if (entry.type !== 'rulehost_evaluated' || entry.data.activationMode !== 'shadow') continue;
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
