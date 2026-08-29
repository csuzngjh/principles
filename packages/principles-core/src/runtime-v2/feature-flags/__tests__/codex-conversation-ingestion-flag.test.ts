import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEATURE_FLAGS,
  computeEffectiveFlags,
} from '../feature-flag-contract.js';
import { QUIET_FLAG_LIFECYCLE } from '../feature-flag-lifecycle.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../../config/pd-config-feature-flags.js';
import { computeEffectivePdConfig } from '../../config/pd-config-effective.js';

/**
 * codex_conversation_ingestion registration contract (Codex Governance
 * Closure Slice A; SPEC rev 2 §17, ADR-0020 §11.2).
 */

describe('codex_conversation_ingestion flag registration', () => {
  it('is registered quiet and default-off in the flag SSoT', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find((entry) => entry.id === 'codex_conversation_ingestion');
    expect(flag).toBeDefined();
    expect(flag).toMatchObject({ category: 'quiet', enabled: false, since: '2026-08-29' });
    expect(flag?.description).toContain('Default off; flag-off = zero transcript reads');
  });

  it('has a complete KEEP_QUIET lifecycle census entry', () => {
    const entry = QUIET_FLAG_LIFECYCLE.codex_conversation_ingestion;
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('census entry missing');
    expect(entry.decision).toBe('KEEP_QUIET');
    expect(entry.consumers.length).toBeGreaterThan(0);
    expect(entry.decided).toBe('2026-08-29');
    expect(entry.graduationCriteria).toContain('R1');
    expect(entry.retirementCriteria.length).toBeGreaterThan(0);
  });

  it('stays off under pure defaults (upgrade never implicitly enables it)', () => {
    const effective = computeEffectivePdConfig(null);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(isFeatureEnabled(flags, 'codex_conversation_ingestion')).toBe(false);
  });

  it('is independently switchable via workspace config override without touching host.codex', () => {
    const configPath = '/workspace/.pd/config.yaml';
    const base = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    expect(base.flags.codex_conversation_ingestion?.enabled).toBe(false);
    const enabled = computeEffectiveFlags({ codex_conversation_ingestion: { enabled: true } }, DEFAULT_FEATURE_FLAGS, configPath);
    expect(enabled.flags.codex_conversation_ingestion?.enabled).toBe(true);
    expect(enabled.flags['host.codex']?.enabled).toBe(true);
    const hostOff = computeEffectiveFlags({ 'host.codex': { enabled: false }, codex_conversation_ingestion: { enabled: true } }, DEFAULT_FEATURE_FLAGS, configPath);
    expect(hostOff.flags['host.codex']?.enabled).toBe(false);
    expect(hostOff.flags.codex_conversation_ingestion?.enabled).toBe(true);
    expect(hostOff.warnings.join(' ')).toContain('core flag explicitly disabled');
  });
});
