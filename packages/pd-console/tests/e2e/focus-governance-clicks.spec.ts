/* eslint-disable */
// PRI-517 / PRI-629: Focus is an Owner inbox, not a second approval authority.
// It must route each pending governance fact to the existing page that owns its
// decision controls; duplicated Focus controls previously drifted and left this
// test clicking UI that users could no longer see.

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://127.0.0.1:${process.env.PD_CONSOLE_E2E_PORT ?? '3101'}`;

async function apiGet(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE_URL}${path}`);
  return { status: response.status, body: await response.json() };
}

async function gotoFocus(page: Page): Promise<void> {
  await page.goto('/#/focus');
  await page.waitForLoadState('networkidle');
}

test.describe('PRI-629: Focus routes Owner decisions to their existing authorities', () => {
  test('pending deployment approval is visible and takes the Owner to Principles', async ({ page }) => {
    const approvals = await apiGet('/api/v1/approvals?status=pending');
    expect(approvals.status).toBe(200);
    const approval = approvals.body.data.items[0];
    expect(approval).toBeTruthy();

    await gotoFocus(page);
    const cta = page.getByTestId(`go-approvals-${approval.artifactId}`);
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '#/principles');
    await cta.click();
    await expect(page).toHaveURL(/#\/principles$/);
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('pending RuleCode shadow decision is visible and takes the Owner to Activation', async ({ page }) => {
    const decisions = await apiGet('/api/v1/governance/owner-decisions');
    expect(decisions.status).toBe(200);
    const shadow = decisions.body.data.items.find((entry: any) => entry.kind === 'rulecode_decision');
    expect(shadow).toBeTruthy();

    await gotoFocus(page);
    const cta = page.getByTestId(`go-activation-${shadow.taskId}`);
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '#/activation');
    await cta.click();
    await expect(page).toHaveURL(/#\/activation$/);
    await expect(page.getByRole('main')).toBeVisible();
  });
});
