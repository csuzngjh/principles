/**
 * Legacy RuleHost contract dependency scanner (2026-08-19).
 *
 * When a public RuleHost contract symbol is retired (e.g.
 * `RuleHostInput.session.recentThinking`, `workspace.planStatus`,
 * `workspace.hasPlanFile`, the `getPlanStatus()`/`hasPlanFile()` helpers),
 * source-level deletion is not enough: persisted, owner-approved RuleCode in
 * existing workspaces may still reference the symbol. Executing such a rule
 * against the new contract silently changes its semantics (`undefined`
 * instead of a value) — the most dangerous failure mode because nothing
 * throws and the owner-approved behavior drifts quietly.
 *
 * This scanner is the shared detection point for:
 *   - runtime load backstops (plugin RuleHost + host-runtime gate) — a rule
 *     with a retired-contract dependency is NOT executed;
 *   - upgrade preflights (installer, console update) — refuse to replace the
 *     runtime while an active rule depends on a removed contract.
 *
 * Matching is deliberately conservative: a symbol mentioned anywhere in the
 * implementation source (including comments) is reported. A false positive
 * costs one migration/deactivation; a false negative silently changes the
 * behavior of an owner-approved rule.
 */

/** Retired public RuleHost contract symbols and how they appear in RuleCode. */
export type LegacyRuleContractSymbol =
  | 'recentThinking'
  | 'planStatus'
  | 'hasPlanFile'
  | 'getPlanStatus'
  | 'hasPlanFileHelper';

/** A rule implementation to scan, with its lineage for owner-facing output. */
export interface LegacyRuleContractRuleSource {
  activationId?: string;
  artifactId: string;
  ruleId?: string;
  principleId?: string;
  /** Raw RuleCode source as persisted in the artifact. */
  implementationCode: string;
}

/** One retired-symbol usage found in one active rule. */
export interface LegacyRuleContractFinding {
  activationId?: string;
  artifactId: string;
  ruleId?: string;
  principleId?: string;
  symbol: LegacyRuleContractSymbol;
  channel: 'code_tool_hook';
}

interface SymbolPattern {
  symbol: LegacyRuleContractSymbol;
  pattern: RegExp;
}

// Field-form vs helper-form are distinguished so remediation guidance can
// name the exact contract element. A call site (`hasPlanFile(`) is reported
// once as the helper form — the field pattern excludes call sites with a
// negative lookahead so one occurrence never yields two findings.
const SYMBOL_PATTERNS: readonly SymbolPattern[] = [
  { symbol: 'recentThinking', pattern: /\brecentThinking\b/ },
  { symbol: 'planStatus', pattern: /\bplanStatus\b/ },
  { symbol: 'getPlanStatus', pattern: /\bgetPlanStatus\s*\(/ },
  { symbol: 'hasPlanFileHelper', pattern: /\bhasPlanFile\s*\(/ },
  { symbol: 'hasPlanFile', pattern: /\bhasPlanFile\b(?!\s*\()/ },
];

/**
 * Scan persisted RuleCode sources for retired RuleHost contract symbols.
 * Pure function — no I/O; callers own loading the code from persistence.
 */
export function scanLegacyRuleContractDependencies(
  rules: readonly LegacyRuleContractRuleSource[],
): LegacyRuleContractFinding[] {
  const findings: LegacyRuleContractFinding[] = [];
  for (const rule of rules) {
    if (typeof rule.implementationCode !== 'string' || rule.implementationCode.length === 0) {
      continue;
    }
    const seen = new Set<LegacyRuleContractSymbol>();
    for (const { symbol, pattern } of SYMBOL_PATTERNS) {
      if (seen.has(symbol)) continue;
      if (pattern.test(rule.implementationCode)) {
        seen.add(symbol);
        findings.push({
          ...(rule.activationId !== undefined ? { activationId: rule.activationId } : {}),
          artifactId: rule.artifactId,
          ...(rule.ruleId !== undefined ? { ruleId: rule.ruleId } : {}),
          ...(rule.principleId !== undefined ? { principleId: rule.principleId } : {}),
          symbol,
          channel: 'code_tool_hook',
        });
      }
    }
  }
  return findings;
}

/** Human-readable remediation text shared by all consumers of the scanner. */
export function formatLegacyRuleContractRemediation(findings: readonly LegacyRuleContractFinding[]): string {
  const byRule = new Map<string, LegacyRuleContractFinding[]>();
  for (const f of findings) {
    const key = f.ruleId ?? f.artifactId;
    const list = byRule.get(key) ?? [];
    list.push(f);
    byRule.set(key, list);
  }
  const lines = [...byRule.entries()].map(([rule, fs]) =>
    `  - ${rule}${fs[0]?.activationId ? ` (activation ${fs[0].activationId})` : ''}: ${fs.map(f => f.symbol).join(', ')}`);
  return [
    'One or more active owner-approved rules depend on a RuleHost contract symbol removed by this version.',
    'Affected rules:',
    ...lines,
    'Next: migrate or deactivate the listed rules before upgrading. The old installation is untouched.',
  ].join('\n');
}
