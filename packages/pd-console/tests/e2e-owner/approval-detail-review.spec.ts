import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForURL(/#\/(focus|welcome)$/);
}
const authorization = { Authorization: 'Bearer owner-e2e-token' };

test('Principle detail rejects the exact reviewed approval through the guarded reader', async ({ page, request }) => {
  await login(page);
  await page.goto('/#/principles/e2e00000-0000-4000-8000-000000000009');
  const reading = page.getByTestId('detail-approval-review');
  await reading.locator(':scope > summary').click();
  await reading.getByRole('button', { name: '拒绝这个版本', exact: true }).click();
  await reading.getByLabel('请说明理由').fill('这条建议尚不符合我的原意。');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/apr-click-reject/reject') && response.request().method() === 'POST');
  await reading.getByRole('button', { name: '确认提交', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ expectedReview: { schemaVersion: 'approval-review-v1', approvalId: 'apr-click-reject', artifactId: 'artifact-click-reject', artifactState: 'present' } });
  const persisted = await request.get('/api/v1/approvals/apr-click-reject', { headers: authorization });
  expect(await persisted.json()).toMatchObject({ data: { status: 'rejected' } });
  await expect(page.getByTestId('owner-decision-history')).toContainText('已拒绝');
});

test('Principle detail replacement carries the reviewed old version and reads the replacement before another decision', async ({ page, request }) => {
  await login(page);
  await page.goto('/#/principles/e2e00000-0000-4000-8000-00000000000a');
  const reading = page.getByTestId('detail-approval-review');
  await reading.locator(':scope > summary').click();
  await reading.getByRole('button', { name: '替换待审版本', exact: true }).click();
  await reading.getByLabel('已验证的新草案标识').fill('artifact-click-edit-new');
  await reading.getByLabel('请说明理由').fill('替换为已验证的修订稿，再重新阅读。');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/apr-click-edit/edit') && response.request().method() === 'POST');
  await reading.getByRole('button', { name: '确认提交', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ newArtifactId: 'artifact-click-edit-new', expectedReview: { approvalId: 'apr-click-edit', artifactId: 'artifact-click-edit', artifactState: 'present' } });
  const persisted = await request.get('/api/v1/approvals/apr-click-edit', { headers: authorization });
  expect(await persisted.json()).toMatchObject({ data: { status: 'pending', artifactId: 'artifact-click-edit-new' } });
  await expect(reading).toContainText('已替换待审版本');
});


test('A grouped approval read failure keeps the pending decision visible with a retry', async ({ page }) => {
  await page.route('**/api/v1/approvals/grouped*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'grouped_unavailable' }) }));
  await login(page);
  await page.goto('/#/principles/e2e00000-0000-4000-8000-00000000000a');
  const alert = page.getByTestId('detail-approvals-unavailable');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('部分审批材料未能读取');
  await expect(alert.getByRole('button', { name: '重新读取', exact: true })).toBeVisible();
  // The decision view still knows about the pending approval; the alert
  // explains why its reading surface is absent instead of hiding it silently.
  await expect(page.getByTestId('owner-decision-view')).toBeVisible();
});

test('A late detail read cannot replace the newly selected principle', async ({ page }) => {
  await login(page);
  let started: (() => void) | undefined;
  const requested = new Promise<void>(resolveRequested => { started = resolveRequested; });
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  await page.route('**/api/principles/e2e00000-0000-4000-8000-000000000009', async route => {
    const response = await route.fetch();
    started?.(); await held;
    await route.fulfill({ response });
  });
  try {
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/principles/e2e00000-0000-4000-8000-000000000009'));
    await page.goto('/#/principles/e2e00000-0000-4000-8000-000000000009');
    await requested;
    await page.evaluate(() => { window.location.hash = '/principles/e2e00000-0000-4000-8000-00000000000a'; });
    await expect(page.locator('h1')).toContainText('点击编辑测试原则');
    release?.();
    await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
    await expect(page.locator('h1')).toContainText('点击编辑测试原则');
    await expect(page.getByTestId('owner-decision-view')).not.toContainText('点击拒绝测试原则');
  } finally { release?.(); }
});
