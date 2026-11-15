import { expect, test, type Page } from '@playwright/test';

/**
 * P2-1 — the Owner must SEE the strategic fence on every approval channel.
 *
 * The server (`SqliteApprovalStore.approve`) refuses a confirmed strategic
 * conflict on prompt / code_tool_hook / defer_archive alike, and the grouped
 * model attaches `approveBlock` to all of them. The review card used to read it
 * only for `prompt`, so the other two channels offered a working approve button
 * that the server would reject. These scenarios assert the corrected wiring
 * end-to-end against the real Console UI.
 */

const COPY = {
  zh: {
    blocked: '这条材料存在尚未解决的战略冲突，目前不能批准。',
    unclassified: '没有指明冲突针对哪个意图字段',
  },
  en: {
    blocked: 'This material has an unresolved strategic conflict',
    unclassified: 'never names which intent field',
  },
} as const;

async function openApproval(page: Page, approvalId: string): Promise<void> {
  await page.goto(`/#/review/a%3A${approvalId}`);
  await expect(page.getByTestId('review-card')).toBeVisible();
}

/**
 * Evidence capture is opt-in so CI stays deterministic; the acceptance run sets
 * `P2_SCREENSHOT_DIR` to the Owner-facing report folder.
 */
async function capture(page: Page, name: string): Promise<void> {
  const dir = process.env.P2_SCREENSHOT_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

const BLOCKED_CHANNELS = [
  { name: 'prompt', approvalId: 'apr-intent-prompt', unclassified: false },
  { name: 'code_tool_hook', approvalId: 'apr-intent-hook', unclassified: false },
  { name: 'defer_archive', approvalId: 'apr-intent-defer', unclassified: true },
] as const;

for (const channel of BLOCKED_CHANNELS) {
  test(`blocks approve and explains why on the ${channel.name} channel`, async ({ page }) => {
    await openApproval(page, channel.approvalId);

    const blocked = page.getByTestId('review-approve-blocked');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText(COPY.zh.blocked);

    // Approve is fenced; reject stays available (the Owner keeps an exit).
    await expect(page.getByTestId('review-approve')).toBeDisabled();
    await expect(page.getByTestId('review-reject')).toBeEnabled();

    // The unclassified case explains WHY no decision can cover it.
    if (channel.unclassified) {
      await expect(page.getByTestId('review-approve-blocked-unclassified')).toContainText(COPY.zh.unclassified);
    }

    // No raw server strings / i18next keys leak into the Owner-facing card.
    const card = page.getByTestId('review-card');
    await expect(card).not.toContainText('no_effective_resolution');
    await expect(card).not.toContainText('unclassified_conflict [');
    await expect(card).not.toContainText('pages.review.');
    await capture(page, `blocked-${channel.name}`);
  });
}

test('clears the fence once an effective decision covers the trade-off', async ({ page }) => {
  await openApproval(page, 'apr-intent-resolved');
  await expect(page.getByTestId('review-approve-blocked')).toHaveCount(0);
  await expect(page.getByTestId('review-approve')).toBeEnabled();
  await capture(page, 'resolved-tradeoff');
});

test('localizes the strategic block in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pd-language', 'en'));
  await openApproval(page, 'apr-intent-defer');
  const blocked = page.getByTestId('review-approve-blocked');
  await expect(blocked).toContainText(COPY.en.blocked);
  await expect(page.getByTestId('review-approve-blocked-unclassified')).toContainText(COPY.en.unclassified);
  await expect(page.getByTestId('review-approve')).toBeDisabled();
  await expect(page.getByTestId('review-card')).not.toContainText('pages.review.');
  await capture(page, 'blocked-en');
});

test('localizes the strategic block in Chinese', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pd-language', 'zh-CN'));
  await openApproval(page, 'apr-intent-prompt');
  await expect(page.getByTestId('review-approve-blocked')).toContainText(COPY.zh.blocked);
  await expect(page.getByTestId('review-card')).not.toContainText('pages.review.');
  await capture(page, 'blocked-zh');
});
