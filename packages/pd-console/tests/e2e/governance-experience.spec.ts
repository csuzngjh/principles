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
  // Request contract (maintainer review round): in experience mode governance
  // STATUS comes solely from the snapshot — the queue endpoint is never
  // requested — while approvals/activations remain loaded as ACTION surfaces.
  const apiRequests: string[] = [];
  page.on('request', (req) => {
    const pathname = new URL(req.url()).pathname;
    if (pathname.startsWith('/api/')) apiRequests.push(pathname);
  });
  await page.goto('/#/focus');
  await expect(page.getByTestId('experience-summary')).toBeVisible();
  expect(apiRequests).toContain('/api/v1/governance/experience');
  // Exactly ONE /governance/queue request is permitted: the NotificationProvider's
  // mount-time badge poll (global notification subsystem — migration deferred to
  // PRI-589 because badge semantics need a product decision). FocusPage itself
  // must add none: a regression that re-introduces the legacy status fetch in the
  // Focus data load pushes this count above 1 and fails here.
  const queueRequests = apiRequests.filter(pathname => pathname.startsWith('/api/v1/governance/queue'));
  expect(queueRequests.length).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('experience-reason')).toContainText('waiting for your decision');
  await expect(page.getByTestId('experience-trust')).toContainText('Environment: test');
  // PRI-629 moved readiness detail into the contextual recovery guide. This
  // seed has an identity but no Console token authentication, so the Owner
  // gets a direct route to the configuration authority instead of an inert
  // status field.
  const configureGuide = page.getByTestId('owner-configure-guide');
  await expect(configureGuide).toContainText('enable Console token authentication');
  const settingsLink = configureGuide.getByRole('link');
  await expect(settingsLink).toHaveAttribute('href', '#/settings');
  await settingsLink.click();
  await expect(page).toHaveURL(/#\/settings$/);
});
