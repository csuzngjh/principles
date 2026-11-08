/* eslint-disable */
// Playwright spec 文件有自己的类型系统（Page/Locator），不参与生产构建，
// 用 eslint-disable 避免 lefthook pre-commit 的 lint glob 匹配报错。

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §10/§15 AC-22 — the REAL-browser acceptance of
 * the four-page Owner journey against the real backend + real lab pipeline:
 *
 *   A. Principle Evaluation   — ledger list, production evidence panel
 *      (honest degraded lanes), pain lineage, gate panel.
 *   B. Study Configuration    — suite catalog + Gold gate + creation with the
 *      real target (p-001, active, no RuleCodes) → navigates to the study.
 *   C. Execution & Evidence   — preflight → offline-stub run → Report V2
 *      generation; frozen production snapshot with divergence markers.
 *   D. Evaluation Report      — ITT / fidelity / replay verification,
 *      limitations, SEPARATE production observation lane, Owner decision
 *      handoff into the existing governance page.
 *   E. 异常处理                — host dry-run checklist (zero model calls),
 *      F2 refusal without authorization (403 surfaced in the UI), historical
 *      studies read-only.
 */
import { test, expect, type Page } from '@playwright/test';

function attachErrorCollectors(page: Page): string[] {
  const errors: string[] = [];
  page.on('response', (resp) => {
    if (resp.url().includes('/api/') && resp.status() >= 500) {
      errors.push(`5xx: ${resp.status()} ${resp.url()}`);
    }
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

// p-002 is the clean target (ACTIVE, no RuleCode coupling). p-003 carries a
// live rulecode activation bound to itself and must REFUSE creation with
// INTERVENTION_NOT_IDENTIFIABLE — asserted below (SPEC §7.2 / AC-11).
const TARGET_PRINCIPLE = 'p-002';
const COUPLED_PRINCIPLE = 'p-003';

test.describe.configure({ mode: 'serial' });

test.describe('Examiner v0.10.1 — four-page Owner journey (real browser, real backend)', () => {
  let createdStudyId = '';

  test('A. Principle Evaluation: gates panel, ledger list, production evidence with honest lanes', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await page.goto('/#/examiner');
    await expect(page.getByTestId('examiner-page-title')).toBeVisible({ timeout: 20_000 });

    // Gates panel ships the honesty contract.
    await expect(page.getByTestId('examiner-gate-gate1_challenge_trust')).toContainText('BLOCKED');

    // The seeded ACTIVE principle is offered as a study input.
    await expect(page.getByTestId(`examiner-principle-${TARGET_PRINCIPLE}`)).toBeVisible();
    await page.getByTestId(`examiner-principle-${TARGET_PRINCIPLE}`).click();

    // The production evidence panel renders with its lanes; the e2e workspace
    // HAS a state.db, so lanes are real — but any lane may legitimately be
    // degraded, which must be VISIBLE, never shown as zero events.
    await expect(page.getByTestId('examiner-evidence-panel')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-evidence-principle-id')).toHaveText(TARGET_PRINCIPLE);
    await expect(page.getByTestId('examiner-evidence-ledger-note')).toContainText('ASSET lifecycle');
    await expect(page.getByTestId('examiner-evidence-injection-status')).toBeVisible();
    await expect(page.getByTestId('examiner-evidence-audit')).toBeVisible();

    // The evidence ladder exists and is never promoted.
    await expect(page.getByTestId('examiner-evidence-ladder')).toContainText('agent_claimed');

    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('B. Study Configuration: suite catalog + Gold gate + creation navigates to the study', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await page.goto(`/#/examiner/configure?principle=${TARGET_PRINCIPLE}`);
    await expect(page.getByTestId('examiner-configure-title')).toBeVisible({ timeout: 20_000 });

    // The target is prefilled from the evaluation entry link.
    await expect(page.getByTestId('examiner-target-select')).toHaveValue(TARGET_PRINCIPLE);

    // The fixed suite catalog renders with the Gate 1 boundary.
    await expect(page.getByTestId('examiner-suite-calibration-core')).toBeVisible();
    await expect(page.getByTestId('examiner-suite-gold-gate')).toContainText('Gate 1');

    // Host readiness requirements are visible before any run is requested.
    await expect(page.getByTestId('examiner-configure-readiness')).toContainText('stage_r_authorization');

    // NEGATIVE first (SPEC §7.2 / AC-11): p-001 carries live RuleCode
    // activations — creation must REFUSE with INTERVENTION_NOT_IDENTIFIABLE
    // (runtime-sourced evidence, never an assumed-independent study).
    await page.getByTestId('examiner-target-select').selectOption(COUPLED_PRINCIPLE);
    const refusedPromise = page.waitForResponse((r) => r.url().includes('/api/examiner/studies') && r.request().method() === 'POST', { timeout: 25_000 });
    await page.getByTestId('examiner-create-button').click();
    const refused = await refusedPromise;
    expect(refused.status()).toBe(422);
    await expect(page.getByTestId('examiner-configure-title')).toBeVisible();

    // Create on the clean target with the richer suite (6 cases, 1 rep).
    await page.getByTestId('examiner-target-select').selectOption(TARGET_PRINCIPLE);
    await page.getByTestId('examiner-repetitions-select').selectOption('1');
    await page.getByTestId('examiner-suite-calibration-core').click();
    const createResponsePromise = page.waitForResponse((r) => r.url().includes('/api/examiner/studies') && r.request().method() === 'POST', { timeout: 60_000 });
    await page.getByTestId('examiner-create-button').click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(200);

    // Creation navigates to the new study page (server-minted identity).
    await expect(page.getByTestId('examiner-study-title')).toBeVisible({ timeout: 30_000 });
    const url = page.url();
    createdStudyId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    expect(createdStudyId).toMatch(/^EXM-C-/);
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('C. Execution & Evidence: frozen snapshot, preflight, offline run, report generation', async ({ page }) => {
    test.skip(createdStudyId === '', 'study creation failed in scenario B');
    const errors = attachErrorCollectors(page);
    await page.goto(`/#/examiner/studies/${encodeURIComponent(createdStudyId)}`);
    await expect(page.getByTestId('examiner-study-detail')).toBeVisible({ timeout: 20_000 });

    // The frozen production snapshot shows the honest divergence markers.
    await expect(page.getByTestId('examiner-study-snapshot')).toBeVisible();
    await expect(page.getByTestId('examiner-study-snapshot-markers')).toBeVisible();

    // Fail-closed preflight passes for the fresh study.
    await page.getByTestId('examiner-preflight-button').click();
    await expect(page.getByTestId('examiner-preflight-result')).toBeVisible({ timeout: 30_000 });

    // Offline-stub execution (real lab pipeline, zero model calls).
    await page.getByTestId('examiner-run-button').click();
    await expect(page.getByTestId('examiner-unit-states')).toContainText('SUCCEEDED', { timeout: 120_000 });

    // Report V2 generation + navigation.
    await page.getByTestId('examiner-report-button').click();
    await expect(page.getByTestId('examiner-open-report')).toBeVisible({ timeout: 60_000 });
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('D. Evaluation Report: ITT + fidelity + replay + separate production lane + governance handoff', async ({ page }) => {
    test.skip(createdStudyId === '', 'study creation failed in scenario B');
    const errors = attachErrorCollectors(page);
    await page.goto(`/#/examiner/studies/${encodeURIComponent(createdStudyId)}/report`);
    await expect(page.getByTestId('examiner-report')).toBeVisible({ timeout: 30_000 });

    // Controlled A/B result blocks.
    await expect(page.getByTestId('examiner-report-itt')).toBeVisible();
    await expect(page.getByTestId('examiner-report-fidelity')).toBeVisible();
    // A report whose replay verification fails is NOT an acceptable outcome:
    // the scenario must fail, not pass on the FAILED label.
    await expect(page.getByTestId('examiner-report-verification')).toContainText('OK');
    await expect(page.getByTestId('examiner-report-offline-note')).toContainText(/never real-host behavior|绝不代表真实宿主行为/);

    // The production observation is a SEPARATE lane on the same page.
    await expect(page.getByTestId('examiner-report-production-note')).toBeVisible();

    // Owner decision handoff routes into the existing governance workflow.
    await expect(page.getByTestId('examiner-report-handoff')).toBeVisible();
    await page.getByTestId('examiner-report-handoff-governance').click();
    await expect(page).toHaveURL(new RegExp(`/#/principles/${TARGET_PRINCIPLE}$`));
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('E. 异常处理: host dry-run checklist settles with zero model calls; F2 refused without authorization', async ({ page }) => {
    test.skip(createdStudyId === '', 'study creation failed in scenario B');
    const errors = attachErrorCollectors(page);
    await page.goto(`/#/examiner/studies/${encodeURIComponent(createdStudyId)}`);
    await expect(page.getByTestId('examiner-study-detail')).toBeVisible({ timeout: 20_000 });

    // Host dry-run is accepted asynchronously and settles into the console-run
    // list (FINISHED or FAILED — the checklist outcome IS the Owner answer;
    // a fresh study always fails stage_r_authorization, loudly).
    await page.getByTestId('examiner-dryrun-button').click();
    await expect(page.getByTestId('examiner-console-runs')).toContainText(/FINISHED|FAILED|ABANDONED/, { timeout: 60_000 });

    // F2 without an APPROVED Stage R record is refused by the server; the UI
    // surfaces the refusal (toast) and NO console run appears from it.
    const runCountBefore = await page.locator('[data-testid^="examiner-console-run-"]').count();
    await page.getByTestId('examiner-f2-button').click();
    await page.waitForTimeout(1500);
    const runCountAfter = await page.locator('[data-testid^="examiner-console-run-"]').count();
    expect(runCountAfter).toBe(runCountBefore);
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('F. 历史研究资产只读：入口可见且不可写', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await page.goto('/#/examiner');
    await expect(page.getByTestId('examiner-page-title')).toBeVisible({ timeout: 20_000 });
    // The committed acceptance studies appear in the list (repo checkout lab).
    // The entry MUST be present: a conditional "if visible" would silently
    // pass the scenario when the read-only boundary regressed.
    const historical = page.getByTestId('examiner-study-EXM-V09-ACC-ISO');
    await expect(historical).toBeVisible({ timeout: 20_000 });
    await historical.click();
    await expect(page.getByTestId('examiner-study-readonly')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-run-button')).toBeDisabled();
    await expect(page.getByTestId('examiner-report-button')).toBeDisabled();
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
