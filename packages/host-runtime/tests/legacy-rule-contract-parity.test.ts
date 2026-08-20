import { describe, it, expect } from 'vitest';
import { scanRetiredContractSymbols } from '../src/legacy-rule-contract-symbols.js';

/**
 * P2-7 parity guard (2026-08-20).
 *
 * host-runtime keeps a LOCAL copy of the retired-contract symbol scanner
 * (legacy-rule-contract-symbols.ts) instead of importing the canonical one
 * from @principles/core — the published codex-adapter bundle installs
 * host-runtime against the currently published core, so a new runtime import
 * would break clean installs until the next core release.
 *
 * This duplication is acceptable only if the two scanners never drift: a
 * symbol the core scanner retires but the host copy misses would make
 * different hosts reach different governance decisions. This test pins the
 * host copy to the exact retired-symbol contract the core scanner enforces
 * (same corpus as
 * packages/principles-core/src/runtime-v2/internalization/__tests__/legacy-rule-contract-scanner.test.ts).
 * No production cross-package import is introduced.
 */

/** The exact retired public RuleHost contract symbols in @principles/core. */
const CANONICAL_RETIRED_SYMBOL_SET: readonly string[] = [
  'recentThinking',
  'planStatus',
  'getPlanStatus',
  'hasPlanFile',
  'hasPlanFileHelper',
];

interface ParityCase {
  name: string;
  code: string;
  expected: string[];
}

const PARITY_CORPUS: ParityCase[] = [
  {
    name: 'recentThinking field read',
    code: `function evaluate(input, helpers) {
  if (input.session.recentThinking === true) { return { decision: 'requireApproval', matched: true }; }
  return { decision: 'allow', matched: false };
}`,
    expected: ['recentThinking'],
  },
  {
    name: 'workspace.planStatus and workspace.hasPlanFile field reads',
    code: `function evaluate(input) {
  if (input.workspace.planStatus !== 'READY' || input.workspace.hasPlanFile === false) {
    return { decision: 'block', matched: true };
  }
  return { decision: 'allow', matched: false };
}`,
    expected: ['hasPlanFile', 'planStatus'],
  },
  {
    name: 'helper calls getPlanStatus() and hasPlanFile()',
    code: `function evaluate(input, helpers) {
  if (helpers.getPlanStatus() === 'READY' && helpers.hasPlanFile()) {
    return { decision: 'allow', matched: false };
  }
  return { decision: 'block', matched: true };
}`,
    expected: ['getPlanStatus', 'hasPlanFileHelper'],
  },
  {
    name: 'clean RuleContextV2-only rule (current contract)',
    code: `function evaluate(input, helpers) {
  var h = input.context && input.context.history;
  if (h && h.status === 'available' && h.recentCalls.length > 0) {
    return { decision: 'requireApproval', matched: true };
  }
  return { decision: 'allow', matched: false, reason: 'cannot verify: history unavailable' };
}`,
    expected: [],
  },
  {
    name: 'conservative: a comment-only mention is still flagged',
    code: `function evaluate(input) {
  // legacy: used to check input.session.recentThinking before PRI retirement
  return { decision: 'allow', matched: false };
}`,
    expected: ['recentThinking'],
  },
  {
    name: 'does not match lookalike symbols (planStatusX, myRecentThinking)',
    code: `function evaluate(input) {
  var planStatusX = 1; var myRecentThinking = 2; var hasPlanFilePath = 3;
  return { decision: 'allow', matched: planStatusX + myRecentThinking + hasPlanFilePath > 0 ? false : true };
}`,
    expected: [],
  },
  {
    name: 'reports each distinct symbol once',
    code: 'if (input.session.recentThinking) {} if (input.session.recentThinking) {}',
    expected: ['recentThinking'],
  },
  {
    name: 'empty source has no findings',
    code: '',
    expected: [],
  },
];

describe('legacy-rule-contract-symbols parity with the canonical core scanner', () => {
  it.each(PARITY_CORPUS)('matches the core scanner on: $name', ({ code, expected }) => {
    const actual = scanRetiredContractSymbols(code);
    expect(new Set(actual)).toEqual(new Set(expected));
  });

  it('reports every canonical retired symbol by the exact core symbol name', () => {
    const all = [
      'input.session.recentThinking',
      'input.workspace.planStatus',
      'input.workspace.hasPlanFile',
      'helpers.getPlanStatus()',
      'helpers.hasPlanFile()',
    ].join('\n');
    const actual = new Set(scanRetiredContractSymbols(all));
    expect(actual.size).toBe(CANONICAL_RETIRED_SYMBOL_SET.length);
    for (const symbol of CANONICAL_RETIRED_SYMBOL_SET) {
      expect(actual.has(symbol), `host-runtime scanner is missing the core retired symbol: ${symbol}`).toBe(true);
    }
  });
});
