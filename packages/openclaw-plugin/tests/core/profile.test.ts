import { describe, it, expect } from 'vitest';
import { normalizeProfile, PROFILE_DEFAULTS } from '../../src/core/profile';

describe('Profile Module', () => {
  it('should apply defaults to an empty object', () => {
    const profile = normalizeProfile({});
    expect(profile.audit_level).toBe(PROFILE_DEFAULTS.audit_level);
    expect(profile.tests.on_change).toBe(PROFILE_DEFAULTS.tests.on_change);
    expect(profile._profile_invalid).toBe(false);
    expect(profile._profile_warnings.length).toBe(0);
  });

  it('should handle invalid profile type', () => {
    const profile = normalizeProfile(null);
    expect(profile.audit_level).toBe(PROFILE_DEFAULTS.audit_level);
    expect(profile._profile_invalid).toBe(true);
    expect(profile._profile_warnings.length).toBeGreaterThan(0);
  });

  it('should retain custom valid values', () => {
    const custom = {
      audit_level: 'high',
      risk_paths: ['src/core/'],
      tests: {
        on_change: 'full'
      }
    };
    const profile = normalizeProfile(custom);
    expect(profile.audit_level).toBe('high');
    expect(profile.risk_paths).toEqual(['src/core/']);
    expect(profile.tests.on_change).toBe('full');
    expect(profile._profile_invalid).toBe(false);
  });

  it('should validate and normalize risk_paths', () => {
    const custom = {
      risk_paths: 'src/core/' // string instead of array
    };
    const profile = normalizeProfile(custom);
    expect(profile.risk_paths).toEqual(['src/core/']);
  });

  it('should handle custom_guards', () => {
    const custom = {
      custom_guards: [
        { pattern: 'src/secret', severity: 'fatal', message: 'No secrets' },
        { pattern: 'src/test', severity: 'invalid' } // should default to error
      ]
    };
    const profile = normalizeProfile(custom);
    expect(profile.custom_guards.length).toBe(2);
    expect(profile.custom_guards[0].severity).toBe('fatal');
    expect(profile.custom_guards[1].severity).toBe('error');
    expect(profile.custom_guards[1].message).toBe('Custom guard triggered');
  });
});