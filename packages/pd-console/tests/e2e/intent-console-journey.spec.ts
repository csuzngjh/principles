/**
 * PRI-1239 / SPEC-PD-INTENT-UNIFICATION-001 §11 — the FULL Intent Console
 * Owner journey in a real Chromium browser against the real Console server.
 *
 * Runs on the EN document language: the sibling spec `intent-onboarding-flow`
 * (which sorts after this file) needs a pristine zh-CN slate, so this journey
 * performs its create/edit/verify cycle on INTENT.en.md and demonstrates the
 * two languages' independence at the end. It restores the flag to OFF in
 * afterAll exactly like the sibling spec.
 */

import { test, expect, type Page } from '@playwright/test';

async function gotoIntent(page: Page): Promise<void> {
  await page.goto('/#/intent');
  await expect(page.locator('[data-intent-state]')).toBeVisible({ timeout: 15000 });
}

/** Polling state assertion — expect(promise).resolves would read the
 *  attribute ONCE with no retry, racing the page's own re-fetch. */
async function expectState(page: Page, expected: string): Promise<void> {
  await expect.poll(async () => page.locator('[data-intent-state]').getAttribute('data-intent-state') ?? '', { timeout: 15000 }).toBe(expected);
}

/** Version-record count for the EN document, read through the page's own
 *  request context (loopback console API — same origin the page uses). */
async function enVersionCount(page: Page): Promise<number> {
  const resp = await page.request.get('/api/intent/versions?lang=en');
  const body = await resp.json().catch(() => null);
  return (body as { data?: { versions?: unknown[] } })?.data?.versions?.length ?? 0;
}

