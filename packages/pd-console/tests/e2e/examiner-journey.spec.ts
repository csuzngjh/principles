/* eslint-disable */
// Playwright spec 文件有自己的类型系统（Page/Locator），不参与生产构建，
// 用 eslint-disable 避免 lefthook pre-commit 的 lint glob 匹配报错。

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §10/§15 AC-22 — the REAL-browser acceptance of
 * the four-page Owner journey against the real backend + real lab pipeline.
 *
 * Phase A–E of the user-value closure mandate tightened this spec:
 *   - the detail-page entry is reachable by a real Owner (no dev-mode gate);
 *   - "request failed" and "no data" are separate, retryable UI states;
 *   - the eligibility pre-check is shown BEFORE submit and the create button
 *     is disabled while BLOCKED (the server refuses the same request, which is
 *     asserted through the API so a disabled button cannot hide a regression);
 *   - F2 is visibly closed in the UI and still refused by the server;
 *   - the report leads with an Owner Summary and declares its execution mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const SCREENSHOT_DIR = path.resolve(process.cwd(), '../../.tmp/e2e-screens');

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

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

    // Phase A2: the first-screen guide states what the page answers, what it
    // will not do, and when to use it — without opening a separate manual.
    await expect(page.getByTestId('examiner-guide')).toBeVisible();
    await expect(page.getByTestId('examiner-guide-flow')).toContainText(/原则|Principle/);

    await shot(page, 'journey-a-evaluation-desktop');
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('A1. 详情页入口：active 原则可直达评估，非 active 明示不可执行', async ({ page }) => {
    const errors = attachErrorCollectors(page);

    // ACTIVE (p-002) → a real, clickable Owner entry.
    await page.goto(`/#/principles/${TARGET_PRINCIPLE}`);
    const entry = page.getByTestId('principle-detail-examiner-link');
    await expect(entry).toBeVisible({ timeout: 20_000 });
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`/#/examiner\\?principle=${TARGET_PRINCIPLE}$`));
    await expect(page.getByTestId('examiner-page-title')).toBeVisible({ timeout: 20_000 });
    // The entry prefills the target: evidence is loaded for THAT principle.
    await expect(page.getByTestId('examiner-evidence-principle-id')).toHaveText(TARGET_PRINCIPLE, { timeout: 20_000 });

    // NON-ACTIVE (a seeded candidate) → no dead link; the reason is stated.
    await page.goto('/#/principles/e2e00000-0000-4000-8000-000000000001');
    await expect(page.getByTestId('principle-detail-examiner-blocked')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('principle-detail-examiner-link')).toHaveCount(0);
    await shot(page, 'journey-a1-detail-blocked-desktop');
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('A2. 加载失败 ≠ 空数据：失败态可重试，重试后恢复', async ({ page }) => {
    const errors = attachErrorCollectors(page);

    // Simulate a real network failure of the principles request (not a mock of
    // the feature): the page must say "failed" with a retry, and must NOT
    // render the "no active principle" empty state, which means something else.
    await page.route('**/api/examiner/principles', (route) => route.abort('failed'));
    await page.goto('/#/examiner');
    await expect(page.getByTestId('examiner-principles-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-principles-retry')).toBeVisible();
    await expect(page.getByTestId('examiner-no-active-principles')).toHaveCount(0);
    await shot(page, 'journey-a2-principles-error-desktop');

    await page.unroute('**/api/examiner/principles');
    await page.getByTestId('examiner-principles-retry').click();
    await expect(page.getByTestId(`examiner-principle-${TARGET_PRINCIPLE}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-principles-error')).toHaveCount(0);
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

    // Phase C: the clean target is pre-checked BEFORE submit. The panel shows
    // the verdict; a non-BLOCKED verdict is what enables the create button.
    await expect(page.getByTestId('examiner-eligibility-panel')).toBeVisible({ timeout: 20_000 });
    // p-002 is ELIGIBLE or DEGRADED in this workspace (degraded production
    // evidence is legitimate and must stay creatable) — never BLOCKED.
    await expect(page.getByTestId('examiner-eligibility-status')).toBeVisible();
    await expect(page.getByTestId('examiner-eligibility-panel')).not.toHaveAttribute('data-eligibility-status', 'BLOCKED');
    await expect(page.getByTestId('examiner-create-button')).toBeEnabled();

    const studiesBefore = await (await page.request.get('/api/examiner/overview')).json();

    // NEGATIVE (SPEC §7.2 / AC-11): p-003 carries a live RuleCode activation
    // bound to itself — the pre-check must BLOCK and the button must be
    // disabled. The server is asserted separately, so a disabled button can
    // never mask a missing server-side guard.
    await page.getByTestId('examiner-target-select').selectOption(COUPLED_PRINCIPLE);
    await expect(page.getByTestId('examiner-eligibility-panel')).toHaveAttribute('data-eligibility-status', 'BLOCKED', { timeout: 20_000 });
    await expect(page.getByTestId('examiner-eligibility-check-rulecode_identifiability')).toBeVisible();
    await expect(page.getByTestId('examiner-create-button')).toBeDisabled();
    await expect(page.getByTestId('examiner-create-blocked-hint')).toBeVisible();

    const refused = await page.request.post('/api/examiner/studies', {
      data: { targetPrincipleId: COUPLED_PRINCIPLE },
    });
    expect(refused.status()).toBe(422);
    const refusedBody = await refused.json();
    expect(refusedBody.blockingReasonCode).toBe('intervention_not_identifiable');
    expect(refusedBody.error).toBe('study_creation_refused');
    const studiesAfterRefusal = await (await page.request.get('/api/examiner/overview')).json();
    expect(studiesAfterRefusal.data.studies.length).toBe(studiesBefore.data.studies.length);

    // Create on the clean target with the richer suite (6 cases, 1 rep).
    await page.getByTestId('examiner-target-select').selectOption(TARGET_PRINCIPLE);
    await expect(page.getByTestId('examiner-eligibility-panel')).not.toHaveAttribute('data-eligibility-status', 'BLOCKED', { timeout: 20_000 });
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
    await shot(page, 'journey-c-study-desktop');
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('D. Evaluation Report: ITT + fidelity + replay + separate production lane + governance handoff', async ({ page }) => {
    test.skip(createdStudyId === '', 'study creation failed in scenario B');
    const errors = attachErrorCollectors(page);
    await page.goto(`/#/examiner/studies/${encodeURIComponent(createdStudyId)}/report`);
    await expect(page.getByTestId('examiner-report')).toBeVisible({ timeout: 30_000 });

    // Phase E: the FIRST screen is an Owner Summary — conclusion, what was
    // confirmed, and the next step — not a statistics table.
    await expect(page.getByTestId('examiner-owner-summary')).toBeVisible();
    const conclusion = page.getByTestId('examiner-owner-summary-conclusion');
    await expect(conclusion).toBeVisible();
    await expect(conclusion).not.toHaveText(/^\s*$/);
    await expect(conclusion).not.toContainText('undefined');
    await expect(page.getByTestId('examiner-owner-summary-rationale')).toBeVisible();
    await expect(page.getByTestId('examiner-owner-summary-cannot-prove')).toContainText(/不能证明|cannot prove/i);
    await expect(page.getByTestId('examiner-owner-summary-next')).toBeVisible();

    // Phase E3: the report declares WHICH execution mode produced it, and the
    // F2 count stays 0 (this round has zero real model calls).
    await expect(page.getByTestId('examiner-execution-mode')).toHaveAttribute('data-mode', /offline/);
    await expect(page.getByTestId('examiner-execution-mode-f2')).toContainText('0');

    // Phase E1: every limitation is collected in ONE block (no scattered
    // repeats that make the Owner hunt for caveats).
    await expect(page.getByTestId('examiner-report-scope-limits')).toBeVisible();
    await expect(page.getByTestId('examiner-report-offline-note')).toContainText(/never real-host behavior|绝不代表真实宿主行为/);

    // Controlled A/B result blocks.
    await expect(page.getByTestId('examiner-report-itt')).toBeVisible();
    await expect(page.getByTestId('examiner-report-fidelity')).toBeVisible();
    // A report whose replay verification fails is NOT an acceptable outcome:
    // the scenario must fail, not pass on the FAILED label.
    await expect(page.getByTestId('examiner-report-verification')).toContainText('OK');

    // The production observation is a SEPARATE lane on the same page.
    await expect(page.getByTestId('examiner-report-production-note')).toBeVisible();

    // Owner decision handoff routes into the existing governance workflow.
    await expect(page.getByTestId('examiner-report-handoff')).toBeVisible();
    await shot(page, 'journey-d-report-desktop');
    await page.getByTestId('examiner-report-handoff-governance').click();
    await expect(page).toHaveURL(new RegExp(`/#/principles/${TARGET_PRINCIPLE}$`));
    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('E. 异常处理: host dry-run settles with zero model calls; F2 is visibly closed AND refused server-side', async ({ page }) => {
    test.skip(createdStudyId === '', 'study creation failed in scenario B');
    const errors = attachErrorCollectors(page);
    await page.goto(`/#/examiner/studies/${encodeURIComponent(createdStudyId)}`);
    await expect(page.getByTestId('examiner-study-detail')).toBeVisible({ timeout: 20_000 });

    // Host dry-run is accepted asynchronously and settles into the console-run
    // list (FINISHED or FAILED — the checklist outcome IS the Owner answer;
    // a fresh study always fails stage_r_authorization, loudly).
    await page.getByTestId('examiner-dryrun-button').click();
    await expect(page.getByTestId('examiner-console-runs')).toContainText(/FINISHED|FAILED|ABANDONED/, { timeout: 60_000 });

    // Phase D1/D2: F2 is presented as a CLOSED capability with its reason and
    // next step, and the control cannot be triggered — never a silent failure.
    await expect(page.getByTestId('examiner-f2-unavailable')).toBeVisible();
    await expect(page.getByTestId('examiner-f2-button')).toBeDisabled();

    // Phase D2: the UI being disabled is not the authority. Calling the API
    // directly must still be refused server-side (zero model calls).
    const runCountBefore = await page.locator('[data-testid^="examiner-console-run-"]').count();
    const refused = await page.request.post(`/api/examiner/studies/${encodeURIComponent(createdStudyId)}/run`, {
      data: { mode: 'f2-real-host' },
    });
    expect(refused.status()).toBe(403);
    const refusedBody = await refused.json();
    expect(refusedBody.error).toBe('real_execution_not_authorized');

    await page.reload();
    await expect(page.getByTestId('examiner-study-detail')).toBeVisible({ timeout: 20_000 });
    const runCountAfter = await page.locator('[data-testid^="examiner-console-run-"]').count();
    expect(runCountAfter).toBe(runCountBefore);

    await shot(page, 'journey-e-f2-closed-desktop');
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

  test('G. 配置页异常路径：套件/宿主条件/资格接口失败都可见可重试，且宿主条件不门控离线创建', async ({ page }) => {
    const errors: string[] = [];
    // Hash-only navigation keeps the mounted React tree (and its previous
    // state), so each isolated scenario must reload to re-run its bootstrap.
    const openConfigure = async (url: string): Promise<void> => {
      await page.goto(url);
      await page.reload();
    };

    // Suite catalog failure → a stated error, and creation stays refused
    // because the suite is a real creation input.
    await page.route('**/api/examiner/suites', (route) => route.abort('failed'));
    await openConfigure(`/#/examiner/configure?principle=${TARGET_PRINCIPLE}`);
    await expect(page.getByTestId('examiner-suite-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-create-button')).toBeDisabled();
    await page.unroute('**/api/examiner/suites');

    // Host readiness failure → its own error + retry, but it is NOT a gate for
    // an offline study (Phase B3): the create button must stay enabled once the
    // eligibility pre-check is ready.
    await page.route('**/api/examiner/hosts/openclaw/readiness', (route) => route.abort('failed'));
    await openConfigure(`/#/examiner/configure?principle=${TARGET_PRINCIPLE}`);
    await expect(page.getByTestId('examiner-readiness-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-readiness-retry')).toBeVisible();
    await expect(page.getByTestId('examiner-eligibility-panel')).not.toHaveAttribute('data-eligibility-status', /loading|idle/, { timeout: 20_000 });
    await expect(page.getByTestId('examiner-create-button')).toBeEnabled();
    await page.unroute('**/api/examiner/hosts/openclaw/readiness');

    // Eligibility failure → an error with retry, distinct from BLOCKED, and
    // creation is disabled while the verdict is unknown.
    await page.route('**/api/examiner/principles/*/eligibility*', (route) => route.abort('failed'));
    await openConfigure(`/#/examiner/configure?principle=${TARGET_PRINCIPLE}`);
    await expect(page.getByTestId('examiner-eligibility-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-eligibility-retry')).toBeVisible();
    await expect(page.getByTestId('examiner-eligibility-panel')).not.toHaveAttribute('data-eligibility-status', 'BLOCKED');
    await expect(page.getByTestId('examiner-create-button')).toBeDisabled();
    await page.unroute('**/api/examiner/principles/*/eligibility*');

    // No active principle is an EMPTY state, never an error wall.
    await page.route('**/api/examiner/principles', (route) => route.fulfill({ json: { success: true, data: { principles: [] } } }));
    await openConfigure('/#/examiner/configure');
    await expect(page.getByTestId('examiner-no-active-principles')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('examiner-principles-error')).toHaveCount(0);
    await page.unroute('**/api/examiner/principles');

    expect(errors, `errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
