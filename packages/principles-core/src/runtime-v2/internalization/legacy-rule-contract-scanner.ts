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
 * Matching examines executable source only. Comments and string literals are
 * masked before symbol matching so explanatory text cannot disable a host.
 * A true executable reference is still rejected because reading a retired
 * field would silently change owner-approved behavior.
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
 * Mask comments and string-literal CONTENTS (preserving newlines; template
 * `${...}` interpolation stays executable) so downstream static symbol scans
 * only see executable source.
 *
 * Shared by the retired-contract scanner here and by `checkForbiddenPatterns`
 * (rule-code-validator, PRI-668): a string literal can only become
 * executable via eval/Function/bracket access — each of which carries its own
 * forbidden pattern — so masking literals creates no sandbox escape.
 */
export function maskNonExecutableText(source: string): string {
  type State = 'code' | 'line_comment' | 'block_comment' | 'single_quote' | 'double_quote' | 'template';
  let state: State = 'code';
  let templateExpressionDepth = 0;
  let masked = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (state === 'code') {
      if (templateExpressionDepth > 0 && char === '{') {
        templateExpressionDepth += 1;
        masked += char;
      } else if (templateExpressionDepth > 0 && char === '}') {
        templateExpressionDepth -= 1;
        masked += char;
        if (templateExpressionDepth === 0) state = 'template';
      } else if (char === '/' && next === '/') {
        masked += '  ';
        index += 1;
        state = 'line_comment';
      } else if (char === '/' && next === '*') {
        masked += '  ';
        index += 1;
        state = 'block_comment';
      } else if (char === "'") {
        masked += ' ';
        state = 'single_quote';
      } else if (char === '"') {
        masked += ' ';
        state = 'double_quote';
      } else if (char === '`') {
        masked += ' ';
        state = 'template';
      } else {
        masked += char;
      }
      continue;
    }

    if (state === 'line_comment') {
      masked += char === '\n' || char === '\r' ? char : ' ';
      if (char === '\n' || char === '\r') state = 'code';
      continue;
    }

    if (state === 'block_comment') {
      if (char === '*' && next === '/') {
        masked += '  ';
        index += 1;
        state = 'code';
      } else {
        masked += char === '\n' || char === '\r' ? char : ' ';
      }
      continue;
    }

    if (state === 'template' && char === '$' && next === '{') {
      masked += ' {';
      index += 1;
      templateExpressionDepth = 1;
      state = 'code';
      continue;
    }

    if (char === '\\') {
      masked += ' ';
      if (index + 1 < source.length) {
        masked += source[index + 1] === '\n' || source[index + 1] === '\r' ? source[index + 1] : ' ';
        index += 1;
      }
      continue;
    }

    const closesLiteral =
      (state === 'single_quote' && char === "'") ||
      (state === 'double_quote' && char === '"') ||
      (state === 'template' && char === '`');
    masked += char === '\n' || char === '\r' ? char : ' ';
    if (closesLiteral) state = 'code';
  }

  return masked;
}

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
    const executableSource = maskNonExecutableText(rule.implementationCode);
    const seen = new Set<LegacyRuleContractSymbol>();
    for (const { symbol, pattern } of SYMBOL_PATTERNS) {
      if (seen.has(symbol)) continue;
      if (pattern.test(executableSource)) {
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
