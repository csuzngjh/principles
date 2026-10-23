import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProductionGateDeps, validateRuleContextV2, buildGoldenTraceFromArtificer } from '@principles/core/runtime-v2';

import { CODEX_TOOL_SEMANTICS } from '../../codex-adapter/src/tool-semantics.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fixtureCase(value: unknown): value is { caseId: string; ruleContext: unknown } {
  return record(value) && typeof value.caseId === 'string' && Object.hasOwn(value, 'ruleContext');
}
const parsed: unknown = JSON.parse(readFileSync(new URL('./fixtures/pri1019-generated-design-gate.json', import.meta.url), 'utf8'));
if (!record(parsed) || typeof parsed.implementationCode !== 'string' || !Array.isArray(parsed.cases)
  || !parsed.cases.every(fixtureCase)) throw new Error('Malformed generated regression fixture.');
const code = parsed.implementationCode;
const cases = parsed.cases.filter((entry) => validateRuleContextV2(entry.ruleContext).valid);
const rejected = parsed.cases.filter((entry) => !validateRuleContextV2(entry.ruleContext).valid);
const built = buildGoldenTraceFromArtificer({ cases });
if (!built.ok) throw new Error('Sanitized generated-rule regression fixture must retain valid positive/negative cases.');
const gate = createProductionGateDeps({ toolSemantics: CODEX_TOOL_SEMANTICS });

describe('PRI-1019 real generated rule contract regression', () => {
  it('preserves scope, approval, exemption and parameter-forgery decisions across sanitized counterfactuals', () => {
    expect(cases).toHaveLength(18);
    expect(gate.evaluateInSandbox(code, built.trace).success).toBe(true);
  });
  it('rejects inconsistent bindings and malformed host facts before they reach generated code', () => {
    expect(rejected).toHaveLength(7);
    expect(rejected.map((entry) => entry.caseId)).toContain('extra-denial-other-scope');
  });
  it('cannot pass with either an always-allow or an always-block substitute', () => {
    for (const decision of ['allow', 'block']) {
      const code = `function evaluate() { return { decision: '${decision}', matched: ${decision === 'block'}, reason: 'negative control' }; }`;
      expect(gate.evaluateInSandbox(code, built.trace).success).toBe(false);
    }
  });
});
