import { describe, expect, it } from 'vitest';
import {
  getSubagentRuntimeAvailability,
  isSubagentRuntimeAvailable,
} from '../../src/utils/subagent-probe.js';

describe('subagent-probe', () => {
  it('treats any callable run entrypoint as available', () => {
    const runtime = {
      run() {
        return Promise.resolve({ runId: 'run-1' });
      },
    };

    expect(getSubagentRuntimeAvailability(runtime)).toEqual({
      available: true,
      reason: 'callable',
    });
    expect(isSubagentRuntimeAvailable(runtime)).toBe(true);
  });

  it('reports missing runtime and missing run distinctly', () => {
    expect(getSubagentRuntimeAvailability(undefined)).toEqual({
      available: false,
      reason: 'missing_runtime',
    });
    expect(getSubagentRuntimeAvailability({})).toEqual({
      available: false,
      reason: 'missing_run',
    });
  });
});
