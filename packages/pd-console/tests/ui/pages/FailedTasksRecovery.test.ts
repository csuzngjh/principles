/**
 * Source-contract test for Failed Tasks recovery — Governance Recovery
 * Actions v1.
 *
 * Verifies the flag-gated recovery UI wiring:
 * - api.ts exposes the validated recoverFailedTask POST wrapper
 * - FailedTasksPage gates the button behind failed_task_recovery_console
 *   (fail-closed) and uses an explicit AlertDialog confirmation (SPEC §6.3/§8)
 * - success refreshes the list; failures surface reason + next action (rc-9)
 * - FocusPage maps the new tasks_need_human_review state with the correct
 *   count interpolation
 * - i18n keys exist with en/zh parity (EP-11)
 *
 * Pattern: source-code contract test (string matching on source files).
 * Mirrors SettingsOnboardingFlag.test.ts.
 *
 * EP-02 (Production Path Wiring): POST /api/v1/failed-tasks/:id/recover
 * EP-09 (Test Reality): contract assertions reflect the real implementation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/pages
// SRC_ROOT  = packages/pd-console/src
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src');

const pageSource = readFileSync(
  join(SRC_ROOT, 'ui', 'pages', 'failed-tasks', 'FailedTasksPage.tsx'),
  'utf8',
);
const apiSource = readFileSync(join(SRC_ROOT, 'ui', 'api.ts'), 'utf8');
const validatorsSource = readFileSync(join(SRC_ROOT, 'ui', 'utils', 'validators.ts'), 'utf8');
const focusSource = readFileSync(join(SRC_ROOT, 'ui', 'pages', 'focus', 'FocusPage.tsx'), 'utf8');
const serverIndexSource = readFileSync(join(SRC_ROOT, 'server', 'index.ts'), 'utf8');
const enJson = parseJsonRecord(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'en.json'), 'utf8'),
);
const zhJson = parseJsonRecord(
  readFileSync(join(SRC_ROOT, 'ui', 'i18n', 'zh-CN.json'), 'utf8'),
);

describe('FailedTasksPage recovery (Governance Recovery Actions v1)', () => {
  it('Given api.ts, When parsed, Then recoverFailedTask POSTs to /recover with a validator (EP-02)', () => {
    expect(apiSource).toContain('recoverFailedTask');
    expect(apiSource).toContain('/api/v1/failed-tasks/');
    expect(apiSource).toContain('/recover');
    expect(apiSource).toContain('validateRecoveryResult');
    expect(apiSource).toContain("'POST'");
  });

  it('Given FailedTasksPage, When parsed, Then recovery is fail-closed behind the flag', () => {
    expect(pageSource).toContain('failed_task_recovery_console');
    // Fail-closed: only an explicitly enabled flag shows the action
    expect(pageSource).toContain('flag?.enabled === true');
  });

  it('Given FailedTasksPage, When parsed, Then recovery requires an explicit AlertDialog confirmation (SPEC §6.3)', () => {
    expect(pageSource).toContain('AlertDialog');
    expect(pageSource).toContain('recoverConfirmTitle');
    expect(pageSource).toContain('handleRecoverConfirmed');
    // The dialog action prevents auto-close and runs the confirmed handler
    expect(pageSource).toContain('event.preventDefault()');
  });

  it('Given FailedTasksPage, When parsed, Then success refreshes the list and failure surfaces reason + next action (rc-9)', () => {
    expect(pageSource).toContain('await loadData()');
    expect(pageSource).toContain('result.nextAction');
    expect(pageSource).toContain('toast.success');
    expect(pageSource).toContain('toast.error');
  });

  it('Given FailedTasksPage, When parsed, Then the row button label uses the governance term, not Retry (SPEC §5.1)', () => {
    expect(pageSource).toContain('pages.failedTasks.recover');
    const enFailed = getNestedRecord(enJson, ['pages', 'failedTasks']);
    expect(String(enFailed['recover'])).not.toMatch(/retry/i);
  });

  it('Given validators, When parsed, Then governance queue accepts pendingHumanReviewCount + new codes (ERR-083 audit)', () => {
    expect(validatorsSource).toContain('pendingHumanReviewCount');
    expect(validatorsSource).toContain("'tasks_need_human_review'");
    expect(validatorsSource).toContain("'review_failed_tasks'");
  });

  it('Given FocusPage, When parsed, Then tasks_need_human_review interpolates the human-review count', () => {
    expect(focusSource).toContain('tasks_need_human_review');
    expect(focusSource).toContain('pendingHumanReviewCount');
  });

  it('Given FailedTasksPage, When parsed, Then exhausted tasks are recovered with force (force recovery wiring)', () => {
    // Exhaustion is derived from the row's attempt budget, not guessed
    expect(pageSource).toContain('isAttemptBudgetExhausted');
    // The handler forwards the force flag into the API call
    expect(pageSource).toContain('recoverFailedTask(recoverTarget.taskId, undefined, recoverExhausted)');
    // The dialog surfaces the exhaustion warning and the force action label
    expect(pageSource).toContain('recoverExhaustedWarning');
    expect(pageSource).toContain('recoverConfirmForceButton');
    expect(pageSource).toContain('recoverConfirmForceImpactDesc');
    // The API wrapper sends force in the POST body only when requested
    expect(apiSource).toContain('body.force = true');
    // The response validator accepts forceApplied
    expect(validatorsSource).toContain('forceApplied');
  });

  it('Given i18n keys, When checked, Then recovery keys exist in en + zh with parity (EP-11)', () => {
    const enFailed = getNestedRecord(enJson, ['pages', 'failedTasks']);
    const zhFailed = getNestedRecord(zhJson, ['pages', 'failedTasks']);
    const recoveryKeys = [
      'recover',
      'recoverConfirmTitle',
      'recoverConfirmStatus',
      'recoverConfirmActionLabel',
      'recoverConfirmActionDesc',
      'recoverConfirmImpactLabel',
      'recoverConfirmImpactDesc',
      'recoverConfirmAttempts',
      'recoverExhaustedWarning',
      'recoverConfirmForceButton',
      'recoverConfirmForceImpactDesc',
      'recoverConfirmButton',
      'recoverSuccess',
      'recoverFailed',
    ];
    for (const key of recoveryKeys) {
      expect(enFailed[key]).toBeDefined();
      expect(zhFailed[key]).toBeDefined();
    }
    // zh must be non-empty strings (not missing translations)
    for (const key of recoveryKeys) {
      expect(String(zhFailed[key]).length).toBeGreaterThan(0);
    }
  });

  it('Given server/index.ts, When parsed, Then the recovery flag is wired into the route context fail-closed (EP-02)', () => {
    expect(serverIndexSource).toContain('failed_task_recovery_console');
    // Fail-closed default: absent config value resolves to false
    expect(serverIndexSource).toContain("pdFlags.flags.failed_task_recovery_console?.enabled ?? false");
  });

  it('Given i18n focus keys, When checked, Then new state codes exist in en + zh', () => {
    const enState = getNestedRecord(enJson, ['pages', 'focus', 'stateReason']);
    const zhState = getNestedRecord(zhJson, ['pages', 'focus', 'stateReason']);
    const enNext = getNestedRecord(enJson, ['pages', 'focus', 'nextAction']);
    const zhNext = getNestedRecord(zhJson, ['pages', 'focus', 'nextAction']);
    expect(enState['tasks_need_human_review']).toBeDefined();
    expect(zhState['tasks_need_human_review']).toBeDefined();
    expect(enNext['review_failed_tasks']).toBeDefined();
    expect(zhNext['review_failed_tasks']).toBeDefined();
  });
});
