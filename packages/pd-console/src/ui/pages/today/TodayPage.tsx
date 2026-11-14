/**
 * 今天 — the only daily entry.
 *
 * REVIEW_SESSION_SPEC §2.1: one factual count, when the Owner last finished,
 * and one button. No dashboard, no chart, no blocked-work counter, no badge:
 * the number states a fact, it does not summon the Owner (DESIGN_BRIEF D2/D3).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { FreshnessStamp } from '../../components/layout/freshness-stamp.js';
import { StatePanel } from '../../components/ui/state-panel.js';
import { Button } from '../../components/ui/button.js';
import { formatDate } from '../../utils/format-date.js';
import { loadReviewData, type ReviewLoadResult } from '../review/review-data.js';
import { daysWaiting, splitReviewQueue, type ReviewItem } from '../review/review-items.js';
import {
  countDecisions,
  isSessionForToday,
  localDateKey,
  readLastCompletedAt,
  readReviewSession,
  writeReviewSession,
  type ReviewSession,
} from '../review/review-session.js';

export interface TodayPageProps {
  featureFlags?: Record<string, { enabled: boolean } | undefined>;
}

function openSession(ordered: readonly ReviewItem[]): ReviewSession {
  const now = new Date();
  return {
    date: localDateKey(now),
    queueIds: ordered.map((item) => item.id),
    currentIndex: 0,
    skippedIds: [],
    decisions: [],
    lastSeenAt: now.toISOString(),
  };
}

export function TodayPage({ featureFlags }: TodayPageProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [result, setResult] = useState<ReviewLoadResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const loaded = await loadReviewData({ featureFlags, t });
      if (loaded.fatal !== null) {
        setErrorMessage(loaded.fatal);
        setStatus('error');
        return;
      }
      setResult(loaded);
      setStatus('ready');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('pages.today.error'));
      setStatus('error');
    }
  }, [featureFlags, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === 'loading') {
    return (
      <PageShell>
        <PageLoading cardCount={1} label={t('common.loading')} slowLabel={t('pages.today.loading')} />
      </PageShell>
    );
  }

  if (status === 'error' || result === null) {
    return (
      <PageShell>
        <h1 className="mb-4 text-title font-semibold text-ink">{t('pages.today.heading')}</h1>
        <StatePanel
          kind="unreachable"
          title={t('pages.today.error')}
          technical={errorMessage ?? undefined}
          action={{ label: t('common.retry'), onClick: () => { void load(); } }}
          testId="today-error-state"
        />
      </PageShell>
    );
  }

  const queue = splitReviewQueue(result.items);
  const storedSession = readReviewSession();
  const session = isSessionForToday(storedSession) ? storedSession : null;
  // The server queue is the source of truth for what is still readable today.
  // The stored session only supplies ordering/resume position — never the
  // remaining set. Using the session queue to crop the list hid items that
  // arrived after the session started and let the page claim the day was
  // finished while the queue still had entries.
  const handled = new Set<string>(
    session === null ? [] : [...session.decisions.map((entry) => entry.id), ...session.skippedIds],
  );
  const unhandledItems = queue.ordered.filter((item) => !handled.has(item.id));
  const queueIndex = new Map(queue.ordered.map((item, index) => [item.id, index]));
  const resumeRank = (itemId: string): number => {
    if (session === null) return Number.MAX_SAFE_INTEGER;
    const index = session.queueIds.indexOf(itemId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const resumableIdList = [...unhandledItems]
    .sort((a, b) => resumeRank(a.id) - resumeRank(b.id) || (queueIndex.get(a.id) ?? 0) - (queueIndex.get(b.id) ?? 0))
    .map((item) => item.id);
  const unhandledIds = new Set(unhandledItems.map((item) => item.id));
  const lastCompletedAt = readLastCompletedAt();
  const counts = session !== null ? countDecisions(session) : null;
  const handledCount = session !== null ? session.decisions.length + session.skippedIds.length : 0;
  // Deferred entries stay pending on the server, so "finished" cannot require
  // an empty server queue — it requires nothing left that this session has not
  // already handled. Deferred entries are re-openable from the finished page.
  const finishedToday = session !== null && unhandledItems.length === 0 && handledCount > 0;

  const todayRemaining = queue.today.filter((item) => unhandledIds.has(item.id));
  const leftoverRemaining = queue.leftover.filter((item) => unhandledIds.has(item.id));
  const orderedRemaining = [...todayRemaining, ...leftoverRemaining];
  const deferredItems = session === null
    ? []
    : queue.ordered.filter((item) => session.skippedIds.includes(item.id));
  const oldestLeftover = leftoverRemaining.reduce<ReviewItem | null>(
    (oldest, item) => (oldest === null || new Date(item.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? item : oldest),
    null,
  );

  function writeAndGo(ordered: readonly ReviewItem[]): void {
    if (ordered.length === 0) return;
    const next = openSession(ordered);
    writeReviewSession(next);
    navigate(`/review/${encodeURIComponent(next.queueIds[0]!)}`);
  }

  function resume(): void {
    if (session === null || resumableIdList.length === 0) return;
    writeReviewSession({ ...session, lastSeenAt: new Date().toISOString() });
    navigate(`/review/${encodeURIComponent(resumableIdList[0]!)}`);
  }

  function reviewDeferred(): void {
    if (session === null || counts === null) return;
    writeAndGo(deferredItems);
  }

  const lastSeenLine = lastCompletedAt !== null && (
    <p className="mt-2 text-body text-ink-3">
      {t('pages.today.lastSeen', {
        time: formatDate(lastCompletedAt, i18n.language, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      })}
    </p>
  );

  return (
    <PageShell width="wide" className="today-spread">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <header className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-2 lg:mb-6">
          <h1 className="text-subtitle font-semibold text-ink">{t('pages.today.heading')}</h1>
          <FreshnessStamp at={result.generatedAt} />
        </header>

        {finishedToday && counts !== null ? (
          <div data-testid="today-finished">
            <p className="today-headline">
              {t('pages.today.finished.title', { count: counts.approved + counts.rejected + counts.deferred })}
            </p>
            <p className="mt-2 text-body leading-relaxed text-ink-2">
              {counts.deferred > 0
                ? t('pages.today.finished.mixed', { approved: counts.approved, deferred: counts.deferred })
                : t('pages.today.finished.allApproved')}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-5">
              {counts.deferred > 0 && (
                <Button
                  type="button"
                  onClick={reviewDeferred}
                  className="min-h-11"
                >
                  {t('pages.today.finished.reviewDeferred', { count: counts.deferred })}
                </Button>
              )}
              <Link to="/activation" className="text-body text-gov underline underline-offset-4">
                {t('pages.today.activePrinciples')}
              </Link>
            </div>
            <p className="mt-6 text-caption text-ink-4">{t('pages.today.finished.nextTime')}</p>
          </div>
        ) : session !== null && resumableIdList.length > 0 ? (
          // Resume requires an actual session created earlier today. With no
          // stored session the unhandled set is the whole queue, so keying this
          // branch on the count alone rendered "继续判断" for a first visit while
          // `resume()` returned early on `session === null` — a button that could
          // be clicked and did nothing. A fresh day falls through to the start
          // entry below, which writes the session before navigating.
          <div data-testid="today-resume">
            <p className="today-headline">
              {t('pages.today.remaining', { count: resumableIdList.length })}
            </p>
            {lastSeenLine}
            <Button
              type="button"
              size="lg"
              data-testid="today-continue"
              onClick={resume}
              className="mt-6 min-h-11"
            >
              {t('pages.today.continue')}
            </Button>
          </div>
        ) : queue.ordered.length === 0 ? (
          <div data-testid="today-empty">
            <p className="today-headline">{t('pages.today.empty')}</p>
            {lastSeenLine}
            <Link to="/activation" className="mt-6 inline-block text-body text-gov underline underline-offset-4">
              {t('pages.today.activePrinciples')}
            </Link>
          </div>
        ) : (
          <div data-testid="today-entry">
            <p className="today-headline">
              {todayRemaining.length > 0
                ? t('pages.today.count', { count: todayRemaining.length })
                : t('pages.today.leftoverOnly', { count: leftoverRemaining.length })}
            </p>
            {lastSeenLine}
            {todayRemaining.length > 0 && leftoverRemaining.length > 0 && (
              <p className="mt-1 text-body text-ink-3">
                {t('pages.today.leftover', { count: leftoverRemaining.length })}
              </p>
            )}
            {todayRemaining.length === 0 && oldestLeftover !== null && (
              <p className="mt-1 text-body text-ink-3">
                {t('pages.today.oldestDays', { days: daysWaiting(oldestLeftover.createdAt) })}
              </p>
            )}
            <Button
              type="button"
              size="lg"
              data-testid="today-start"
              onClick={() => writeAndGo(orderedRemaining)}
              className="mt-6 min-h-11"
            >
              {todayRemaining.length > 0 ? t('pages.today.start') : t('pages.today.resume')}
            </Button>
          </div>
        )}

        {result.unavailable.length > 0 && (
          <details className="mt-6 text-caption text-ink-3" data-testid="today-unavailable-sources">
            <summary className="cursor-pointer">{t('pages.today.sources.missing')}</summary>
            <ul className="mt-2 space-y-1">
              {result.unavailable.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </details>
        )}

        <footer className="mt-8 border-t border-line pt-4">
          <Link to="/workbench" className="text-body text-ink-3 underline underline-offset-4 hover:text-ink">
            {t('pages.today.workbench')}
          </Link>
        </footer>
      </div>
      <div className="today-artwork" aria-hidden="true" />
    </PageShell>
  );
}
