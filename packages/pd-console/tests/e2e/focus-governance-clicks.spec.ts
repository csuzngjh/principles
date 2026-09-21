/* eslint-disable */
// PRI-517 / PRI-629: Focus is an Owner inbox, not a second approval authority.
// It must route each pending governance fact to the existing page that owns its
// decision controls; duplicated Focus controls previously drifted and left this
// test clicking UI that users could no longer see.
//
// Deep-link contract (adhoc-20260921): each record-context CTA must land on the
// SPECIFIC record, not just the owning page — 部署审批 → /principles/:id
// (Owner Decision View with approve/reject), RuleCode 决策 → /activation with
// the activation card located, 查看恢复详情 → /failed-tasks with the task
// expanded (covered by the failed-tasks suite).

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

/** Escape a literal URL suffix for toHaveURL's regex form. */
function urlSuffixPattern(suffix: string): RegExp {
  return new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

test.describe('PRI-629: Focus routes Owner decisions to their existing authorities', () => {
  test('pending deployment approval is visible and deep-links to its principle detail page', async ({ page }) => {
    const decisions = await apiGet('/api/v1/governance/owner-decisions');
    expect(decisions.status).toBe(200);
    const approvalItem = decisions.body.data.items.find((entry: any) => entry.kind === 'activation_approval');
    expect(approvalItem).toBeTruthy();

    await gotoFocus(page);
    const cta = page.getByTestId(`go-approvals-${approvalItem.taskId}`);
    await expect(cta).toBeVisible();
    // Seeded approval artifacts carry source_principle_id, so the server
    // resolves the ledger id and the CTA must target the principle DETAIL
    // page (which owns the approve/reject actions) — not the bare review list.
    expect(approvalItem.principleId).toBeTruthy();
    const expectedHash = `#/principles/${encodeURIComponent(approvalItem.principleId)}`;
    await expect(cta).toHaveAttribute('href', expectedHash);
    await cta.click();
    await expect(page).toHaveURL(urlSuffixPattern(expectedHash));
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('pending RuleCode shadow decision is visible and locates its activation card', async ({ page }) => {
    const decisions = await apiGet('/api/v1/governance/owner-decisions');
    expect(decisions.status).toBe(200);
    const shadow = decisions.body.data.items.find((entry: any) => entry.kind === 'rulecode_decision');
    expect(shadow).toBeTruthy();

    await gotoFocus(page);
    const cta = page.getByTestId(`go-activation-${shadow.taskId}`);
    await expect(cta).toBeVisible();
    const expectedHash = `#/activation?activationId=${encodeURIComponent(shadow.taskId)}`;
    await expect(cta).toHaveAttribute('href', expectedHash);
    await cta.click();
    await expect(page).toHaveURL(urlSuffixPattern(expectedHash));
    // The deep link lands on the SPECIFIC activation card, not the top of the list.
    await expect(page.getByTestId(`activation-card-${shadow.taskId}`)).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });
});
