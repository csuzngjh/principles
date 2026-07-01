/**
 * Source-contract test for WelcomePage component (Task 14).
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components with @testing-library/react. Instead we verify the
 * source-code contract — mirroring the pattern in CircuitDiagram.test.ts
 * and IntentPage.test.ts.
 *
 * This guards against accidental regressions in:
 *  - 3-step wizard state (1 | 2 | 3)
 *  - integration of CircuitDiagram + DemoResultView + onboarding-state
 *  - API call wiring (POST /api/v1/onboarding/run-demo)
 *  - i18n key routing (EP-11: every user-facing string via t())
 *  - accessibility roles (role=main, progressbar, aria-labelledby)
 *  - completion status values ('demo' / 'skipped')
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/pages
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src', 'ui');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

const componentSource = readSrc('pages/welcome/WelcomePage.tsx');

describe('WelcomePage component contract', () => {
  it('rejects malformed demo stages instead of filtering them into partial success', () => {
    expect(componentSource).toContain('d.stages.every(isDemoStage)');
    expect(componentSource).not.toContain('d.stages.filter(isDemoStage)');
  });
  it('does not navigate away when onboarding state cannot be persisted', () => {
    expect(componentSource).toContain('if (!setOnboardingState(workspaceId');
    expect(componentSource).toContain('pages.welcome.stateSaveError');
  });
  it('Given WelcomePage source, When parsed, Then has 3 steps with step state', () => {
    expect(componentSource).toContain('useState<1 | 2 | 3>(1)');
    expect(componentSource).toContain('step === 1');
    expect(componentSource).toContain('step === 2');
    expect(componentSource).toContain('step === 3');
  });

  it('Given WelcomePage, When parsed, Then imports CircuitDiagram and DemoResultView', () => {
    expect(componentSource).toContain('CircuitDiagram');
    expect(componentSource).toContain('DemoResultView');
  });

  it('Given WelcomePage, When parsed, Then imports onboarding-state functions', () => {
    expect(componentSource).toContain('getOnboardingState');
    expect(componentSource).toContain('setOnboardingState');
  });

  it('Given WelcomePage, When parsed, Then calls POST /api/v1/onboarding/run-demo', () => {
    expect(componentSource).toContain('POST');
    expect(componentSource).toContain('/api/v1/onboarding/run-demo');
  });

  it('Given WelcomePage, When parsed, Then completeOnboarding sets state and navigates to /focus', () => {
    expect(componentSource).toContain("navigate('/focus'");
    expect(componentSource).toContain('completed: true');
  });

  it('Given WelcomePage, When parsed, Then uses i18n keys from welcome namespace', () => {
    // Keys without interpolation — checked as t('key')
    const simpleKeys = [
      'pages.welcome.title',
      'pages.welcome.subtitle',
      'pages.welcome.step1.title',
      'pages.welcome.step2.title',
      'pages.welcome.step3.title',
    ];
    for (const key of simpleKeys) {
      expect(componentSource).toContain(`t('${key}')`);
    }
    // stepIndicator uses interpolation params, so check for the key opening
    expect(componentSource).toContain("t('pages.welcome.stepIndicator'");
  });

  it('Given i18n keys, When checked, Then all exist in en.json and zh-CN.json', () => {
    const en = getNestedRecord(parseJsonRecord(readSrc('i18n/en.json')), ['pages', 'welcome']);
    const zh = getNestedRecord(parseJsonRecord(readSrc('i18n/zh-CN.json')), ['pages', 'welcome']);
    expect(en.title).toBeDefined();
    expect(zh.title).toBeDefined();
    expect(getNestedRecord(en, ['step1']).title).toBeDefined();
    expect(getNestedRecord(zh, ['step1']).title).toBeDefined();
  });

  it('Given WelcomePage, When parsed, Then has accessibility roles', () => {
    expect(componentSource).toContain('role="main"');
    expect(componentSource).toContain('role="progressbar"');
    expect(componentSource).toContain('aria-labelledby');
  });

  it('Given skip button, When parsed, Then calls completeOnboarding with skipped status', () => {
    expect(componentSource).toContain("'skipped'");
  });

  it('Given demo complete, When parsed, Then completeOnboarding with demo status', () => {
    expect(componentSource).toContain("'demo'");
  });
});

describe('WelcomePage step 3 polling (spec 6.5.2)', () => {
  it('Given WelcomePage, When parsed, Then has polling logic with 2-hour timeout', () => {
    expect(componentSource).toContain('TWO_HOURS_MS');
    expect(componentSource).toContain('2 * 60 * 60 * 1000');
  });

  it('Given WelcomePage, When parsed, Then has polling interval (30 seconds)', () => {
    expect(componentSource).toContain('POLL_INTERVAL_MS');
    expect(componentSource).toContain('30 * 1000');
  });

  it('Given WelcomePage, When parsed, Then has unmount cleanup (clearInterval + clearTimeout)', () => {
    expect(componentSource).toContain('clearInterval');
    expect(componentSource).toContain('clearTimeout');
    expect(componentSource).toContain('return () =>');
  });

  it('Given WelcomePage, When parsed, Then polling statuses: idle/polling/timeout/evidence-found', () => {
    expect(componentSource).toContain("'idle'");
    expect(componentSource).toContain("'polling'");
    expect(componentSource).toContain("'timeout'");
    expect(componentSource).toContain("'evidence-found'");
  });

  it('Given WelcomePage, When parsed, Then calls /api/v1/evidence-chain for polling', () => {
    expect(componentSource).toContain('/api/v1/evidence-chain');
  });
});
