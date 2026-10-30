/* eslint-disable */
// PRI-517 / PRI-629: Focus is an Owner inbox, not a second approval authority.
// It must route each pending governance fact to the existing page that owns its
// decision controls; duplicated Focus controls previously drifted and left this
// test clicking UI that users could no longer see.
//
// Deep-link contract (adhoc-20260921): each record-context CTA must land on the
// SPECIFIC record, not just the owning page — RuleCode 决策 → /activation with
// the activation card located, 查看恢复详情 → /failed-tasks with the task
// expanded (covered by the failed-tasks suite). 部署审批 (activation_approval)
// changed shape in PRI-889: the decision actions render inline on Focus
// (the selected per-object reader) instead of a deep-link CTA; the CTA remains only as the
// fallback when grouped approvals data is unavailable.

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
  test('pending deployment approval is decidable inline on Focus (PRI-889)', async ({ page }) => {
    // PRI-889 contract change (Owner-visible, from PRI-768 v6 audit v6-01):
    // activation_approval decisions are no longer a deep-link CTA to the
    // principle detail page (which renders no decision buttons) — the
    // pending approval group renders the inline PendingReviewCard with
    // approve/reject/revise actions directly in the Focus decision section.
    const grouped = await apiGet('/api/v1/approvals/grouped');
    expect(grouped.status).toBe(200);
    const group = grouped.body.data.groups.find(
      (g: any) => g.status === 'pending'
        && Array.isArray(g.records) && g.records.some((r: any) => r.status === 'pending'),
    );
    expect(group).toBeTruthy();

    await gotoFocus(page);
    // 004 selects one exact approval before reading; grouping is not batch authority.
    const record = group.records.find((entry: any) => entry.status === 'pending');
    expect(record).toBeTruthy();
    const selected = page.getByTestId('owner-work-item').and(page.locator(`[data-item-key="approval:${record.id}"]`));
    await expect(selected).toBeVisible();
    await selected.click();
    await expect(page).toHaveURL(new RegExp(`review=${encodeURIComponent(`approval:${record.id}`)}`));
    const reading = page.getByTestId('owner-work-reading');
    // The no-auth fixture intentionally keeps every mutation locked with a visible reason.
    const approve = reading.getByTestId(`approve-btn-${group.principleId}`);
    const reject = reading.getByRole('button', { name: '拒绝这个版本', exact: true });
    const edit = reading.getByTestId(`edit-btn-${group.principleId}`);
    for (const action of [approve, reject, edit]) {
      await expect(action).toBeVisible();
      await expect(action).toBeDisabled();
    }
    await expect(page.getByTestId('focus-conclusion-lock')).toBeVisible();
    await expect(reading.getByRole('alert').filter({ hasText: '认证' })).toBeVisible();

  });

  test('pending RuleCode shadow decision is visible and locates its activation card', async ({ page }) => {
    const decisions = await apiGet('/api/v1/governance/owner-decisions');
    expect(decisions.status).toBe(200);
    const shadow = decisions.body.data.items.find((entry: any) => entry.kind === 'rulecode_decision');
    expect(shadow).toBeTruthy();

    await gotoFocus(page);
    const selected = page.getByTestId('owner-work-item').and(page.locator(`[data-item-key="decision:${shadow.reviewKey}"]`));
    await expect(selected).toBeVisible();
    await selected.click();
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
