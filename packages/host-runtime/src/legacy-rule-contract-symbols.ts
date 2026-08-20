/**
 * Retired RuleHost contract symbol scan — host-runtime local copy.
 *
 * The shared canonical scanner lives in @principles/core
 * (internalization/legacy-rule-contract-scanner.ts) and is used by the
 * plugin, console, installer, and pd-cli. This module deliberately does NOT
 * import it: the published codex-adapter bundle installs host-runtime
 * against the CURRENTLY PUBLISHED @principles/core from the npm registry,
 * and a new runtime import would break clean installs until the next core
 * release (see tests/published-codex-adapter-bundle.test.ts — it enforces
 * exactly this constraint). Keep the symbol patterns in sync with the core
 * scanner; the host-runtime tests cover the same detection behavior.
 */

interface RetiredSymbolPattern {
  symbol: string;
  pattern: RegExp;
}

// Helper-call form is listed before the bare-word form; the field pattern's
// negative lookahead prevents one hasPlanFile( call reporting twice.
const RETIRED_SYMBOL_PATTERNS: readonly RetiredSymbolPattern[] = [
  { symbol: 'recentThinking', pattern: /\brecentThinking\b/ },
  { symbol: 'planStatus', pattern: /\bplanStatus\b/ },
  { symbol: 'getPlanStatus', pattern: /\bgetPlanStatus\s*\(/ },
  { symbol: 'hasPlanFileHelper', pattern: /\bhasPlanFile\s*\(/ },
  { symbol: 'hasPlanFile', pattern: /\bhasPlanFile\b(?!\s*\()/ },
];

/**
 * Conservative scan of persisted RuleCode source for retired RuleHost
 * contract symbols (field reads and helper calls). A hit means the rule must
 * NOT execute against the current contract — its reads would silently
 * resolve to undefined and change owner-approved behavior.
 */
export function scanRetiredContractSymbols(implementationCode: string): string[] {
  const symbols: string[] = [];
  for (const { symbol, pattern } of RETIRED_SYMBOL_PATTERNS) {
    if (pattern.test(implementationCode)) {
      symbols.push(symbol);
    }
  }
  return symbols;
}
