/**
 * Source-contract test for SettingsPage onboarding reset button (Task 16).
 *
 * Mirrors the source-contract pattern in WelcomePage.test.ts: the vitest config
 * uses 'node' environment (no jsdom), so we verify the source-code contract
 * rather than mounting React.
 *
 * Guards against:
 *  - removal of resetOnboardingState wiring (EP-02 production path)
 *  - reset targeting the wrong workspaceId key — silent no-op reset (EP-09)
 *  - missing window.confirm guard before destructive action (EP-03)
 *  - hardcoded user-facing strings instead of t() i18n keys (EP-11)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/pages
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src', 'ui');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const settingsSource = readSrc('pages/settings/SettingsPage.tsx');

describe('SettingsPage onboarding reset', () => {
  it('Given SettingsPage source, When parsed, Then imports resetOnboardingState', () => {
    expect(settingsSource).toContain('resetOnboardingState');
    // Import path uses .js extension (TS NodeNext resolution convention)
    expect(settingsSource).toContain('onboarding-state.js');
  });

  it('Given SettingsPage, When parsed, Then has reset button with confirm dialog', () => {
    // EP-03: destructive action must be guarded by confirm
    expect(settingsSource).toContain('window.confirm');
    expect(settingsSource).toContain('components.onboardingReset.resetConfirm');
  });

  it('Given SettingsPage, When parsed, Then calls resetOnboardingState on confirm', () => {
    expect(settingsSource).toContain('resetOnboardingState(');
  });

  it('Given reset success, When parsed, Then shows toast.success', () => {
    expect(settingsSource).toContain('toast.success');
    expect(settingsSource).toContain('components.onboardingReset.resetSuccess');
  });

  it('Given SettingsPage, When parsed, Then derives currentWorkspaceId from workspaces[0] (EP-09: avoid silent no-op reset)', () => {
    // Critical invariant: App.tsx stores onboarding state under
    // workspaces[0].name (or "default" if none). SettingsPage must reset the
    // SAME key — using a hardcoded "default" would no-op when workspaces exist.
    expect(settingsSource).toContain('workspaces[0]?.name');
    expect(settingsSource).toContain('"default"');
  });

  it('Given SettingsPage, When parsed, Then reset button text routes through t() (EP-11)', () => {
    expect(settingsSource).toContain('components.onboardingReset.resetButton');
    expect(settingsSource).toContain('components.onboardingReset.title');
  });

  it('Given i18n keys, When checked, Then onboardingReset exists in en + zh', () => {
    const enJson = JSON.parse(readSrc('i18n/en.json')) as {
      components: { onboardingReset: { title: unknown; resetButton: unknown; resetConfirm: unknown; resetSuccess: unknown } };
    };
    const zhJson = JSON.parse(readSrc('i18n/zh-CN.json')) as {
      components: { onboardingReset: { title: unknown; resetButton: unknown; resetConfirm: unknown; resetSuccess: unknown } };
    };
    expect(enJson.components.onboardingReset).toBeDefined();
    expect(zhJson.components.onboardingReset).toBeDefined();
    expect(enJson.components.onboardingReset.resetButton).toBeDefined();
    expect(zhJson.components.onboardingReset.resetButton).toBeDefined();
    expect(enJson.components.onboardingReset.resetConfirm).toBeDefined();
    expect(zhJson.components.onboardingReset.resetConfirm).toBeDefined();
    expect(enJson.components.onboardingReset.resetSuccess).toBeDefined();
    expect(zhJson.components.onboardingReset.resetSuccess).toBeDefined();
  });
});
