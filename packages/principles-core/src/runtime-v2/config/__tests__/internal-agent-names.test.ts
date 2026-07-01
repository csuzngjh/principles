import { describe, it, expect } from 'vitest';
import { INTERNAL_AGENT_NAMES } from '../pd-config-types.js';

describe('INTERNAL_AGENT_NAMES', () => {
  it('includes signalCollector', () => {
    expect(INTERNAL_AGENT_NAMES).toContain('signalCollector');
  });

  it('still includes all pre-existing names (no regression)', () => {
    // 确保没误删现有的
    expect(INTERNAL_AGENT_NAMES).toContain('diagnostician');
    expect(INTERNAL_AGENT_NAMES).toContain('dreamer');
    expect(INTERNAL_AGENT_NAMES).toContain('correctionObserver');
    expect(INTERNAL_AGENT_NAMES).toContain('empathyObserver');
  });
});
