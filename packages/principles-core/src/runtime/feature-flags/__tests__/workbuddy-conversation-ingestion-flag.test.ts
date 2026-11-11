import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEATURE_FLAGS,
  computeEffectiveFlags,
} from '../feature-flag-contract.js';
import { QUIET_FLAG_LIFECYCLE } from '../feature-flag-lifecycle.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../../config/pd-config-feature-flags.js';
import { computeEffectivePdConfig } from '../../config/pd-config-effective.js';

/**
 * workbuddy_conversation_ingestion registration contract (PRI-1171 P2,
 * ticket ⑥). Mirrors the Codex flag contract but keeps the third host's
 * three-gate model explicit: the ingestion flag is independent of the
 * `host.workbuddy` master switch and of the v3 consent record.
 */
describe('workbuddy_conversation_ingestion flag registration', () => {
  it('is registered quiet and default-off in the flag SSoT', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find((entry) => entry.id === 'workbuddy_conversation_ingestion');
    expect(flag).toBeDefined();
    expect(flag).toMatchObject({ category: 'quiet', enabled: false, since: '2026-11-11' });
    expect(flag?.description).toContain('zero transcript reads');
  });

  it('has a complete KEEP_QUIET lifecycle census entry', () => {
    const entry = QUIET_FLAG_LIFECYCLE.workbuddy_conversation_ingestion;
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('census entry missing');
    expect(entry.decision).toBe('KEEP_QUIET');
    expect(entry.consumers.length).toBeGreaterThan(0);
    expect(entry.decided).toBe('2026-11-11');
    expect(entry.graduationCriteria).toContain('governance_observations');
    expect(entry.retirementCriteria.length).toBeGreaterThan(0);
  });

  it('stays off under pure defaults (upgrade never implicitly enables it)', () => {
    const effective = computeEffectivePdConfig(null);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(isFeatureEnabled(flags, 'workbuddy_conversation_ingestion')).toBe(false);
  });

  it('is independently switchable and never implicitly enables host.workbuddy', () => {
    const configPath = '/workspace/.pd/config.yaml';
    const base = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    expect(base.flags.workbuddy_conversation_ingestion?.enabled).toBe(false);

    const both = computeEffectiveFlags({
      workbuddy_conversation_ingestion: { enabled: true },
      'host.workbuddy': { enabled: true },
    }, DEFAULT_FEATURE_FLAGS, configPath);
    expect(both.flags.workbuddy_conversation_ingestion?.enabled).toBe(true);
    expect(both.flags['host.workbuddy']?.enabled).toBe(true);

    // Turning ingestion on alone must NOT switch the host master on: the
    // runtime still short-circuits on host.workbuddy (three-gate invariant).
    const flagOnly = computeEffectiveFlags({ workbuddy_conversation_ingestion: { enabled: true } }, DEFAULT_FEATURE_FLAGS, configPath);
    expect(flagOnly.flags.workbuddy_conversation_ingestion?.enabled).toBe(true);
    expect(flagOnly.flags['host.workbuddy']?.enabled).toBe(false);
  });
});
