import { describe, expect, it } from 'vitest';
import { readAdaptiveActivationConfig } from '../../src/hooks/adaptive-activation-config.js';

const now = Date.parse('2026-11-05T00:00:00Z');
const workspaceDir = process.cwd();
const valid = () => ({ enabled: true, workspaceDir, artifactId: 'artifact', activationId: 'activation', expiresAt: '2026-11-05T01:00:00Z', softTimeoutMs: 1000 });

describe('explicit bounded adaptive mapping', () => {
  it('accepts only an enabled mapping in its workspace and observation window', () => {
    expect(readAdaptiveActivationConfig({ adaptiveActivation: valid() }, workspaceDir, now)).toMatchObject({ artifactId: 'artifact', activationId: 'activation' });
    expect(readAdaptiveActivationConfig({}, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...valid(), enabled: false } }, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: valid() }, `${workspaceDir}/other`, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: valid() }, workspaceDir, now + 3600000)).toBeNull();
  });

  it.each([0, -1, 15001, 1.5, NaN, '1000'])('rejects an unbounded or invalid timeout %s', softTimeoutMs => {
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...valid(), softTimeoutMs } }, workspaceDir, now)).toBeNull();
  });

  it('does not invoke configuration getters or inherit a mapping', () => {
    const config = { get adaptiveActivation() { throw new Error('must not execute'); } };
    expect(readAdaptiveActivationConfig(config, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig(Object.create({ adaptiveActivation: valid() }), workspaceDir, now)).toBeNull();
  });
});
