// @vitest-environment jsdom
/**
 * B2 regression: a finished session must not hide entries that arrived after
 * the session started.
 *
 * The old page treated `session.queueIds.slice(currentIndex)` as the remaining
 * set, so one new decision after finishing the day rendered "今天已完成" while
 * the server queue still had a card. The remaining set now comes from the
 * server queue minus what this session already handled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { newItem, tStub, i18nStub } = vi.hoisted(() => {
  const createdAt = new Date().toISOString();
  const record = { id: 'apr-new', artifactId: 'artifact-new', channel: 'prompt', createdAt, status: 'pending' };
  return {
    newItem: {
      id: 'a:apr-new',
      kind: 'approval' as const,
      title: '新到的一条',
      createdAt,
      approval: {
        group: { principleId: 'principle-new', principleTitle: '新到的一条', status: 'pending', records: [record] },
        record,
      },
    },
    tStub: (key: string, options?: Record<string, unknown>) => {
      if (key === 'pages.today.remaining') return `还剩 ${String(options?.count)} 条没判断。`;
      if (key === 'pages.today.finished.title') return `今天已经处理了 ${String(options?.count)} 条。`;
      return options?.defaultValue !== undefined ? String(options.defaultValue) : key;
    },
    i18nStub: { language: 'zh-CN' },
  };
});

vi.mock('../../src/ui/pages/review/review-data.js', () => ({
  loadReviewData: vi.fn(async () => ({
    items: [newItem],
    unavailable: [],
    fatal: null,
    lockedReason: null,
    generatedAt: new Date(),
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
}));

afterEach(cleanup);

describe('Today entry after a finished session', () => {
  it('offers the newly arrived card instead of claiming the day is finished', async () => {
    const { TodayPage } = await import('../../src/ui/pages/today/TodayPage.js');
    const { writeReviewSession, localDateKey } = await import('../../src/ui/pages/review/review-session.js');
    const now = new Date();
    writeReviewSession({
      date: localDateKey(now),
      // The completed session only knows the card it already approved.
      queueIds: ['a:apr-done'],
      currentIndex: 1,
      skippedIds: [],
      decisions: [{ id: 'a:apr-done', action: 'approve', at: now.toISOString() }],
      lastSeenAt: now.toISOString(),
    });

    render(createElement(MemoryRouter, null, createElement(TodayPage, {})));

    const resume = await screen.findByTestId('today-resume');
    expect(resume.textContent).toContain('还剩 1 条');
    expect(screen.queryByTestId('today-finished')).toBeNull();
  });
});
