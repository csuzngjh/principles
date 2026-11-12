/**
 * 审查卡 — one decision at a time.
 *
 * REVIEW_SESSION_SPEC §1: no sidebar, no filter, no overview. The card states
 * what happened, what PD suggests, why a decision is needed now, and offers
 * exactly two actions plus "先放着" (defer). Everything else opens in place.
 *
 * The route is display-only: decisions use the same approve/reject endpoints
 * the workbench already used, and "先放着" writes nothing to the server.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../../components/layout/page-shell.js';
import { StatePanel } from '../../components/ui/state-panel.js';
import { approveApproval, rejectApproval, resolveOwnerDecision } from '../../api.js';
import { describeApiError } from '../../utils/technical-detail.js';
import { loadReviewData, type ReviewLoadResult } from './review-data.js';
import { findReviewItem, splitReviewQueue, type ReviewItem } from './review-items.js';
import {
  isSessionForToday,
  localDateKey,
  readReviewSession,
  writeLastCompletedAt,
  writeReviewSession,
  type ReviewSession,
} from './review-session.js';
import { deriveReviewNarrative, type ReviewNarrative } from './review-narrative.js';

/** Owner-facing action failure: what happened + what to do next (D14). */
function describeActionError(raw: string | null | undefined, t: (key: string) => string): string {
  const value = (raw ?? '').trim();
  if (/artifact_kind_not_rule|not a rule|artifact.{0,20}(invalid|kind)/i.test(value)) {
    return t('pages.review.actionErrors.notRunnable');
  }
  if (/stale_review|stale_owner_decision|already_resolved|conflict/i.test(value)) {
    return t('pages.review.actionErrors.stale');
  }
  const described = describeApiError(value);
  if (described.text === '这条内容属于技术细节' || described.text === value) {
    return t('pages.review.actionErrors.generic');
  }
  return described.text;
}

export interface ReviewPageProps {
  featureFlags?: Record<string, { enabled: boolean } | undefined>;
}

type ActionKind = 'approve' | 'reject' | 'defer';

type ReasonKey = 'wrong' | 'unclear' | 'wide' | 'other';

interface Feedback {
  kind: ActionKind;
  remaining: number;
  nextId: string | null;
}

function newSession(queueIds: readonly string[]): ReviewSession {
  const now = new Date();
  return {
    date: localDateKey(now),
    queueIds: [...queueIds],
    currentIndex: 0,
    skippedIds: [],
    decisions: [],
    lastSeenAt: now.toISOString(),
  };
}

function handledIds(session: ReviewSession): Set<string> {
  return new Set([...session.skippedIds, ...session.decisions.map((entry) => entry.id)]);
}

function nextIdAfter(currentId: string, order: readonly string[], session: ReviewSession, available: Set<string>): string | null {
  const handled = handledIds(session);
  const index = order.indexOf(currentId);
  const rest = index >= 0 ? order.slice(index + 1) : order;
  for (const id of rest) {
    if (id !== currentId && !handled.has(id) && available.has(id)) return id;
  }
  return null;
}

