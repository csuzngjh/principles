/**
 * PRI-1238 / SPEC-PD-INTENT-UNIFICATION-001 §11.9 — browser acceptance for the
 * three UNEXEMPTABLE conflict classes on the real Approval review card.
 *
 * The fixtures (e2e-seed.ts, owner suite only) carry a confirmed conflict
 * against: non_negotiables, stop_escalation, and a registered core principle.
 * For each class the Owner must see the SPECIFIC conflict target, the approve
 * button must be fenced, reject must stay available, no raw reason strings or
 * i18n keys may leak — and the SERVER must actually refuse the write (the UI
 * is not the gate). A confirm_drift decision must NOT lift any of them.
 */

import { expect, test, type Page } from '@playwright/test';

const BLOCK_COPY = {
  nn: '不可妥协项',
  se: '止损/升级',
} as const;

async function openApproval(page: Page, approvalId: string): Promise<void> {
  await page.goto(`/#/review/a%3A${approvalId}`);
  await expect(page.getByTestId('review-card')).toBeVisible({ timeout: 15000 });
}

async function capture(page: Page, name: string): Promise<void> {
  const dir = process.env.PRI1238_SCREENSHOT_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.describe.serial('PRI-1238 unexemptable conflict classes on the approval card', () => {
  test('non_negotiables conflict: fence + accurate target + unresolvable hint', async ({ page }) => {
    await openApproval(page, 'apr-intent-boundary-nn');

    const blocked = page.getByTestId('review-approve-blocked');
    await expect(blocked).toBeVisible();
    // The Owner copy names the boundary, not a vague label.
    await expect(blocked).toContainText('不可妥协项');

    // SPEC §11.9: the SPECIFIC conflict target is shown.
    const targets = page.getByTestId('review-conflict-targets');
    await expect(targets).toBeVisible();
    await expect(targets.getByTestId('review-conflict-target')).toContainText(BLOCK_COPY.nn);

    // A boundary is not a trade-off — confirm_drift cannot lift it.
    await expect(page.getByTestId('review-approve-blocked-unresolvable')).toBeVisible();

    await expect(page.getByTestId('review-approve')).toBeDisabled();
    await expect(page.getByTestId('review-reject')).toBeEnabled();

    // No raw machine strings / i18n keys leak into the card.
    const card = page.getByTestId('review-card');
    await expect(card).not.toContainText('owner_boundary_conflict');
    await expect(card).not.toContainText('pages.review.');
    await capture(page, 'boundary-non-negotiables');
  });

  test('stop_escalation conflict: fence + accurate target + unresolvable hint', async ({ page }) => {
    await openApproval(page, 'apr-intent-boundary-se');

    const blocked = page.getByTestId('review-approve-blocked');
    await expect(blocked).toBeVisible();
    const targets = page.getByTestId('review-conflict-targets');
    await expect(targets).toBeVisible();
    await expect(targets.getByTestId('review-conflict-target')).toContainText(BLOCK_COPY.se);
    await expect(page.getByTestId('review-approve-blocked-unresolvable')).toBeVisible();
    await expect(page.getByTestId('review-approve')).toBeDisabled();
    await expect(page.getByTestId('review-reject')).toBeEnabled();
    await capture(page, 'boundary-stop-escalation');
  });

  test('core_principle conflict: fence + named principle target + unresolvable hint', async ({ page }) => {
    await openApproval(page, 'apr-intent-core-principle');

    const blocked = page.getByTestId('review-approve-blocked');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('核心原则');

    const targets = page.getByTestId('review-conflict-targets');
    await expect(targets).toBeVisible();
    // The registered core principle id is the locatable target.
    await expect(targets.getByTestId('review-conflict-target')).toContainText('T-01');
    await expect(page.getByTestId('review-approve-blocked-unresolvable')).toBeVisible();
    await expect(page.getByTestId('review-approve')).toBeDisabled();
    await expect(page.getByTestId('review-reject')).toBeEnabled();

    const card = page.getByTestId('review-card');
    await expect(card).not.toContainText('core_principle_conflict');
    await expect(card).not.toContainText('pages.review.');
    await capture(page, 'core-principle');
  });

  for (const case_ of [
    { name: 'non_negotiables', approvalId: 'apr-intent-boundary-nn' },
    { name: 'stop_escalation', approvalId: 'apr-intent-boundary-se' },
    { name: 'core_principle', approvalId: 'apr-intent-core-principle' },
  ] as const) {
    test(`server refuses the ${case_.name} approval (UI is not the gate)`, async ({ page }) => {
      const response = await page.request.post(`/api/approvals/${case_.approvalId}/approve`, {
        data: {},
        headers: { 'Content-Type': 'application/json' },
      });
      expect(response.status()).toBe(422);
      const body: unknown = await response.json();
      const text = JSON.stringify(body);
      expect(text).toMatch(/owner_boundary_conflict|core_principle_conflict|strategic/);

      // The approval stays pending — the fence survives the refusal.
      await openApproval(page, case_.approvalId);
      await expect(page.getByTestId('review-approve-blocked')).toBeVisible();
    });
  }

  // CodeRabbit PR #2684 review: the former browser "confirm_drift does not
  // lift the boundary fence" test was VACUOUS — an unbound decision (no
  // candidateId/contractDigest) can never clear ANY conflict, so it stayed
  // green even if the gate wrongly exempted boundaries. The unexemptable-ness
  // contract is owned by the core gate tests with properly-BOUND resolutions:
  // packages/principles-core/src/runtime/activation/__tests__/
  //   approval-strategic-conflict-gate.test.ts:518 (non_negotiables),
  //   :540 (stop_escalation), :607 — plus the server-refusal tests above,
  //   which prove the real write path refuses these classes.
});
