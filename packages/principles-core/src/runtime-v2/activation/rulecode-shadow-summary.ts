export interface RuleCodeShadowSummary { observed: number; wouldBlock: number; errors: number }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function summarizeRuleCodeShadowEvents(entries: readonly unknown[], activationId: string): RuleCodeShadowSummary {
  let observed = 0; let wouldBlock = 0; let errors = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'rulehost_evaluated' || !isRecord(entry.data)) continue;
    if (entry.data.activationId !== activationId || entry.data.activationMode !== 'shadow') continue;
    observed += 1; if (entry.data.decision === 'block') wouldBlock += 1;
    if (entry.category === 'failure') errors += 1;
  }
  return { observed, wouldBlock, errors };
}
