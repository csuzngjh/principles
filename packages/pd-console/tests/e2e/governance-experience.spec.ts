/**
 * PRI-586 E2E — Governance Experience Snapshot user flow (SPEC v1.5.1 Phase 5):
 *
 *   Open Console → understand current state → know required action →
 *   complete a governance action.
 *
 * The seed enables governance_experience_v1, so Focus runs in experience mode.
 * Assertions prove the snapshot is the single governance status source AND that
 * the mutation path still works through the (unchanged) approvals endpoint.
 */
import { test, expect } from '@playwright/test';

test('governance experience snapshot serves and drives Focus', async ({ page }) => {
  // ── 1. Understand current state: the API serves one schema-valid snapshot ──
  const resp = await page.request.get('/api/v1/governance/experience');
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as {
    success: boolean;
    data: {
      schemaVersion: string;
      snapshotId: string;
      summary: { primaryAttention: string; reasonCode: string; nextActionCode: string };
      readiness: { governanceActions: { kind: string; observedAuthority: string; status: string }[] };
      trustContext: { environmentContext: { environment: string } };
    };
  };
  expect(body.success).toBe(true);
  expect(body.data.schemaVersion).toBe('1');
  expect(body.data.snapshotId).toMatch(/^gov-exp:[0-9a-f]+:\d{4}-\d{2}-\d{2}T/);
  // Seeded workspace has pending approvals → the owner must decide.
  expect(body.data.summary.primaryAttention).toBe('owner_decision_required');
  expect(body.data.summary.reasonCode).toBe('governance.exp.reason.approval_pending');
  // Readiness explains the real entries (SPEC §6.4).
  const principleApproval = body.data.readiness.governanceActions.find(action => action.kind === 'principle_approval');
  expect(principleApproval?.observedAuthority).toBe('operator_legacy');
  // PRI-587: the seeded workspace environment flows into trust context.
  expect(body.data.trustContext.environmentContext.environment).toBe('test');

  // ── 2. Open the Console: the Focus page renders the snapshot, not the queue ──
  // Pin the UI language to en so the text assertions below are deterministic
  // (default locale is zh-CN).
  await page.addInitScript(() => localStorage.setItem('pd-language', 'en'));
  await page.goto('/#/focus');
  await expect(page.getByTestId('experience-summary')).toBeVisible();
  await expect(page.getByTestId('experience-reason')).toContainText('waiting for your decision');
  await expect(page.getByTestId('experience-readiness')).toContainText('Owner identity');
  await expect(page.getByTestId('experience-trust')).toContainText('Environment: test');

  // ── 3. Know the required action: decision cards are still the action surface ──
  // apr-experience-1 is an isolated seed record dedicated to this spec (valid
  // prompt-channel artifact → approving activates cleanly), so the spec stays
  // deterministic in a full serial run.
  const grouped = await page.request.get('/api/v1/approvals/grouped');
  const groupedBody = (await grouped.json()) as { success: boolean; data: { groups: { principleId: string; status: string; records: { id: string }[] }[] } };
  expect(groupedBody.success).toBe(true);
  const group = groupedBody.data.groups.find(g => g.records.some(record => record.id === 'apr-experience-1'));
  expect(group, 'seeded workspace must contain the apr-experience-1 approval group').toBeDefined();
  const principleId = group!.principleId;

  // ── 4. Complete a governance action: approve through the real UI button ──
  const pending = await page.request.get('/api/v1/approvals?status=pending');
  const pendingBody = (await pending.json()) as { data: { items: unknown[] } };
  const pendingCount = pendingBody.data.items.length;
  expect(pendingCount).toBeGreaterThan(0);
  const approveButton = page.locator(`[data-testid="approve-btn-${principleId}"]`).first();
  await expect(approveButton).toBeVisible();
  // The group decision fans out per record; wait for the apr-prompt-1 POST to
  // complete (approval writes an activation and can outlive networkidle).
  const approveResponsePromise = page.waitForResponse(
    response => response.url().endsWith('/api/v1/approvals/apr-experience-1/approve') && response.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await approveButton.click();
  const approveResponse = await approveResponsePromise;
  expect(approveResponse.status()).toBe(200);
  // The decision lands in the ledger (read-back through the API).
  const approvalsAfter = await page.request.get('/api/v1/approvals?status=pending');
  const afterBody = (await approvalsAfter.json()) as { data: { items: unknown[] } };
  expect(afterBody.data.items.length).toBeLessThan(pendingCount);
});
