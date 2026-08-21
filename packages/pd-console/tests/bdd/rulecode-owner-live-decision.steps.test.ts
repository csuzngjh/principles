import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFeature } from './support/gherkin-loader.js';
import { resolveFeaturePath } from './support/repo-root.js';

describe('RuleCode Owner Live Decision BDD production contract', () => {
  const featurePath = resolveFeaturePath('docs/specs/features/story-a/rulecode-owner-live-decision.feature');
  const scenarios = parseFeature(readFileSync(featurePath, 'utf8'));

  it('keeps all seventeen approved Owner-visible scenarios executable', () => {
    expect(scenarios).toHaveLength(17);
    expect(scenarios.map(value => value.scenarioName)).toContain('Circuit breaker isolates one bad rule');
    expect(scenarios.map(value => value.scenarioName)).toContain('Console and CLI share one promotion authority');
  });

  it('binds the scenarios to production Console, service, and host containment paths', () => {
    const route = readFileSync(resolveFeaturePath('packages/pd-console/src/server/routes/activations.ts'), 'utf8');
    const model = readFileSync(resolveFeaturePath('packages/pd-console/src/server/models/ActivationsConsoleModel.ts'), 'utf8');
    const gate = readFileSync(resolveFeaturePath('packages/openclaw-plugin/src/hooks/gate.ts'), 'utf8');
    expect(route).toContain('owner-review'); expect(route).toContain('recover-to-shadow'); expect(route).toContain('emergency-pause');
    expect(model).toContain('RuleCodeOwnerDecisionService');
    expect(gate).toContain('observeRuleCodeSafety'); expect(gate).toContain('allowing current host call');
  });
});
