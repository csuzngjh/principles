// @vitest-environment jsdom
/**
 * SPEC-PD-UIUX-002 §6 (1C) — the decision page must not push the Owner toward
 * approving material it could not read.
 *
 * Owner decision #1 (2026-11-11): when any material is missing, 「批准」 is
 * disabled and the primary button becomes 「查看缺什么」, which must actually
 * move focus to the gap list (not just be a greyed-out dead end).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApprovalSubjectReading } from '../../src/ui/pages/focus/ApprovalSubjectReading.js';

const { mockFetchApprovalReview, mockFetchOwnerDecisionView, tStub } = vi.hoisted(() => ({
  mockFetchApprovalReview: vi.fn(),
  mockFetchOwnerDecisionView: vi.fn(),
  tStub: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));

vi.mock('../../src/ui/api.js', () => ({
  fetchApprovalReview: (...args: unknown[]) => mockFetchApprovalReview(...args),
  fetchOwnerDecisionView: (...args: unknown[]) => mockFetchOwnerDecisionView(...args),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
  editApproval: vi.fn(),
  fetchAllActivations: vi.fn(async () => ({ success: false })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: { language: 'en' } }),
}));

afterEach(cleanup);

beforeEach(() => {
  // jsdom does not implement scrollIntoView; the reveal action calls it.
  Element.prototype.scrollIntoView = vi.fn();
  mockFetchOwnerDecisionView.mockResolvedValue({ success: false });
  mockFetchApprovalReview.mockResolvedValue({
    success: true,
    data: {
      approval: { status: 'pending' },
      expectedReview: { artifactId: 'art-1', channel: 'prompt', artifactState: 'missing' },
      material: {
        availability: 'missing',
        artifactId: 'art-1',
        statement: null,
        rationale: null,
        targetBehavior: null,
        scope: [],
        risks: null,
        exactBody: null,
      },
    },
  });
});

function renderReading() {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(ApprovalSubjectReading, {
        principleId: 'p-1',
        approvalId: 'a-1',
        artifactId: 'art-1',
        channel: 'prompt',
        allowedActions: ['approve', 'reject', 'edit_approval'],
      }),
    ),
  );
}

describe('ApprovalSubjectReading — incomplete material (1C / Owner decision #1)', () => {
  it('disables approve and makes 「查看缺什么」 the primary action', async () => {
    renderReading();
    const bar = await screen.findByTestId('approval-decision-bar');
    expect(bar.getAttribute('data-primary-action')).toBe('look_at_gaps');

    const approve = screen.getByTestId('approve-btn-p-1');
    expect(approve).toHaveProperty('disabled', true);

    const viewMissing = screen.getByTestId('view-missing-btn-p-1');
    expect(viewMissing).toHaveProperty('disabled', false);
    expect(screen.getByTestId('approval-gaps')).toBeTruthy();
  });

  it('moves focus to the gap list when 「查看缺什么」 is pressed', async () => {
    renderReading();
    await screen.findByTestId('approval-decision-bar');
    fireEvent.click(screen.getByTestId('view-missing-btn-p-1'));
    expect(document.activeElement).toBe(screen.getByTestId('approval-gaps'));
    // Every listed gap is anchored so the Owner can see what is missing.
    const gaps = screen.getByTestId('approval-gaps').querySelectorAll('[data-gap-key]');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].id).toMatch(/^approval-gap-/);
  });
});
