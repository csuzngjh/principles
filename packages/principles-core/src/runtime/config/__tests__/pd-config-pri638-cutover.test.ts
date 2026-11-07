/**
 * PRI-638 P1-B — legacy `diagnostician_split_pipeline=false` cutover.
 *
 * Pre-canonical workspaces may carry an explicit `diagnostician_split_pipeline:
 * enabled: false` whose historical meaning was "Diagnostician disabled".
 * Ignoring it after PRI-638 would silently activate a previously-disabled
 * 3-stage LLM pipeline (destructive semantic cutover). The effective config
 * layer folds that intent into the canonical binding and emits a
 * provenance-aware warning; the runtime keeps reading exactly one authority
 * (internalAgents.agents.diagnostician.enabled).
 *
 * Policy: conservative — silent false-negative is safer than silent activation.
 */
import { describe, expect, it } from 'vitest';
import { computeEffectivePdConfig, getDefaultPdConfig } from '../index.js';
import type { PdConfig } from '../pd-config-types.js';

function baseConfig(): PdConfig {
  return getDefaultPdConfig();
}

function withSplitDisabled(source: 'owner' | 'system' | undefined): PdConfig {
  const c = baseConfig();
  c.features = {
    ...c.features,
    diagnostician_split_pipeline: {
      category: 'quiet',
      enabled: false,
      ...(source ? { source } : {}),
    },
  };
  // The installer default binding stays enabled:true — exactly the legacy
  // workspace shape (installer-generated binding + Owner/system split=false).
  c.internalAgents = {
    ...c.internalAgents,
    agents: {
      ...c.internalAgents.agents,
      diagnostician: { enabled: true, runtimeProfile: c.internalAgents.defaultRuntime },
    },
  };
  return c;
}

describe('PRI-638 P1-B — legacy split=false cutover', () => {
  it('B1: split=false (source=owner) folds to agent disabled with an owner-pinned warning', () => {
    const effective = computeEffectivePdConfig(withSplitDisabled('owner'));

    expect(effective.config.internalAgents.agents.diagnostician.enabled).toBe(false);
    const warning = effective.warnings.find((w) => w.includes('PRI-638 cutover'));
    expect(warning).toBeDefined();
    expect(warning).toContain('source: owner');
    expect(warning).toContain('internalAgents.agents.diagnostician.enabled');
  });

  it('B2: split=false (source=system) folds to disabled — never silently activates LLM', () => {
    const effective = computeEffectivePdConfig(withSplitDisabled('system'));

    expect(effective.config.internalAgents.agents.diagnostician.enabled).toBe(false);
    const warning = effective.warnings.find((w) => w.includes('PRI-638 cutover'));
    expect(warning).toBeDefined();
    expect(warning).toContain('source: system');
  });

  it('B3: split=false (source missing = LEGACY_UNKNOWN) folds to disabled with unknown provenance warning', () => {
    const effective = computeEffectivePdConfig(withSplitDisabled(undefined));

    expect(effective.config.internalAgents.agents.diagnostician.enabled).toBe(false);
    const warning = effective.warnings.find((w) => w.includes('PRI-638 cutover'));
    expect(warning).toBeDefined();
    expect(warning).toContain('source: unknown');
  });

  it('B4: split flag absent or enabled:true → no cutover, agent binding untouched', () => {
    const plain = computeEffectivePdConfig(baseConfig());
    expect(plain.config.internalAgents.agents.diagnostician.enabled).toBe(true);
    expect(plain.warnings.some((w) => w.includes('PRI-638 cutover'))).toBe(false);

    const withSplitOn = baseConfig();
    withSplitOn.features = {
      ...withSplitOn.features,
      diagnostician_split_pipeline: { category: 'quiet', enabled: true },
    };
    const on = computeEffectivePdConfig(withSplitOn);
    expect(on.config.internalAgents.agents.diagnostician.enabled).toBe(true);
    expect(on.warnings.some((w) => w.includes('PRI-638 cutover'))).toBe(false);
  });

  it('B5: agent binding already disabled → no duplicate cutover warning', () => {
    const c = withSplitDisabled('owner');
    c.internalAgents = {
      ...c.internalAgents,
      agents: {
        ...c.internalAgents.agents,
        diagnostician: { enabled: false, runtimeProfile: c.internalAgents.defaultRuntime },
      },
    };
    const effective = computeEffectivePdConfig(c);

    expect(effective.config.internalAgents.agents.diagnostician.enabled).toBe(false);
    expect(effective.warnings.some((w) => w.includes('PRI-638 cutover'))).toBe(false);
  });

  it('B6: runtime authority stays single — resolver reports unavailable after cutover', async () => {
    const { resolveDiagnosticianCapability } = await import('../../diagnostician-capability.js');
    const effective = computeEffectivePdConfig(withSplitDisabled('owner'));

    const capability = resolveDiagnosticianCapability(effective);
    expect(capability.available).toBe(false);
    if (!capability.available) {
      expect(capability.reason).toBe('capability_disabled');
    }
  });
});
