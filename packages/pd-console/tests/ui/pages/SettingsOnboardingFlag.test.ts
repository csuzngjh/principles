/**
 * Source-contract test for SettingsPage onboarding flag toggle — Task 12.5.
 *
 * Verifies the new_user_onboarding feature flag toggle UI in SettingsPage:
 * - state, loader effect, and toggle handler exist
 * - calls the validated patchFeatureFlag wrapper (not raw request)
 * - loads flag state via fetchConfigSummary
 * - toggle button exposes role="switch" + aria-checked for accessibility
 * - i18n keys exist with en/zh parity
 *
 * Pattern: source-code contract test (string matching on source files).
 * Mirrors Approuting.test.ts and WelcomePage.test.ts.
 *
 * EP-02 (Production Path Wiring): PATCH /api/v1/config/features/new_user_onboarding
 * EP-09 (Test Reality): contract assertions reflect the real implementation.
 * EP-11 (i18n): all user-visible strings come from i18n keys.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/pages
// SRC_ROOT  = packages/pd-console/src
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src');

const settingsSource = readFileSync(
  join(SRC_ROOT, 'ui', 'pages', 'settings', 'SettingsPage.tsx'),
  'utf8',
);
const apiSource = readFileSync(join(SRC_ROOT, 'ui', 'api.ts'), 'utf8');
const enJson = JSON.parse(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'en.json'), 'utf8'),
);
const zhJson = JSON.parse(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'zh-CN.json'), 'utf8'),
);

describe('SettingsPage onboarding flag toggle', () => {
  it('Given SettingsPage, When parsed, Then has onboardingFlagEnabled state', () => {
    expect(settingsSource).toContain('onboardingFlagEnabled');
    expect(settingsSource).toContain('setOnboardingFlagEnabled');
  });

  it('Given SettingsPage, When parsed, Then imports patchFeatureFlag + fetchConfigSummary', () => {
    expect(settingsSource).toContain('patchFeatureFlag');
    expect(settingsSource).toContain('fetchConfigSummary');
  });

  it('Given SettingsPage, When parsed, Then toggles new_user_onboarding flag', () => {
    expect(settingsSource).toContain('new_user_onboarding');
    expect(settingsSource).toContain('handleToggleOnboardingFlag');
  });

  it('Given SettingsPage, When parsed, Then has a role="switch" toggle with aria-checked', () => {
    expect(settingsSource).toContain('role="switch"');
    expect(settingsSource).toContain('aria-checked');
    expect(settingsSource).toContain('onboarding-flag-toggle');
  });

  it('Given SettingsPage, When parsed, Then surfaces failure via toast (rc-9)', () => {
    expect(settingsSource).toContain('components.onboardingFlag.toggleFailed');
    expect(settingsSource).toContain('components.onboardingFlag.loadFailed');
  });

  it('Given api.ts, When parsed, Then patchFeatureFlag wires PATCH /features/:name (EP-02)', () => {
    expect(apiSource).toContain('PATCH');
    expect(apiSource).toContain('/api/v1/config/features/');
    expect(apiSource).toContain('validateFeatureFlagUpdate');
  });

  it('Given i18n keys, When checked, Then onboardingFlag exists in en + zh with parity', () => {
    expect(enJson.components.onboardingFlag).toBeDefined();
    expect(zhJson.components.onboardingFlag).toBeDefined();
    const enKeys = Object.keys(enJson.components.onboardingFlag).sort();
    const zhKeys = Object.keys(zhJson.components.onboardingFlag).sort();
    expect(enKeys).toEqual(zhKeys);
    // Spot-check the required keys
    for (const key of [
      'title',
      'label',
      'description',
      'toggleAriaLabel',
      'enabled',
      'disabled',
      'toggleFailed',
      'loadFailed',
    ]) {
      expect(enJson.components.onboardingFlag[key]).toBeDefined();
      expect(zhJson.components.onboardingFlag[key]).toBeDefined();
    }
  });
});
