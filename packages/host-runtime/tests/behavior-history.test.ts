import { describe, expect, it } from 'vitest';
import { buildToolSemanticRegistry } from '@principles/core/runtime-v2/internalization/tool-semantic-registry';
import type { RuleHostContextRow } from '@principles/core/trajectory-types';
import { assembleBehaviorHistory } from '../src/behavior-history.js';

function makeRow(params: Record<string, unknown>): RuleHostContextRow {
  return {
    id: 1,
    toolName: 'Bash',
    outcome: 'success',
    paramsJson: JSON.stringify(params),
  };
}

const registryResult = buildToolSemanticRegistry([{ rawToolName: 'Bash', canonicalKind: 'execute' }]);
if (!registryResult.ok) throw new Error(registryResult.errors.join('; '));

describe('assembleBehaviorHistory', () => {
  it('preserves opaque shell commands instead of normalizing them as file paths', () => {
    const command = 'echo docs/../secrets.json';
    const history = assembleBehaviorHistory([makeRow({ command })], false, {
      projectDir: '/work/project',
      toolSemantics: registryResult.registry,
    });

    expect(history).toMatchObject({
      status: 'available',
      calls: [{ toolName: 'Bash', normalizedPath: command }],
    });
  });
});
