/**
 * Source-contract test for App.tsx routing — Task 15.
 *
 * Verifies the /welcome route registration and first-visit redirect logic
 * that checks the new_user_onboarding feature flag + onboarding state.
 *
 * Pattern: source-code contract test (string matching on App.tsx source).
 * Mirrors the approach in navigation-mvp.test.ts and WelcomePage.test.ts.
 *
 * EP-02 (Production Path Wiring): route registration + redirect logic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, '..', '..', 'src', 'ui');

const appSource = readFileSync(join(SRC_ROOT, 'App.tsx'), 'utf8');

describe('App routing for /welcome', () => {
  it('Given App.tsx, When parsed, Then imports WelcomePage', () => {
    expect(appSource).toContain('WelcomePage');
  });

  it('Given App.tsx, When parsed, Then has /welcome route', () => {
    expect(appSource).toContain('path="/welcome"');
  });

  it('Given App.tsx, When parsed, Then imports getOnboardingState', () => {
    expect(appSource).toContain('getOnboardingState');
  });

  it('Given App.tsx, When parsed, Then has first-visit redirect logic checking onboarding state', () => {
    expect(appSource).toContain('onboardingState.completed');
    expect(appSource).toContain("'/welcome'");
    expect(appSource).toContain("'/focus'");
  });

  it('Given App.tsx, When parsed, Then checks feature flag before redirecting', () => {
    expect(appSource).toContain('new_user_onboarding');
  });
});
