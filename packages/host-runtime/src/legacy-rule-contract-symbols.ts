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

function maskNonExecutableText(source: string): string {
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
 * Conservative scan of persisted RuleCode source for retired RuleHost
 * contract symbols (field reads and helper calls). A hit means the rule must
 * NOT execute against the current contract — its reads would silently
 * resolve to undefined and change owner-approved behavior.
 */
export function scanRetiredContractSymbols(implementationCode: string): string[] {
  const executableSource = maskNonExecutableText(implementationCode);
  const symbols: string[] = [];
  for (const { symbol, pattern } of RETIRED_SYMBOL_PATTERNS) {
    if (pattern.test(executableSource)) {
      symbols.push(symbol);
    }
  }
  return symbols;
}
