/* eslint-disable */
/**
 * B2/B3 regression: a review session must keep working after the first card.
 *
 * Every card is a route change on the same component instance. Before the fix,
 * `advance()` left `feedback` set and the next card rendered the previous
 * card's confirmation, so approve / reject / defer disappeared. This test
 * walks two cards with mocked reads (no dependency on seed mutation order) and
 * then reloads to prove the session resumes on the same card with the same
 * progress count.
 */
import { test, expect, type Page } from '@playwright/test';

const NOW = new Date();
// Anchor both cards to the start of the LOCAL day. `NOW - 2h` / `NOW - 1h`
// makes the first card "yesterday" whenever CI runs between 01:00 and 02:00
// UTC; `splitReviewQueue` then orders today's card first and this two-card walk
// stops working. The fixtures must not depend on the wall-clock hour.
const DAY_START = new Date(NOW);
DAY_START.setHours(0, 1, 0, 0);
const FIRST_AT = DAY_START.toISOString();
const SECOND_AT = new Date(DAY_START.getTime() + 60_000).toISOString();
const GENERATED_AT = NOW.toISOString();

const GROUPED = {
  success: true,
  data: {
    generatedAt: GENERATED_AT,
    groups: [
      {
        principleId: 'principle-first',
        principleTitle: '先处理这一条',
        status: 'pending',
        records: [{ id: 'apr-session-first', artifactId: 'artifact-first', channel: 'prompt', createdAt: FIRST_AT, status: 'pending' }],
      },
      {
        principleId: 'principle-second',
        principleTitle: '再处理这一条',
        status: 'pending',
        records: [{ id: 'apr-session-second', artifactId: 'artifact-second', channel: 'prompt', createdAt: SECOND_AT, status: 'pending' }],
      },
    ],
  },
};

const APPROVED_RECORD = {
  success: true,
  data: {
    approvalId: 'apr-session-first',
    artifactId: 'artifact-first',
    channel: 'prompt',
    riskLevel: 'low',
    status: 'approved',
    requestedAt: FIRST_AT,
  },
};

async function installMocks(page: Page): Promise<void> {
  // The e2e server has no registered Owner identity, which locks decisions by
  // design. Patch the readiness projection so the card renders its normal
  // decision area.
  await page.route('**/api/governance/experience', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json?.data?.readiness) {
      json.data.readiness.ownerIdentityConfiguration = 'configured';
    }
    await route.fulfill({ response, json });
  });
  // Hermetic queue: no owner decisions, two approval cards in a fixed order.
  await page.route('**/api/governance/owner-decisions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { items: [], total: 0, generatedAt: GENERATED_AT, readIssues: [] } }),
  }));
  await page.route('**/api/approvals/grouped*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(GROUPED),
  }));
  await page.route('**/api/approvals/apr-session-first/approve', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(APPROVED_RECORD),
  }));
}

test.describe('review session: two cards in a row', () => {
  test('the next card keeps approve / reject / defer, and reload stays on it', async ({ page }) => {
    await installMocks(page);
    await page.goto('/#/review/a%3Aapr-session-first');
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-review-id', 'a:apr-session-first');
    await expect(page.getByTestId('review-approve')).toBeEnabled();

    await page.getByTestId('review-approve').click();

    // The confirmation is transient; after it the same route must render the
    // next card's full action area instead of an empty/stale one.
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-review-id', 'a:apr-session-second', { timeout: 5000 });
    await expect(page.getByTestId('review-feedback')).toHaveCount(0);
    await expect(page.getByTestId('review-approve')).toBeVisible();
    await expect(page.getByTestId('review-reject')).toBeVisible();
    await expect(page.getByTestId('review-defer')).toBeVisible();
    await expect(page.getByTestId('review-approve')).toBeEnabled();

    // Refresh: the session resumes on the same card and the progress count
    // matches the queue the server is serving.
    await page.reload();
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-review-id', 'a:apr-session-second');
    await expect(page.getByTestId('review-progress')).toHaveText(/第 2 条 \/ 共 2 条|2 of 2/);
    await expect(page.getByTestId('review-approve')).toBeVisible();
  });
});
