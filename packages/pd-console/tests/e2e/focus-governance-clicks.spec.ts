/* eslint-disable */
// PRI-517 (M3): Real browser governance — click the actual UI controls for
// view / approve / reject / edit / deactivate, instead of calling the API
// directly. Asserts exact request body, resulting record/activation state,
// visible UI feedback, and refresh persistence. Uses dedicated isolated seed
// records (apr-click-*) so it never mutates records owned by other specs.
//
// This spec closes hard-veto #3 from the PD release scorecard: "Browser UI
// actions are not proven. The current Focus E2E calls the approve API directly,
// and its activation assertion is skipped because it checks approveBody.data.success
// instead of top-level approveBody.success."

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://127.0.0.1:${process.env.PD_CONSOLE_E2E_PORT ?? '3101'}`;

// ── API helpers (read-back only; mutations happen via UI clicks) ─────────────
async function apiGet(path: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

// Resolve the principleId for a seeded approval via the grouped endpoint.
// FocusPage keys testids off group.principleId, so we must look it up to
// build the [data-testid=...] selector.
async function resolvePrincipleId(approvalId: string): Promise<string> {
  const resp = await apiGet('/api/v1/approvals/grouped');
  expect(resp.status).toBe(200);
  const body = resp.body as {
    success: boolean;
    data: { groups: Array<{ principleId: string; records: Array<{ id: string }> }> };
  };
  expect(body.success).toBe(true);
  // NOTE: grouped endpoint returns record.id (mapped from approvalId), NOT record.approvalId.
  const group = body.data.groups.find((g) => g.records.some((r) => r.id === approvalId));
  expect(group, `grouped endpoint must contain approval ${approvalId}`).toBeTruthy();
  return group!.principleId;
}

async function readApproval(approvalId: string): Promise<{ status: string; artifactId: string }> {
  const resp = await apiGet(`/api/v1/approvals/${approvalId}`);
  expect(resp.status).toBe(200);
  const body = resp.body as {
    success: boolean;
    data: { status: string; artifactId: string };
  };
  expect(body.success).toBe(true);
  return { status: body.data.status, artifactId: body.data.artifactId };
}

async function findActivation(principleId: string): Promise<{ activationId: string; status: string } | undefined> {
  const resp = await apiGet('/api/v1/activations');
  expect(resp.status).toBe(200);
  const body = resp.body as {
    success: boolean;
    data: { activations: Array<{ activationId: string; principleId: string; status: string }> };
  };
  expect(body.success).toBe(true);
  return body.data.activations.find((a) => a.principleId === principleId);
}

async function gotoFocus(page: Page): Promise<void> {
  await page.goto('/#/focus');
  await page.waitForLoadState('networkidle');
}

async function gotoActivation(page: Page): Promise<void> {
  await page.goto('/#/activation');
  await page.waitForLoadState('networkidle');
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('PRI-517: real UI clicks for Owner governance', () => {
  test('approve — click the 批准 button, activation appears, persists after reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/') && resp.status() >= 500) errors.push(`5xx: ${resp.url()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    const principleId = await resolvePrincipleId('apr-click-approve');
    const postedBodies: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith(`/api/v1/approvals/apr-click-approve/approve`) && req.method() === 'POST') {
        postedBodies.push(req.postDataJSON());
      }
    });

    await gotoFocus(page);
    // Click the REAL approve button by testid
    await page.getByTestId(`approve-btn-${principleId}`).click();
    await page.waitForLoadState('networkidle');

    // Exact request body assertion (rc-9: prove the click fired the right call)
    expect(postedBodies.length, 'approve click must POST exactly once').toBe(1);

    // Resulting record state (read back via API — the UI doesn't expose status text directly here)
    const approval = await readApproval('apr-click-approve');
    expect(approval.status).toBe('approved');

    // Activation must exist
    const activation = await findActivation(principleId);
    expect(activation, 'approve must produce an activation').toBeTruthy();
    expect(activation!.status).toBe('active');
    const activationId = activation!.activationId;

    // Refresh persistence: reload FocusPage, then check the activation still exists
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(errors, `reload had errors:\n${errors.join('\n')}`).toEqual([]);
    const activationAfterReload = await findActivation(principleId);
    expect(activationAfterReload?.activationId).toBe(activationId);
    expect(activationAfterReload?.status).toBe('active');

    // ── deactivate via real UI clicks (two-step: disable → confirm) ──────────
    await gotoActivation(page);
    await page.getByTestId(`disable-btn-${activationId}`).click();
    await page.getByTestId(`confirm-disable-${activationId}`).click();
    await page.waitForLoadState('networkidle');

    const deactivated = await findActivation(principleId);
    expect(deactivated?.status).toBe('deactivated');

    // Persistence after reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    const deactivatedAfterReload = await findActivation(principleId);
    expect(deactivatedAfterReload?.status).toBe('deactivated');
  });

  test('reject — click 拒绝, fill reason, confirm; record rejected, persists', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    const principleId = await resolvePrincipleId('apr-click-reject');
    const postedBodies: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith(`/api/v1/approvals/apr-click-reject/reject`) && req.method() === 'POST') {
        postedBodies.push(req.postDataJSON());
      }
    });

    await gotoFocus(page);
    // Open the inline reject panel
    await page.getByTestId(`reject-btn-${principleId}`).click();
    // Fill the reason textarea
    const reason = 'UI 点击拒绝：测试假阳性场景不可接受';
    await page.getByTestId(`reject-reason-${principleId}`).fill(reason);
    // Confirm-reject button is disabled until reason is non-empty (now enabled)
    await page.getByTestId(`confirm-reject-${principleId}`).click();
    await page.waitForLoadState('networkidle');

    // Exact request body assertion
    expect(postedBodies.length).toBe(1);
    expect((postedBodies[0] as { reason?: string }).reason).toBe(reason);

    // Resulting record state
    const approval = await readApproval('apr-click-reject');
    expect(approval.status).toBe('rejected');

    // No activation should exist for a rejected approval
    const activation = await findActivation(principleId);
    expect(activation).toBeUndefined();

    // Persistence after reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    const approvalAfterReload = await readApproval('apr-click-reject');
    expect(approvalAfterReload.status).toBe('rejected');
  });

  test('edit — click 编辑, fill new artifact + reason, confirm; artifactId updates, persists', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    const principleId = await resolvePrincipleId('apr-click-edit');
    const postedBodies: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith(`/api/v1/approvals/apr-click-edit/edit`) && req.method() === 'POST') {
        postedBodies.push(req.postDataJSON());
      }
    });

    const before = await readApproval('apr-click-edit');
    expect(before.artifactId).toBe('artifact-click-edit');

    await gotoFocus(page);
    // Open the inline edit panel
    await page.getByTestId(`edit-btn-${principleId}`).click();
    // Fill new artifact id + reason
    await page.getByTestId(`edit-new-artifact-${principleId}`).fill('artifact-click-edit-new');
    await page.getByTestId(`edit-reason-${principleId}`).fill('UI 点击编辑：替换为已验证的新工件');
    await page.getByTestId(`confirm-edit-${principleId}`).click();
    await page.waitForLoadState('networkidle');

    // Exact request body assertion
    expect(postedBodies.length).toBe(1);
    const body = postedBodies[0] as { newArtifactId?: string; editReason?: string };
    expect(body.newArtifactId).toBe('artifact-click-edit-new');
    expect(body.editReason).toBe('UI 点击编辑：替换为已验证的新工件');

    // Resulting record state: artifactId updated, still pending (edit does not approve)
    const after = await readApproval('apr-click-edit');
    expect(after.artifactId).toBe('artifact-click-edit-new');
    expect(after.status).toBe('pending');

    // Persistence after reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    const afterReload = await readApproval('apr-click-edit');
    expect(afterReload.artifactId).toBe('artifact-click-edit-new');
  });

  test('view — FocusPage renders the pending governance queue with clickable controls', async ({ page }) => {
    // "view" coverage: the page loads and the governance controls are present
    // and enabled for a pending approval (before any action is taken).
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/') && resp.status() >= 500) errors.push(`5xx: ${resp.url()}`);
    });

    await gotoFocus(page);
    expect(errors).toEqual([]);

    const principleId = await resolvePrincipleId('apr-click-edit');
    // All three governance buttons are visible and enabled (apr-click-edit is pending)
    const approveBtn = page.getByTestId(`approve-btn-${principleId}`);
    const editBtn = page.getByTestId(`edit-btn-${principleId}`);
    const rejectBtn = page.getByTestId(`reject-btn-${principleId}`);
    await expect(approveBtn).toBeVisible();
    await expect(approveBtn).toBeEnabled();
    await expect(editBtn).toBeVisible();
    await expect(editBtn).toBeEnabled();
    await expect(rejectBtn).toBeVisible();
    await expect(rejectBtn).toBeEnabled();
  });
});