export function ReviewPage({ featureFlags }: ReviewPageProps) {
  const { t, i18n } = useTranslation();
  const { id: rawId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = rawId ?? '';
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [result, setResult] = useState<ReviewLoadResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [stale, setStale] = useState<{ nextId: string | null } | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);
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
      setErrorMessage(error instanceof Error ? error.message : t('pages.review.loadError'));
      setStatus('error');
    }
  }, [featureFlags, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Loading is a static sentence; after 3s the Owner may move on instead of
  // waiting (REVIEW_SESSION_SPEC §1.7).
  useEffect(() => {
    if (status !== 'loading') { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 3000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // In-place confirmation, then the next card. 600ms only; no toast, no modal.
  useEffect(() => {
    if (feedback === null) return;
    const timer = window.setTimeout(() => {
      if (feedback.nextId !== null) {
        navigate(`/review/${encodeURIComponent(feedback.nextId)}`, { replace: true });
      } else {
        writeLastCompletedAt();
        navigate('/focus', { replace: true });
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [feedback, navigate]);

  const queue = result !== null ? splitReviewQueue(result.items).ordered : [];
  const item = result !== null ? findReviewItem(result.items, id) : undefined;
  const progress = (() => {
    const index = queue.findIndex((entry) => entry.id === id);
    return index >= 0 ? { index: index + 1, total: queue.length } : null;
  })();

  function commit(action: ActionKind, nextId: string | null, remaining: number): void {
    setFeedback({ kind: action, remaining, nextId });
  }

  function remember(action: ActionKind, targetId: string, queueIds: readonly string[]): ReviewSession {
    const stored = readReviewSession();
    const base = isSessionForToday(stored) ? stored : newSession(queueIds);
    const now = new Date().toISOString();
    const decisions = action === 'defer'
      ? base.decisions.filter((entry) => entry.id !== targetId)
      : [...base.decisions.filter((entry) => entry.id !== targetId), { id: targetId, action: action === 'approve' ? 'approve' as const : 'reject' as const, at: now }];
    const skippedIds = action === 'defer'
      ? [...new Set([...base.skippedIds, targetId])]
      : base.skippedIds.filter((entry) => entry !== targetId);
    const next: ReviewSession = {
      ...base,
      queueIds: base.queueIds.includes(targetId) ? base.queueIds : [...base.queueIds, targetId],
      skippedIds,
      decisions,
      lastSeenAt: now,
    };
    writeReviewSession(next);
    return next;
  }

  function advance(action: ActionKind, target: ReviewItem): void {
    if (result === null) return;
    const available = new Set(queue.map((entry) => entry.id));
    const order = queue.map((entry) => entry.id);
    const session = remember(action, target.id, order);
    const next = nextIdAfter(target.id, order, session, available);
    if (next === null) {
      writeReviewSession({ ...session, currentIndex: order.length });
    }
    const handled = handledIds(session);
    const remaining = order.filter((entry) => !handled.has(entry)).length;
    commit(action, next, remaining);
  }

  async function approve(target: ReviewItem, acknowledgesPartial: boolean): Promise<void> {
    setBusy('approve');
    setActionError(null);
    try {
      if (target.kind === 'decision' && target.decision !== undefined) {
        const decision = target.decision;
        const requiresAcknowledgement = decision.review?.capability.acceptRequirement.kind === 'acknowledge_partial_evidence';
        const response = await resolveOwnerDecision(decision.taskId, {
          action: 'accept_current',
          reviewKey: decision.reviewKey,
          expectedRevisionEpoch: decision.expectedRevisionEpoch,
          expectedSourceRunId: decision.expectedSourceRunId,
          expectedSourceArtifactId: decision.expectedSourceArtifactId,
          expectedSourceArtifactHash: decision.expectedSourceArtifactHash,
          expectedEvidenceDigest: decision.expectedEvidenceDigest ?? '',
          ...(requiresAcknowledgement && acknowledgesPartial
            ? { acknowledgement: { kind: 'partial_evidence' as const, acknowledged: true as const } }
            : {}),
          ownerInstruction: null,
        });
        if (!response.success) {
          if (response.error === 'stale_owner_decision' || response.error === 'already_resolved') {
            handleAlreadyHandled(target);
            return;
          }
          setActionError(describeActionError(response.error, t));
          return;
        }
      } else if (target.kind === 'approval' && target.approval !== undefined) {
        const response = await approveApproval(target.approval.record.id);
        if (!response.success) {
          setActionError(describeActionError(response.error, t));
          return;
        }
      }
      advance('approve', target);
    } catch (error) {
      setActionError(describeActionError(error instanceof Error ? error.message : null, t));
    } finally {
      setBusy(null);
    }
  }

  async function reject(target: ReviewItem): Promise<void> {
    if (reason === null) return;
    setBusy('reject');
    setActionError(null);
    const reasonText = t(`pages.review.reason.${reason}`);
    try {
      if (target.kind === 'decision' && target.decision !== undefined) {
        const decision = target.decision;
        const response = await resolveOwnerDecision(decision.taskId, {
          action: 'reject_current',
          reviewKey: decision.reviewKey,
          expectedRevisionEpoch: decision.expectedRevisionEpoch,
          expectedSourceRunId: decision.expectedSourceRunId,
          expectedSourceArtifactId: decision.expectedSourceArtifactId,
          expectedSourceArtifactHash: decision.expectedSourceArtifactHash,
          expectedEvidenceDigest: decision.expectedEvidenceDigest ?? '',
          ownerInstruction: reasonText,
        });
        if (!response.success) {
          if (response.error === 'stale_owner_decision' || response.error === 'already_resolved') {
            handleAlreadyHandled(target);
            return;
          }
          setActionError(describeActionError(response.error, t));
          return;
        }
      } else if (target.kind === 'approval' && target.approval !== undefined) {
        const response = await rejectApproval(target.approval.record.id, reasonText);
        if (!response.success) {
          setActionError(describeActionError(response.error, t));
          return;
        }
      }
      advance('reject', target);
    } catch (error) {
      setActionError(describeActionError(error instanceof Error ? error.message : null, t));
    } finally {
      setBusy(null);
    }
  }

  function handleAlreadyHandled(target: ReviewItem): void {
    const available = new Set(queue.map((entry) => entry.id));
    const order = queue.map((entry) => entry.id);
    const session = remember('defer', target.id, order);
    setStale({ nextId: nextIdAfter(target.id, order, session, available) });
  }

  function defer(target: ReviewItem): void {
    advance('defer', target);
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <PageShell width="reading">
        <p className="mt-10 text-body text-ink-3" data-testid="review-loading">{t('pages.review.loading')}</p>
        {slow && (
          <Link to="/focus" className="mt-4 inline-block text-body text-gov underline underline-offset-4">
            {t('pages.review.backToday')}
          </Link>
        )}
      </PageShell>
    );
  }

  if (status === 'error' || result === null) {
    return (
      <PageShell width="reading">
        <StatePanel
          kind="unreachable"
          title={t('pages.review.loadError')}
          technical={errorMessage ?? undefined}
          action={{ label: t('common.retry'), onClick: () => { void load(); } }}
          secondaryAction={{ label: t('pages.review.defer'), to: '/focus' }}
          testId="review-error-state"
        />
      </PageShell>
    );
  }

  // ── Handled elsewhere while this card was open ────────────────────────────
  if (stale !== null) {
    return (
      <PageShell width="reading">
        <div className="mt-10" data-testid="review-stale">
          <p className="text-body leading-relaxed text-ink">{t('pages.review.alreadyHandled')}</p>
          <div className="mt-6 flex flex-wrap items-center gap-5">
            {stale.nextId !== null && (
              <Link to={`/review/${encodeURIComponent(stale.nextId)}`} className="text-body text-gov underline underline-offset-4">
                {t('pages.review.nextOne')}
              </Link>
            )}
            <Link to="/focus" className="text-body text-ink-3 underline underline-offset-4">
              {t('pages.review.backToday')}
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  // ── Already handled / missing ─────────────────────────────────────────────
  if (item === undefined) {
    const next = queue[0];
    return (
      <PageShell width="reading">
        <div className="mt-10" data-testid="review-missing">
          <p className="text-body leading-relaxed text-ink">{t('pages.review.alreadyHandled')}</p>
          <div className="mt-6 flex flex-wrap items-center gap-5">
            {next !== undefined && (
              <Link to={`/review/${encodeURIComponent(next.id)}`} className="text-body text-gov underline underline-offset-4">
                {t('pages.review.nextOne')}
              </Link>
            )}
            <Link to="/focus" className="text-body text-ink-3 underline underline-offset-4">
              {t('pages.review.backToday')}
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <ReviewCard
      item={item}
      progress={progress}
      lockedReason={result.lockedReason}
      feedback={feedback}
      busy={busy}
      actionError={actionError}
      rejectOpen={rejectOpen}
      reason={reason}
      acknowledged={acknowledged}
      onReason={(next) => setReason(next)}
      onAcknowledged={setAcknowledged}
      onOpenReject={() => { setRejectOpen(true); setActionError(null); }}
      onCloseReject={() => { setRejectOpen(false); setReason(null); }}
      onApprove={() => { void approve(item, acknowledged); }}
      onConfirmReject={() => { void reject(item); }}
      onDefer={() => defer(item)}
      language={i18n.language}
      t={t}
    />
  );
}

function ReviewCard(props: {
  item: ReviewItem;
  progress: { index: number; total: number } | null;
  lockedReason: string | null;
  feedback: Feedback | null;
  busy: ActionKind | null;
  actionError: string | null;
  rejectOpen: boolean;
  reason: ReasonKey | null;
  acknowledged: boolean;
  onReason: (reason: ReasonKey) => void;
  onAcknowledged: (value: boolean) => void;
  onOpenReject: () => void;
  onCloseReject: () => void;
  onApprove: () => void;
  onConfirmReject: () => void;
  onDefer: () => void;
  language: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const {
    item, progress, lockedReason, feedback, busy, actionError, rejectOpen, reason,
    acknowledged, onReason, onAcknowledged, onOpenReject, onCloseReject,
    onApprove, onConfirmReject, onDefer, language, t,
  } = props;
  const narrative: ReviewNarrative = deriveReviewNarrative(item, t, language);
  const decision = item.decision;
  const acceptRequirement = decision?.review?.capability.acceptRequirement;
  const allowedActions = decision?.allowedActions ?? [];
  const acceptForbidden = decision !== undefined
    ? !allowedActions.includes('accept_current') || acceptRequirement?.kind === 'forbidden'
    : false;
  const requiresAcknowledgement = acceptRequirement?.kind === 'acknowledge_partial_evidence';
  const approvalDisabled = lockedReason !== null
    || acceptForbidden
    || narrative.evidenceInsufficient
    || narrative.textMissing
    || (requiresAcknowledgement && !acknowledged);
  const rejectDisabled = lockedReason !== null || narrative.textMissing;
  const lockedCopy = lockedReason ?? (acceptForbidden ? t('pages.review.acceptBlocked') : null);

  return (
    <PageShell width="reading">
      <header className="mb-5 flex items-center justify-between gap-4">
        <Link to="/focus" className="text-body text-gov underline underline-offset-4" data-testid="review-back">
          {t('pages.review.back')}
        </Link>
        {progress !== null && (
          <span className="text-caption text-ink-4 tabular-nums" data-testid="review-progress">
            {t('pages.review.progress', { index: progress.index, total: progress.total })}
          </span>
        )}
      </header>

      <article data-testid="review-card" data-review-id={item.id}>
        <h1 className="text-title font-semibold leading-snug text-ink" data-testid="review-title">
          {narrative.heading}
        </h1>
        <p className="mt-2 text-caption text-ink-4" data-testid="review-source">{narrative.source}</p>

        <div className="mt-5 space-y-1.5 text-body leading-relaxed text-ink" data-testid="review-narrative">
          <p>{narrative.happened}</p>
          <p>
            <span className="text-ink-3">{t('pages.review.advicePrefix')}</span>
            {narrative.advice}
          </p>
          <p className="text-ink-2">{narrative.whyNow}</p>
        </div>

        <p className="mt-2 text-body text-ink-2" data-testid="review-impact">{narrative.impact}</p>

        {narrative.textMissing && (
          <p className="mt-4 text-body leading-relaxed text-ink-3" data-testid="review-text-missing">
            {t('pages.review.textMissing')}
          </p>
        )}

        <div className="mt-3 space-y-2 text-body">
          <details className="group" data-testid="review-evidence">
            <summary className="cursor-pointer text-gov underline underline-offset-4">{t('pages.review.evidence')}</summary>
            <div className="mt-2 space-y-2 text-body leading-relaxed text-ink-2">
              {(narrative.happenedFull !== narrative.happened || narrative.adviceFull !== narrative.advice) && (
                <div className="space-y-1 text-ink-3">
                  <p className="text-caption">{t('pages.review.fullText')}</p>
                  {narrative.happenedFull !== narrative.happened && <p>{narrative.happenedFull}</p>}
                  {narrative.adviceFull !== narrative.advice && <p>{narrative.adviceFull}</p>}
                </div>
              )}
              {narrative.evidence.length === 0 ? (
                <p>{narrative.evidenceInsufficient ? t('pages.review.evidenceInsufficient') : t('pages.review.evidenceEmpty')}</p>
              ) : (
                <ul className="space-y-1">
                  {narrative.evidence.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
              {narrative.evidenceMore > 0 && (
                <p className="text-ink-3">{t('pages.review.evidenceMore', { count: narrative.evidenceMore })}</p>
              )}
              {narrative.evidenceInsufficient && narrative.evidence.length > 0 && (
                <p className="text-ink-3">{t('pages.review.evidenceInsufficient')}</p>
              )}
            </div>
          </details>

          <details className="group" data-testid="review-execution">
            <summary className="cursor-pointer text-gov underline underline-offset-4">{t('pages.review.executionTitle')}</summary>
            <div className="mt-2 space-y-1 text-body leading-relaxed text-ink-2">
              {narrative.execution.map((line) => <p key={line}>{line}</p>)}
            </div>
          </details>

          <details data-testid="review-technical">
            <summary className="cursor-pointer text-gov underline underline-offset-4">{t('pages.review.technicalTitle')}</summary>
            <TechnicalRows narrative={narrative} t={t} />
          </details>
        </div>

        <div className="mt-5 border-t border-line pt-3" data-testid="review-actions">
          {feedback !== null ? (
            <p className="text-body text-ink" role="status" data-testid="review-feedback">
              {feedback.kind === 'approve'
                ? t('pages.review.approved', { count: feedback.remaining })
                : feedback.kind === 'reject'
                  ? t('pages.review.rejected', { count: feedback.remaining })
                  : t('pages.review.deferred', { count: feedback.remaining })}
            </p>
          ) : rejectOpen ? (
            <div data-testid="review-reject-panel">
              <fieldset disabled={busy !== null}>
                <legend className="text-body font-medium text-ink">{t('pages.review.rejectTitle')}</legend>
                <div className="mt-3 space-y-2">
                  {(['wrong', 'unclear', 'wide', 'other'] as const).map((key) => (
                    <label key={key} className="flex items-center gap-2 text-body text-ink-2">
                      <input
                        type="radio"
                        name="review-reject-reason"
                        value={key}
                        checked={reason === key}
                        onChange={() => onReason(key)}
                      />
                      {t(`pages.review.reason.${key}`)}
                    </label>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-5">
                  <button
                    type="button"
                    data-testid="review-confirm-reject"
                    disabled={reason === null || busy !== null}
                    onClick={onConfirmReject}
                    className="inline-flex min-h-8 items-center rounded-[4px] border border-gov bg-gov px-3 py-1.5 text-body text-paper hover:bg-gov-2 disabled:opacity-50"
                  >
                    {busy === 'reject' ? t('pages.review.processing') : t('pages.review.confirmReject')}
                  </button>
                  <button type="button" onClick={onCloseReject} className="text-body text-gov underline underline-offset-4">
                    {t('pages.review.thinkAgain')}
                  </button>
                </div>
              </fieldset>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  data-testid="review-approve"
                  disabled={approvalDisabled || busy !== null}
                  onClick={onApprove}
                  className="inline-flex min-h-9 items-center rounded-[4px] border border-gov bg-gov px-4 py-2 text-body text-paper hover:bg-gov-2 disabled:opacity-50"
                >
                  {busy === 'approve' ? t('pages.review.processing') : t('pages.review.approve')}
                </button>
                <button
                  type="button"
                  data-testid="review-reject"
                  disabled={rejectDisabled || busy !== null}
                  onClick={onOpenReject}
                  className="inline-flex min-h-9 items-center rounded-[4px] border border-line bg-panel px-4 py-2 text-body text-ink-2 hover:border-ink-3 disabled:opacity-50"
                >
                  {t('pages.review.reject')}
                </button>
                <button
                  type="button"
                  data-testid="review-defer"
                  disabled={busy !== null}
                  onClick={onDefer}
                  className="ml-auto text-body text-ink-3 underline underline-offset-4 hover:text-ink"
                >
                  {t('pages.review.defer')}
                </button>
              </div>

              {requiresAcknowledgement && (
                <label className="mt-4 flex items-start gap-2 text-body text-ink-2">
                  <input
                    type="checkbox"
                    data-testid="review-acknowledge-partial"
                    checked={acknowledged}
                    onChange={(event) => onAcknowledged(event.target.checked)}
                    className="mt-1"
                  />
                  {t('pages.review.acknowledgePartial')}
                </label>
              )}

              {lockedCopy !== null && (
                <p className="mt-3 text-body leading-relaxed text-ink-3" role="alert" data-testid="review-locked">
                  {lockedCopy}
                  {lockedReason !== null && (
                    <Link to="/settings" className="ml-2 text-gov underline underline-offset-4">
                      {t('pages.review.goSettings')}
                    </Link>
                  )}
                </p>
              )}

              <p className="mt-3 text-caption text-ink-4">{t('pages.review.defaultNote')}</p>
            </>
          )}

          {actionError !== null && (
            <p className="mt-4 text-body leading-relaxed text-danger" role="alert" data-testid="review-action-error">
              {actionError}
            </p>
          )}
        </div>
      </article>
    </PageShell>
  );
}

function TechnicalRows({ narrative, t }: { narrative: ReviewNarrative; t: (key: string) => string }) {
  const [copied, setCopied] = useState(false);
  const text = narrative.technical.map((row) => `${row.label}: ${row.value}`).join('\n');
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (non-HTTPS): the values stay selectable below.
    }
  }
  return (
    <div className="mt-2">
      <dl className="space-y-1 font-mono text-caption leading-relaxed text-ink-4">
        {narrative.technical.map((row) => (
          <div key={row.label} className="flex gap-2">
            <dt className="shrink-0">{row.label}</dt>
            <dd className="min-w-0 break-all">{row.value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={() => { void copy(); }} className="mt-3 text-caption text-gov underline underline-offset-4">
        {copied ? t('common.copied') : t('pages.review.copyTechnical')}
      </button>
    </div>
  );
}
