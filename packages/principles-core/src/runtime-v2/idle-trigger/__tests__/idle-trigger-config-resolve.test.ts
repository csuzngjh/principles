import { describe, it, expect } from 'vitest';
import { resolveIdleTriggerConfig } from '../index.js';
import { DEFAULT_IDLE_TRIGGER_CONFIG } from '../index.js';

describe('resolveIdleTriggerConfig', () => {
  it('undefined partial returns full default config', () => {
    const result = resolveIdleTriggerConfig(undefined);
    expect(result).toEqual(DEFAULT_IDLE_TRIGGER_CONFIG);
  });

  it('empty object partial returns full default config', () => {
    const result = resolveIdleTriggerConfig({});
    expect(result).toEqual(DEFAULT_IDLE_TRIGGER_CONFIG);
  });

  it('partial enabled=false overrides only enabled', () => {
    const result = resolveIdleTriggerConfig({ enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.idleThresholdMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
    expect(result.jitterMaxMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs);
    expect(result.activityCooldownMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs);
  });

  it('partial enabled=true overrides only enabled', () => {
    const result = resolveIdleTriggerConfig({ enabled: true });
    expect(result.enabled).toBe(true);
    expect(result.idleThresholdMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
  });

  it('partial idleThresholdMs overrides only idleThresholdMs', () => {
    const result = resolveIdleTriggerConfig({ idleThresholdMs: 600000 });
    expect(result.idleThresholdMs).toBe(600000);
    expect(result.enabled).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.enabled);
    expect(result.jitterMaxMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs);
    expect(result.activityCooldownMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs);
  });

  it('partial jitterMaxMs overrides only jitterMaxMs', () => {
    const result = resolveIdleTriggerConfig({ jitterMaxMs: 60000 });
    expect(result.jitterMaxMs).toBe(60000);
    expect(result.enabled).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.enabled);
    expect(result.idleThresholdMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
    expect(result.activityCooldownMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs);
  });

  it('partial activityCooldownMs overrides only activityCooldownMs', () => {
    const result = resolveIdleTriggerConfig({ activityCooldownMs: 120000 });
    expect(result.activityCooldownMs).toBe(120000);
    expect(result.enabled).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.enabled);
    expect(result.idleThresholdMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
    expect(result.jitterMaxMs).toBe(DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs);
  });

  it('all fields partial overrides all fields', () => {
    const overrides = {
      enabled: false,
      idleThresholdMs: 900000,
      jitterMaxMs: 45000,
      activityCooldownMs: 180000,
    };
    const result = resolveIdleTriggerConfig(overrides);
    expect(result).toEqual(overrides);
  });

  it('single field partial is enough to be valid config', () => {
    const result = resolveIdleTriggerConfig({ idleThresholdMs: 120000 });
    expect(result.idleThresholdMs).toBe(120000);
    expect(result.enabled).toBe(true);
    expect(result.jitterMaxMs).toBe(30000);
    expect(result.activityCooldownMs).toBe(60000);
  });
});

describe('DEFAULT_IDLE_TRIGGER_CONFIG', () => {
  it('has required fields', () => {
    expect(DEFAULT_IDLE_TRIGGER_CONFIG).toHaveProperty('enabled');
    expect(DEFAULT_IDLE_TRIGGER_CONFIG).toHaveProperty('idleThresholdMs');
    expect(DEFAULT_IDLE_TRIGGER_CONFIG).toHaveProperty('jitterMaxMs');
    expect(DEFAULT_IDLE_TRIGGER_CONFIG).toHaveProperty('activityCooldownMs');
  });

  it('enabled defaults to true', () => {
    expect(DEFAULT_IDLE_TRIGGER_CONFIG.enabled).toBe(true);
  });

  it('idleThresholdMs is positive number', () => {
    expect(typeof DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs).toBe('number');
    expect(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs).toBeGreaterThan(0);
  });

  it('jitterMaxMs is non-negative number', () => {
    expect(typeof DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs).toBe('number');
    expect(DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs).toBeGreaterThanOrEqual(0);
  });

  it('activityCooldownMs is positive number', () => {
    expect(typeof DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs).toBe('number');
    expect(DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs).toBeGreaterThan(0);
  });

  it('jitterMaxMs is less than or equal to idleThresholdMs', () => {
    expect(DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs).toBeLessThanOrEqual(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
  });

  it('activityCooldownMs is less than idleThresholdMs', () => {
    expect(DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs).toBeLessThan(DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs);
  });
});
