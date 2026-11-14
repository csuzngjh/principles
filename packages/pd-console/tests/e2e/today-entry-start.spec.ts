/* eslint-disable */
/**
 * Production regression (v4.1.0): the 今天 entry could render a dead button.
 *
 * With no stored session the unhandled set is the whole queue, so the page
 * rendered the resume branch ("还剩 N 条没判断。" + "继续判断") even though
 * `resume()` returned early on `session === null`. Clicking did nothing and no
 * error was shown. The entry must instead start a pass and route to the first
 * card; a real same-day session must still resume.
 */
import { test, expect, type Page } from '@playwright/test';

const NOW = new Date();
// Start of the local day, not now-1h: when CI runs just after midnight UTC,
// now-1h is yesterday and the "today" fixture becomes a leftover, making this
// test depend on the wall-clock time of the run.
const TODAY_AT = new Date(new Date(NOW).setHours(0, 1, 0, 0)).toISOString();
const OLD_AT = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
const GENERATED_AT = NOW.toISOString();

const GROUPED = {
  success: true,
  data: {
    generatedAt: GENERATED_AT,
    groups: [
      {
        principleId: 'principle-today',
        principleTitle: '今天到的一条',
        status: 'pending',
        records: [{ id: 'apr-today-first', artifactId: 'artifact-today', channel: 'prompt', createdAt: TODAY_AT, status: 'pending' }],
      },
      {
        principleId: 'principle-leftover',
        principleTitle: '前几天留下的一条',
        status: 'pending',
        records: [{ id: 'apr-leftover-second', artifactId: 'artifact-leftover', channel: 'prompt', createdAt: OLD_AT, status: 'pending' }],
      },
    ],
  },
};

async function installMocks(page: Page): Promise<void> {
  // The e2e server runs --no-auth, which locks decisions by design. Patch the
  // readiness projection so the card renders its normal decision area.
  await page.route('**/api/governance/experience', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json?.data?.readiness) {
      json.data.readiness.authenticationMode = 'authenticated';
      json.data.readiness.ownerIdentityConfiguration = 'configured';
    }
    await route.fulfill({ response, json });
  });
  // Hermetic queue: one card from today and one leftover, fixed order.
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
}

test.describe('今天 entry', () => {
  test('a first visit starts the pass instead of rendering a dead 继续判断', async ({ page }) => {
    await installMocks(page);
    await page.goto('/#/focus');

    const entry = page.getByTestId('today-entry');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('今天有 1 条原则要判断。');
    await expect(page.getByTestId('today-resume')).toHaveCount(0);

    await page.getByTestId('today-start').click();

    await expect(page).toHaveURL(/\/#\/review\/a(%3A|:)apr-today-first/);
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-review-id', 'a:apr-today-first');
  });

  test('a same-day session still resumes at the first unhandled card', async ({ page }) => {
    await installMocks(page);
    await page.addInitScript(() => {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      localStorage.setItem('pd.review.session', JSON.stringify({
        date,
        queueIds: ['a:apr-today-first', 'a:apr-leftover-second'],
        currentIndex: 1,
        skippedIds: [],
        decisions: [{ id: 'a:apr-today-first', action: 'approve', at: now.toISOString() }],
        lastSeenAt: now.toISOString(),
      }));
    });
    await page.goto('/#/focus');

    const resume = page.getByTestId('today-resume');
    await expect(resume).toBeVisible();
    await expect(resume).toContainText('还剩 1 条没判断。');

    await page.getByTestId('today-continue').click();

    await expect(page).toHaveURL(/\/#\/review\/a(%3A|:)apr-leftover-second/);
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-review-id', 'a:apr-leftover-second');
  });
});
