import { describe, expect, it } from 'vitest';
import { isPrincipleIdentityMapping, readAdaptiveActivationConfig } from '../../src/hooks/adaptive-activation-config.js';

const now = Date.parse('2026-11-05T00:00:00Z');
const workspaceDir = process.cwd();
const valid = () => ({ enabled: true, workspaceDir, artifactId: 'artifact', activationId: 'activation', expiresAt: '2026-11-05T01:00:00Z', softTimeoutMs: 1000 });
const principleValid = () => ({ enabled: true, workspaceDir, principleId: 'DELIVERY', expiresAt: '2026-11-05T01:00:00Z', softTimeoutMs: 1000 });

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

describe('PRI-1140 principle-identity mapping variant', () => {
  it('accepts a principleId mapping with the same workspace/expiry/timing contract', () => {
    const mapping = readAdaptiveActivationConfig({ adaptiveActivation: principleValid() }, workspaceDir, now);
    expect(mapping).toEqual({ principleId: 'DELIVERY', softTimeoutMs: 1000, expiresAtMs: Date.parse('2026-11-05T01:00:00Z') });
    expect(isPrincipleIdentityMapping(mapping!)).toBe(true);
    expect(isPrincipleIdentityMapping(readAdaptiveActivationConfig({ adaptiveActivation: valid() }, workspaceDir, now)!)).toBe(false);
  });

  it('rejects an ambiguous identity (principleId together with a pinned pair) instead of guessing', () => {
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...valid(), principleId: 'DELIVERY' } }, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...principleValid(), artifactId: 'artifact' } }, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...principleValid(), activationId: 'activation' } }, workspaceDir, now)).toBeNull();
  });

  it('rejects a partial identity and enforces the shared timing/workspace rules on the principle variant', () => {
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...principleValid(), principleId: '   ' } }, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...valid(), artifactId: '' } }, workspaceDir, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: principleValid() }, `${workspaceDir}/other`, now)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: principleValid() }, workspaceDir, now + 3600000)).toBeNull();
    expect(readAdaptiveActivationConfig({ adaptiveActivation: { ...principleValid(), softTimeoutMs: 0 } }, workspaceDir, now)).toBeNull();
  });
});
