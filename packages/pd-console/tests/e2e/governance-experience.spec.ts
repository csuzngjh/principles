/**
 * PRI-586 E2E — Governance Experience Snapshot user flow (SPEC v1.5.1 Phase 5):
 *
 *   Open Console → understand current state → know required action →
 *   follow the configuration recovery action when governance is not authenticated.
 *
 * The seed enables governance_experience_v1, so Focus runs in experience mode.
 * Assertions prove the snapshot is the single governance status source and
 * that Focus routes a blocked Owner to the configuration authority.
 */
import { test, expect } from '@playwright/test';

test('governance experience snapshot serves Focus and routes its recovery action', async ({ page }) => {
  // ── 1. Understand current state: the API serves one schema-valid snapshot ──
  const resp = await page.request.get('/api/governance/experience');
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
  // PRI-1139: the live server stamps the version-neutral 'current' (legacy
  // '1' remains a valid read for pre-cutover payloads).
  expect(body.data.schemaVersion).toBe('current');
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
  // Request contract (maintainer review round): in experience mode governance
  // STATUS comes solely from the snapshot — the queue endpoint is never
  // requested — while approvals/activations remain loaded as ACTION surfaces.
  const apiRequests: string[] = [];
  page.on('request', (req) => {
    const pathname = new URL(req.url()).pathname;
    if (pathname.startsWith('/api/')) apiRequests.push(pathname);
  });
  await page.goto('/#/workbench');
  // 004 keeps runtime status available on demand, outside the primary task flow.
  await page.getByTestId('focus-runtime-records').locator(':scope > summary').click();
  await expect(page.getByTestId('experience-summary')).toBeVisible();
  expect(apiRequests).toContain('/api/governance/experience');
  // B1-01 removed the polling notification provider, so the Focus data load is
  // now the only legitimate source of /governance/queue traffic. More than one
  // request means a regression re-introduced the legacy status fetch or a poll.
  const queueRequests = apiRequests.filter(pathname => pathname.startsWith('/api/governance/queue'));
  expect(queueRequests.length).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('experience-reason')).toContainText('waiting for your decision');
  await expect(page.getByTestId('experience-trust')).toContainText('Environment: test');
  // The seed has a registered Owner identity, and the local OS session is the
  // credential: governance is ready, so the recovery guide must NOT appear.
  await expect(page.getByTestId('owner-configure-guide')).toHaveCount(0);
});