test.describe.serial('PRI-1239 Intent Console full browser journey (EN document)', () => {
  test.afterAll(async ({ request }) => {
    // Restore the shared suite default (flag off) for the sibling specs.
    await request.patch('/api/config/features/intent_engineering', { data: { enabled: false } });
  });

  test('initial state: Disabled → enable → Missing', async ({ page }) => {
    await gotoIntent(page);
    // Fresh workspace: flag off, nothing readable.
    await expectState(page, 'disabled');
    await expect(page.getByTestId('intent-flag-enable')).toBeVisible();

    await page.getByTestId('intent-flag-enable').click();
    // The page re-fetches the summary: the persisted config now shows enabled.
    await expectState(page, 'missing');
    await expect(page.getByTestId('intent-flag-disable')).toBeVisible();
  });

  test('create template → onboarding: fill 2, skip 3 → Incomplete 2/5', async ({ page }) => {
    await gotoIntent(page);
    await expectState(page, 'missing');

    // This journey owns the EN document; zh-CN stays pristine for the sibling
    // onboarding spec. Switch FIRST so create/wizard/save all target INTENT.en.md.
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'missing');

    // The NotFoundBanner's create button auto-opens the onboarding modal on
    // mount (not yet dismissed in this fresh browser profile).
    await expect(page.getByTestId('onboarding-start')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('onboarding-start').click();

    // Step 1 (Why): fill.
    await page.locator('#intent-section-why').waitFor({ state: 'visible' });
    await page.locator('#intent-section-why').fill('Owner attention is the scarcest resource this quarter.');
    await page.getByTestId('onboarding-next').click();

    // Step 2 (Desired Outcome): SKIP — Next is NOT disabled on an empty section.
    await page.locator('#intent-section-desiredOutcome').waitFor({ state: 'visible' });
    await expect(page.getByTestId('onboarding-next')).toBeEnabled();
    await page.getByTestId('onboarding-skip-section').click();

    // Step 3 (Non-negotiables): fill.
    await page.locator('#intent-section-nonNegotiables').waitFor({ state: 'visible' });
    await page.locator('#intent-section-nonNegotiables').fill('Never trade user trust for automation coverage.');
    await page.getByTestId('onboarding-next').click();

    // Step 4 + Step 5: skip both via the explicit skip button.
    await page.locator('#intent-section-stopEscalation').waitFor({ state: 'visible' });
    await page.getByTestId('onboarding-skip-section').click();
    await page.locator('#intent-section-currentStrategicFocus').waitFor({ state: 'visible' });
    await page.getByTestId('onboarding-skip-section').click();

    // Finish summary discloses what is filled and what is not.
    await expect(page.getByTestId('onboarding-complete')).toBeVisible();
    await page.getByTestId('onboarding-complete').click();

    // Saved: partially filled is a usable state, never an error.
    await expectState(page, 'incomplete');
    await expect(page.getByTestId('intent-section-count')).toContainText('2 / 5');
  });

  test('reload: state, content and hash survive a fresh page load', async ({ page }) => {
    await gotoIntent(page);
    // The language selector resets to the zh-CN default on reload — re-select
    // the EN document this journey owns.
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'incomplete');
    await expect(page.getByTestId('intent-section-count')).toContainText('2 / 5');

    // Content of the filled sections is rendered with its per-section state.
    await expect(page.getByText('Owner attention is the scarcest resource this quarter.')).toBeVisible();

    // Content hash stays visible (technical meta, still on the page).
    const hash = await page.locator('text=/sha256:[0-9a-f]{12,}/').first().textContent().catch(() => null);
    expect(hash).not.toBeNull();
  });

  test('edit the remaining sections → save → Configured 5/5 (persists after reload)', async ({ page }) => {
    await gotoIntent(page);
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'incomplete');
    await page.getByTestId('intent-edit').click();
    await page.locator('#intent-section-desiredOutcome').waitFor({ state: 'visible' });
    await page.locator('#intent-section-desiredOutcome').fill('Repeated drift is diagnosed within one cycle.');
    await page.locator('#intent-section-stopEscalation').fill('Production data deletion requires an explicit Owner decision.');
    await page.locator('#intent-section-currentStrategicFocus').fill('Diagnosis trustworthiness over throughput.');
    await page.getByTestId('intent-editor-save').click();
    await expectState(page, 'configured');
    await expect(page.getByTestId('intent-section-count')).toContainText('5 / 5');

    await page.reload();
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'configured');
    await expect(page.getByTestId('intent-section-count')).toContainText('5 / 5');
  });

  test('zh-CN and en documents are independent', async ({ page }) => {
    await gotoIntent(page);
    // The page boots on the zh-CN default — that document was never created by
    // this journey, so it shows Missing: NOT the EN content (no bleed).
    await expectState(page, 'missing');

    // Switching to EN restores the journey document verbatim.
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'configured');
    await expect(page.getByTestId('intent-section-count')).toContainText('5 / 5');
  });

  test('disable: cancel is a no-op; confirm persists; history survives', async ({ page }) => {
    await gotoIntent(page);
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'configured');

    // Version history recorded the saves while enabled.
    const versionCount = await enVersionCount(page);
    expect(versionCount).toBeGreaterThan(0);

    await page.getByTestId('intent-flag-disable').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // Eight effect bullets are disclosed (stops 1-4, preserves 5-8).
    await expect(dialog.locator('li')).toHaveCount(8);
    // Cancel: nothing changes.
    await page.getByTestId('intent-disable-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expectState(page, 'configured');

    // Confirm: the flag flips; Disabled persists after a reload.
    await page.getByTestId('intent-flag-disable').click();
    await page.getByTestId('intent-disable-confirm').click();
    await expectState(page, 'disabled');
    await page.reload();
    await expectState(page, 'disabled');

    // Disabling does NOT delete history: version records survive flag-off.
    expect(await enVersionCount(page)).toBe(versionCount);
  });

  test('re-enable: the document state is restored exactly', async ({ page }) => {
    await gotoIntent(page);
    await expectState(page, 'disabled');
    await page.getByTestId('intent-flag-enable').click();
    // Flag on + zh-CN default (never created) → Missing first.
    await expectState(page, 'missing');
    // The EN document is intact; select it and verify the full state returned.
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'configured');
    await expect(page.getByTestId('intent-section-count')).toContainText('5 / 5');
  });

  test('no i18n key leaks, no raw internal codes, no page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await gotoIntent(page);
    const body = await page.locator('body').innerText();
    expect(body, 'i18n keys must never render raw').not.toContain('pages.intent.');
    expect(body).not.toContain('contentReadiness');
    expect(errors).toEqual([]);
  });

  test('disable dialog: full keyboard focus management (PR #2684 P2)', async ({ page }) => {
    await gotoIntent(page);
    await page.getByTestId('intent-lang-select').selectOption('en');
    await expectState(page, 'configured');

    const dialog = page.getByRole('alertdialog');
    const cancelBtn = page.getByTestId('intent-disable-cancel');
    const confirmBtn = page.getByTestId('intent-disable-confirm');

    // ── Mouse: open → cancel → nothing changes ────────────────────────────
    await page.getByTestId('intent-flag-disable').click();
    await expect(dialog).toBeVisible();
    // Initial focus lands on Cancel (data-autofocus).
    await expect(cancelBtn).toBeFocused();
    await cancelBtn.click();
    await expect(dialog).toHaveCount(0);
    await expectState(page, 'configured');

    // ── Keyboard: open → Tab stays trapped → Shift+Tab reverses ───────────
    await page.getByTestId('intent-flag-disable').click();
    await expect(dialog).toBeVisible();
    await expect(cancelBtn).toBeFocused();

    // Tab from Cancel must move INSIDE the dialog (to the confirm action),
    // never to background page controls.
    await page.keyboard.press('Tab');
    await expect(confirmBtn).toBeFocused();
    // Tab again wraps around to the first focusable (Cancel).
    await page.keyboard.press('Tab');
    await expect(cancelBtn).toBeFocused();
    // Shift+Tab reverses the cycle.
    await page.keyboard.press('Shift+Tab');
    await expect(confirmBtn).toBeFocused();

    // Background content is not interactive while the dialog is open: the
    // language select behind the overlay cannot receive focus via Tab wrap.
    await page.keyboard.press('Shift+Tab'); // → Cancel
    await page.keyboard.press('Shift+Tab'); // → wraps to confirm again
    await expect(confirmBtn).toBeFocused();

    // ── Escape closes; focus restores to the trigger button ──────────────
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('intent-flag-disable')).toBeFocused();

    // ── Confirm path still works end-to-end ──────────────────────────────
    await page.getByTestId('intent-flag-disable').click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('intent-disable-confirm').click();
    await expectState(page, 'disabled');

    // Re-enable to leave the suite state consistent with the next test.
    // The EN document + language selector stay selected throughout.
    await page.getByTestId('intent-flag-enable').click();
    await expectState(page, 'configured');
    await expect(page.getByTestId('intent-section-count')).toContainText('5 / 5');
  });
});
