import { test, expect, type Page } from '@playwright/test';

const auth = { Authorization: 'Bearer owner-e2e-token' };
async function login(page: Page) {
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForURL(/#\/(focus|welcome)$/);
  await expect(page.getByTestId('owner-workbench')).toBeVisible();
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

test('Two approvals in the same principle group keep independent success and refusal outcomes', async ({ page, request }) => {
  let firstPosts = 0;
  let secondPosts = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/apr-isolated-a/approve')) firstPosts++; });
  await page.route('**/api/v1/approvals/apr-isolated-b/reject', async route => {
    secondPosts++;
    expect(route.request().postDataJSON()).toMatchObject({ expectedReview: { approvalId: 'apr-isolated-b', artifactId: 'artifact-isolated-b' } });
    await route.fulfill({ status: 409, json: { success: false, error: 'This version requires another check.', reason: 'fixture_refusal', nextAction: 'Read the current version before deciding.' } });
  });
  await login(page);
  const grouped = await request.get('/api/v1/approvals/grouped', { headers: auth });
  const data: unknown = await grouped.json();
  if (!record(data) || !record(data.data) || !Array.isArray(data.data.groups)) throw new Error('Invalid grouped fixture');
  expect(data.data.groups.some(group => record(group) && Array.isArray(group.records)
    && group.records.some(row => record(row) && row.id === 'apr-isolated-a')
    && group.records.some(row => record(row) && row.id === 'apr-isolated-b'))).toBe(true);
  await page.locator('[data-item-key="approval:apr-isolated-a"]').click();
  await page.getByTestId('owner-work-reading').getByRole('button', { name: '批准这个版本', exact: true }).click();
  await expect(page.getByTestId('owner-work-reading')).toContainText('已批准');
  await page.locator('[data-item-key="approval:apr-isolated-b"]').click();
  await page.getByTestId('owner-work-reading').getByRole('button', { name: '拒绝这个版本', exact: true }).click();
  await page.getByLabel('请说明理由').fill('当前版本仍需核对。');
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.getByTestId('owner-work-reading')).toContainText('This version requires another check.');
  expect(firstPosts).toBe(1); expect(secondPosts).toBe(1);
  const first = await request.get('/api/v1/approvals/apr-isolated-a', { headers: auth });
  const second = await request.get('/api/v1/approvals/apr-isolated-b', { headers: auth });
  expect(await first.json()).toMatchObject({ data: { status: 'approved', artifactId: 'artifact-isolated-a' } });
  expect(await second.json()).toMatchObject({ data: { status: 'pending', artifactId: 'artifact-isolated-b' } });
});

test('A lost approval response is reconciled from persisted status without another approval POST', async ({ page, request }) => {
  let posts = 0;
  await page.route('**/api/v1/approvals/apr-lost-response/approve', async route => {
    posts++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('connectionreset');
  });
  await login(page);
  await page.locator('[data-item-key="approval:apr-lost-response"]').click();
  await page.getByTestId('owner-work-reading').getByRole('button', { name: '批准这个版本', exact: true }).click();
  await expect(page.getByTestId('owner-work-reading')).toContainText('当前已批准');
  await expect(page.getByTestId('owner-work-reading')).toContainText('已重新读取');
  await expect(page.getByTestId('owner-work-reading')).toContainText('实际激活与投递请查看生效情况');
  expect(posts).toBe(1);
  const persisted = await request.get('/api/v1/approvals/apr-lost-response', { headers: auth });
  expect(await persisted.json()).toMatchObject({ data: { status: 'approved' } });
  const runtime: unknown = await (await request.get('/api/v1/activations', { headers: auth })).json();
  if (!record(runtime) || !record(runtime.data) || !Array.isArray(runtime.data.activations)) throw new Error('Invalid activation fixture');
  expect(runtime.data.activations.some(row => record(row) && row.artifactId === 'artifact-lost-response' && row.status === 'active')).toBe(true);
});

test('Keyboard can open an exact item, read disclosures, submit and receive its result', async ({ page }) => {
  await login(page);
  const item = page.locator('[data-item-key="approval:apr-keyboard"]');
  await item.focus();
  await page.keyboard.press('Enter');
  const reading = page.getByTestId('owner-work-reading');
  await expect(reading.locator('h2')).toBeFocused();
  const approve = reading.getByRole('button', { name: '批准这个版本', exact: true });
  await expect(approve).toBeEnabled();
  let reached = false;
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab');
    reached = await approve.evaluate(element => element === document.activeElement);
    if (reached) break;
  }
  expect(reached).toBe(true);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/apr-keyboard/approve') && response.request().method() === 'POST');
  await page.keyboard.press('Enter');
  expect((await responsePromise).status()).toBe(200);
  await expect(reading).toContainText('已批准');
});


test('A refused rejection reports another completed approval without claiming the Owner rejection succeeded', async ({ page, request }) => {
  let posts = 0;
  await page.route('**/api/v1/approvals/apr-race/reject', async route => {
    posts++;
    const competing = await request.post('/api/v1/approvals/apr-race/approve', { headers: auth, data: {} });
    expect(competing.status()).toBe(200);
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    await route.fulfill({ response });
  });
  await login(page);
  await page.locator('[data-item-key="approval:apr-race"]').click();
  await page.getByTestId('owner-work-reading').getByRole('button', { name: '拒绝这个版本', exact: true }).click();
  await page.getByLabel('请说明理由').fill('我原本准备拒绝当前草案。');
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  const reading = page.getByTestId('owner-work-reading');
  await expect(reading).toContainText('本次操作未执行');
  await expect(reading).toContainText('当前已批准');
  await expect(reading).not.toContainText('已拒绝这个版本');
  await expect(reading.getByRole('heading', { name: '处理结果', exact: true })).toBeVisible();
  expect(posts).toBe(1);
  const persisted = await request.get('/api/v1/approvals/apr-race', { headers: auth });
  expect(await persisted.json()).toMatchObject({ data: { status: 'approved' } });
});
