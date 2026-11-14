import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchApprovalReview, fetchOwnerDecisionView, approveApproval, rejectApproval, editApproval, fetchAllActivations } from '../../api.js';
import { localizeApprovalWarning } from '../../utils/approval-warning-localization.js';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { computeDecisionReadiness, gapAnchorId } from '../../utils/approval-readiness.js';
import type { ApprovalsGroupedData } from '../../api.js';
import type { ApprovalGroupData } from '../../utils/validators.js';
import type { ApprovalReviewData } from '../../utils/approval-review.js';
import type { OwnerDecisionViewCore, NarrativeField } from '@principles/core/runtime';

export function ApprovalSubjectReading({ principleId, approvalId, artifactId, channel, lockedReason, targetHost, onResolved, revisionReview, revisionReviewUnavailable, allowedActions, budgetNotice, promptInjection, sourceUnlinked, strategicConflict, showPrincipleLink = true }: {
  principleId: string; approvalId: string; artifactId: string; channel: string; lockedReason?: string;
  targetHost?: 'openclaw' | 'codex' | 'workbuddy'; onResolved?: (message: string) => void;
  revisionReview?: { artifactId?: string; artifactDigest?: string; oldStatement: string; newStatement: string; intentFields: Record<string, string> };
  revisionReviewUnavailable?: boolean;
  /** Backend-assessed actions for THIS approval; absent means no per-action gate (the guarded submit still applies). */
  allowedActions?: readonly ('approve' | 'reject' | 'edit_approval')[];
  budgetNotice?: string; promptInjection?: ApprovalsGroupedData['promptInjection']; sourceUnlinked?: boolean;
  /** SIA v1.2: server-computed strategic-conflict verdict; display only, the write path enforces it. */
  strategicConflict?: ApprovalGroupData['strategicConflict']; showPrincipleLink?: boolean;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [review, setReview] = useState<ApprovalReviewData | null>(null);
  const [view, setView] = useState<OwnerDecisionViewCore | null>(null);
  const [viewSettled, setViewSettled] = useState(false);
  const [error, setError] = useState('');
  const [resultText, setResultText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'reject' | 'edit' | null>(null);
  const [reason, setReason] = useState('');
  const [newArtifact, setNewArtifact] = useState('');
  const [intentReviewed, setIntentReviewed] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const epoch = useRef(0);
  const read = useCallback(async () => {
    const current = ++epoch.current;
    setReview(null); setLoading(true); setIntentReviewed(false); setError('');
    const result = await fetchApprovalReview(approvalId);
    if (current !== epoch.current) return null;
    setLoading(false);
    if (result.success) { setReview(result.data); return result.data; }
    setError([result.error, result.nextAction].filter(Boolean).join(' '));
    return null;
  }, [approvalId]);
  useEffect(() => {
    setError(''); setResultText(''); setView(null); setViewSettled(false); setMode(null); setReason(''); setNewArtifact(''); setApproveNote('');
    let current = true;
    void read();
    void fetchOwnerDecisionView(principleId).then(result => { if (current) { setView(result.success ? result.data : null); setViewSettled(true); } });
    return () => { current = false; epoch.current++; };
  }, [principleId, approvalId, artifactId, channel, read]);
  const narrative = (field: NarrativeField) => field.status === 'known' ? field.value.map(item => item.text).join('\n\n') : field.reason.ownerText;
  const subject = view?.decisionSubjects.find(item => item.key === approvalId && item.channel === channel
    && item.revisionArtifactId.status === 'known' && item.revisionArtifactId.value === review?.expectedReview.artifactId);
  const materialBlocks = subject?.materialGates.find(gate => gate.actionSemantic === 'approve')?.requiredItems.filter(item => item.status !== 'satisfied') ?? [];
  const revisionMatches = !revisionReview || (review?.expectedReview.artifactState === 'present' && review.expectedReview.artifactId === artifactId
    && revisionReview.artifactId === review.expectedReview.artifactId && revisionReview.artifactDigest === review.expectedReview.artifactDigest);
  // SPEC-PD-UIUX-002 §6 (1C): ONE rule set decides what is missing and which
  // action is primary. Submit guards, button states and the recommendation block
  // all read from this verdict — no second copy of the readiness logic.
  // SIA v1.2: a confirmed, effectively-unresolved strategic conflict is one
  // more missing required item for approval. The server's approve precheck
  // refuses the same condition, so the card must not offer a button whose only
  // outcome is a 422.
  const strategicBlocked = strategicConflict !== undefined && strategicConflict.blockCode !== null;
  const readiness = computeDecisionReadiness({
    status: review?.approval.status ?? 'unknown',
    hasSubject: subject !== undefined,
    artifactState: review?.expectedReview.artifactState ?? 'unknown',
    exactBodyAvailable: review ? review.material.exactBody !== null : false,
    materialAvailability: review?.material.availability ?? 'unknown',
    revisionMatches,
    revisionReviewUnavailable: revisionReviewUnavailable === true,
    materialBlockCount: materialBlocks.length + (strategicBlocked ? 1 : 0),
    allowedActions,
    sourceUnlinked: sourceUnlinked === true,
  });
  const approveReady = readiness.approveReady;
  const may = (semantic: 'approve' | 'reject' | 'edit_approval') => allowedActions === undefined || allowedActions.includes(semantic);
  async function submit(action: 'approve' | 'reject' | 'edit') {
    if (!review || busy || lockedReason || review.approval.status !== 'pending') return;
    if (!may(action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'edit_approval')) return;
    if (action === 'approve' && (!approveReady || (revisionReview && !intentReviewed))) return;
    if (action !== 'approve' && !reason.trim()) return;
    if (action === 'edit' && !newArtifact.trim()) return;
    const snapshot = review;
    const current = epoch.current;
    setBusy(true); setError(''); setResultText('');
    const result = action === 'approve' ? await approveApproval(approvalId, approveNote.trim() || undefined, { expectedReview: snapshot.expectedReview, targetHost,
      ...(revisionReview ? { intentReviewed, reviewedArtifactId: snapshot.expectedReview.artifactId } : {}) })
      : action === 'reject' ? await rejectApproval(approvalId, reason.trim(), snapshot.expectedReview)
      : await editApproval(approvalId, newArtifact.trim(), { reason: reason.trim(), expectedReview: snapshot.expectedReview });
    if (current !== epoch.current) return;
    const fresh = await read();
    setBusy(false);
    if (!fresh) { setError(t('pages.focus.workbench.resultUnknown')); return; }
    if (fresh.approval.status === 'approved' || fresh.approval.status === 'rejected') {
      const state = t(fresh.approval.status === 'approved' ? 'pages.focus.workbench.currentApproved' : 'pages.focus.workbench.currentRejected');
      const ownOutcome = result.success && ((action === 'approve' && fresh.approval.status === 'approved') || (action === 'reject' && fresh.approval.status === 'rejected'));
      const refused = !result.success && result.status !== undefined && result.status >= 400 && result.status < 500;
      let message = ownOutcome ? t(fresh.approval.status === 'approved' ? 'pages.focus.workbench.approved' : 'pages.focus.workbench.rejected')
        : refused ? t('pages.focus.workbench.refusedCurrentState', { state }) + ' ' + [result.error, result.nextAction].filter(Boolean).join(' ')
          : t('pages.focus.workbench.currentStateConfirmed', { state });
      if (fresh.approval.status === 'approved' && !result.success && !refused) {
        const activations = await fetchAllActivations(targetHost);
        if (epoch.current !== current + 1) return;
        const active = activations.success && activations.data.activations.some(item => item.artifactId === fresh.approval.artifactId && item.status === 'active');
        message += ' ' + t(active ? 'pages.focus.workbench.runtimeCheckLink' : result.reason === 'activation_failed' ? 'pages.focus.workbench.activationFailed' : 'pages.focus.workbench.approvedRuntimeUnknown');
      }
      if (result.success && result.data.warning) {
        const warning = localizeApprovalWarning(result.data.warning, t);
        message += ` ${warning.title} ${warning.body ?? warning.detail}`;
      }
      setResultText(message); onResolved?.(message); return;
    }
    if (!result.success) setError(t(result.status === undefined ? 'pages.focus.workbench.resultUnknown' : 'pages.focus.workbench.notRecorded') + ' ' + [result.error, result.nextAction].filter(Boolean).join(' '));
    else if (action === 'edit') { setResultText(t('pages.focus.workbench.replaced')); setMode(null); setReason(''); setNewArtifact(''); setApproveNote(''); }
  }
  const body = review?.material.exactBody;
  const bodyText = body?.text ?? review?.material.statement ?? '';
  const recommendationText = t(`pages.focus.workbench.recommendation.${readiness.recommendation}`);
  const revealGaps = () => {
    const target = document.getElementById('approval-gaps');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  };
  const startReject = () => setMode('reject');
  const primaryDisabled = busy || Boolean(lockedReason);
  // §6.3: the decision bar is pinned to the bottom of the viewport (fixed), so
  // ⑤ is on screen no matter how long the material is. A `sticky` bar cannot
  // do that — sticky never pulls an element that starts below the fold into
  // view, so the Owner still had to scroll to find 批准/拒绝. The root keeps a
  // large bottom padding so the last line of content is never covered.
  return <div className="owner-work-approval space-y-7 pb-40">
    {/* ① 是什么 — the object itself, before any judgement */}
    <section id="approval-section-what" data-testid="approval-section-what">
      <h3 className="mb-3 text-reading font-medium text-ink">{t('pages.focus.workbench.proposal')}</h3>
      {loading ? <p role="status" className="text-sm text-ink-3">{t('pages.focus.workbench.loading')}</p> : <>
        {bodyText ? <>
          <p className="mb-2 text-[12px] text-ink-4">{t(body?.kind === 'rule_code' ? 'pages.focus.workbench.codePreview' : 'pages.focus.workbench.textPreview')}</p>
          <p className="whitespace-pre-wrap break-words text-reading leading-[1.85] text-ink">{truncateByCodePoints(bodyText, 240)}</p>
          <details className="mt-4 rounded-[4px] border border-line px-4 py-3 text-body"><summary className="cursor-pointer text-gov">{t(body?.kind === 'rule_code' ? 'pages.focus.workbench.fullCode' : 'pages.focus.workbench.fullText')}</summary>
            <div className="mt-4 whitespace-pre-wrap break-words text-reading leading-[1.85] text-ink-2">{bodyText}</div>
          </details>
        </> : <p className="text-sm text-amber">{t('pages.focus.workbench.exactMaterialMissing')}</p>}
        {review?.material.scope.length ? <div className="mt-4"><h4 className="text-sm font-medium text-ink">{t('pages.focus.workbench.scope')}</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-body leading-relaxed text-ink-2">{review.material.scope.map((scope, index) => <li key={index}>{scope}</li>)}</ul></div> : null}
        {review?.material.rationale && <details className="mt-4 text-body text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.reasonAndScope')}</summary><p className="mt-3 whitespace-pre-wrap leading-relaxed">{review.material.rationale}</p></details>}
        {revisionReview && <details className="mt-4 text-body leading-relaxed text-ink-2"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.compare')}</summary>
          <p className="mt-3 whitespace-pre-wrap">{revisionReview.oldStatement}</p><p className="mt-3 whitespace-pre-wrap">{revisionReview.newStatement}</p>
          <dl className="mt-3">{Object.entries(revisionReview.intentFields).map(([key, value]) => <div key={key}><dt className="font-medium">{t(`pages.focus.intentField.${key}`, { defaultValue: key })}</dt><dd>{value}</dd></div>)}</dl>
        </details>}
        <details className="mt-4 text-[12px] text-ink-4"><summary className="cursor-pointer">{t('pages.focus.workbench.subjectDetails')}</summary>
          <dl className="mt-2 break-all font-mono"><div>approval: {approvalId}</div><div>artifact: {review?.expectedReview.artifactId ?? artifactId}</div><div>channel: {review?.expectedReview.channel ?? channel}</div></dl>
        </details>
        {showPrincipleLink && <Link className="mt-3 inline-block text-body text-gov underline underline-offset-4" state={{ returnTo: `${location.pathname}${location.search}` }} to={`/principles/${encodeURIComponent(principleId)}`}>{t('pages.focus.workbench.openPrinciple')}</Link>}
      </>}
    </section>

    {/* ② 为什么现在 — the triggering event, never the proposal restated */}
    <section id="approval-section-why" data-testid="approval-section-why" className="border-t border-line pt-5">
      <h3 className="mb-3 text-reading font-medium text-ink">{t('pages.focus.workbench.whyNow')}</h3>
      {sourceUnlinked && <p role="alert" className="mb-3 text-sm leading-relaxed text-amber">{t('pages.focus.workbench.sourceUnlinked')}</p>}
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{view ? narrative(view.incidentSummary) : t('pages.focus.workbench.materialUnavailable')}</p>
    </section>

    {/* ③ 影响谁与不处理会怎样 — the consequences, then the known limits */}
    <section id="approval-section-impact" data-testid="approval-section-impact" className="border-t border-line pt-5">
      <h3 className="mb-3 text-reading font-medium text-ink">{t('pages.focus.workbench.impact')}</h3>
      {subject ? <p className="text-sm leading-relaxed text-ink-2">{narrative(subject.decisionMaterial.consequence)}</p>
        : viewSettled && <p className="text-sm leading-relaxed text-amber">{t('pages.focus.workbench.subjectUnconfirmed')}</p>}
      {review?.material.targetBehavior && <div className="mt-3 text-[14px] leading-relaxed text-ink-2" data-testid="approval-exact-target-behavior"><h4 className="mb-1 font-medium">{t('pages.focus.workbench.proposedBehavior')}</h4><p className="whitespace-pre-wrap break-words">{review.material.targetBehavior}</p></div>}
      {review && <div className="mt-3 text-sm leading-relaxed text-ink-2" data-testid="approval-exact-risks">
        {review.material.risks?.length ? <ul className="list-disc space-y-1 pl-5">{review.material.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul> : <p>{t(review.material.risks === null ? 'pages.focus.workbench.risksUnknown' : 'pages.focus.workbench.risksEmpty')}</p>}
      </div>}
      {!revisionMatches && <p role="alert" className="mt-3 text-sm text-amber">{t('pages.focus.workbench.revisionChanged')}</p>}
      {revisionReviewUnavailable && <p role="alert" className="mt-3 text-sm text-amber">{t('pages.focus.revisionReviewUnavailable')}</p>}
      {budgetNotice && channel === 'prompt' && <p role="alert" className="mt-3 text-sm leading-relaxed text-amber" data-testid={`approve-queue-badge-${principleId}`}>{budgetNotice}</p>}
      {promptInjection && channel === 'prompt' && <details className="mt-3 text-[12px] leading-relaxed text-ink-3" data-testid={`approve-queue-badge-scope-${principleId}`}><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.budgetBasis')}</summary>
        <p className="mt-2">{promptInjection.route === 'shared_render' ? t('pages.focus.promptScopeShared') : t('pages.focus.promptScopeList', { full: promptInjection.fullRenderChars !== undefined ? t('pages.focus.promptScopeFullRender', { count: promptInjection.fullRenderChars }) : '' })}{promptInjection.hostKind ? ` · ${promptInjection.hostKind}` : ''}</p>
        {promptInjection.productionRotation !== undefined && <p className="mt-2" data-testid={`approve-queue-rotation-${principleId}`}>{promptInjection.productionRotation === 'rotates' ? t('pages.focus.productionRotationRotates') : promptInjection.productionRotation === 'does_not_rotate' ? t('pages.focus.productionRotationFifo') : t('pages.focus.productionRotationUnknown')}</p>}
        <p className="mt-2">{promptInjection.budgetCapacityStatus === 'confirmed' && promptInjection.budgetContextWindowTokens !== undefined
          ? promptInjection.budgetObservedAt !== undefined ? t('pages.focus.promptBudgetObservedNote', { source: t(promptInjection.budgetCapacitySource === 'pi_catalog_exact' ? 'pages.focus.budgetCapacitySourcePiCatalog' : promptInjection.budgetCapacitySource === 'pi_catalog_model_id' ? 'pages.focus.budgetCapacitySourcePiCatalogModelId' : promptInjection.budgetCapacitySource === 'operator_declared' ? 'pages.focus.budgetCapacitySourceOperatorDeclared' : 'pages.focus.budgetCapacitySourceHostWindow'), window: promptInjection.budgetContextWindowTokens, observedAt: promptInjection.budgetObservedAt })
            : t('pages.focus.promptBudgetModelAwareNote', { window: promptInjection.budgetContextWindowTokens, sourceSuffix: promptInjection.budgetCapacitySource === 'operator_declared' ? t('pages.focus.budgetCapacitySourceOperatorDeclaredSuffix') : '' })
          : promptInjection.budgetObservedAt !== undefined ? t('pages.focus.promptBudgetFallbackObservedNote', { reason: t(`pages.focus.budgetFallbackReason.${promptInjection.budgetFallbackReason}`, { defaultValue: promptInjection.budgetFallbackReason ?? 'unknown' }), observedAt: promptInjection.budgetObservedAt })
            : t('pages.focus.promptBudgetFallbackNote', { reason: promptInjection.budgetFallbackReason ? t('pages.focus.promptBudgetFallbackReasonSuffix', { code: t(`pages.focus.budgetFallbackReason.${promptInjection.budgetFallbackReason}`, { defaultValue: promptInjection.budgetFallbackReason }) }) : '' })}</p>
      </details>}
      <p className="mt-3 text-body leading-relaxed text-ink-3">{t('pages.focus.workbench.scopeUnknown')}</p>
      <p className="mt-2 text-caption leading-relaxed text-ink-3">{t(channel === 'code_tool_hook' ? 'pages.focus.workbench.ruleConsequence' : channel === 'defer_archive' ? 'pages.focus.workbench.archiveConsequence' : 'pages.focus.workbench.promptConsequence')}</p>
      {view && <details className="mt-3 text-body leading-relaxed text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.principleLimits')}</summary>
        <p className="mt-3">{view.nonApplicabilityOrUnknown.status === 'known' ? view.nonApplicabilityOrUnknown.value.map(item => item.text).join(' ') : view.nonApplicabilityOrUnknown.reason.ownerText}</p>
        <p className="mt-2">{view.risk.status === 'known' ? view.risk.value?.items.map(item => item.text).join(' ') || t('pages.principles.detail.ownerDecision.riskNotAssessed') : view.risk.reason?.ownerText}</p>
        <p className="mt-2">{view.uncertainty.status === 'known' ? view.uncertainty.value.map(item => item.text).join(' ') : view.uncertainty.reason.ownerText}</p>
      </details>}
    </section>

    {/* ④ 推荐动作 — the system's advice and, when it says "not yet", exactly what is missing */}
    <section id="approval-section-recommendation" data-testid="approval-section-recommendation" className="border-t border-line pt-5">
      <h3 className="mb-3 text-reading font-medium text-ink">{t('pages.focus.workbench.recommendationTitle')}</h3>
      <div data-testid="approval-recommendation" data-recommendation={readiness.recommendation} className="rounded-[6px] border border-line bg-surface px-4 py-3">
        <p className="text-[14px] font-medium text-ink">{recommendationText}</p>
        <p className="mt-1 text-body leading-relaxed text-ink-3">{t(readiness.recommendationReasonKey)}</p>
      </div>
      {readiness.missing.length > 0 && (
        <div id="approval-gaps" tabIndex={-1} data-testid="approval-gaps" className="mt-4 rounded-[6px] border border-amber/30 bg-amber/5 px-4 py-3 focus-visible:outline-2 focus-visible:outline-gov">
          <p className="text-[14px] font-medium text-ink">{t('pages.focus.workbench.missingTitle')}</p>
          <ul className="mt-2 space-y-1.5">
            {readiness.missing.map(item => (
              <li key={item.key} id={gapAnchorId(item.key)} data-gap-key={item.key} className="text-body leading-relaxed text-ink-2">
                {item.key === 'gate' && materialBlocks.length > 0
                  ? materialBlocks.map(block => block.ownerText).join('；')
                  : t(item.labelKey)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{t('pages.focus.workbench.missingHint')}</p>
        </div>
      )}
      {strategicConflict !== undefined && strategicConflict.conflicts.length > 0 && (
        <div className="mt-3 rounded border border-line bg-panel px-3 py-2 text-[12px] leading-relaxed text-ink-2" data-testid={`strategic-conflict-${approvalId}`}>
          <p className="text-ink-2">
            {t(strategicBlocked ? 'pages.focus.workbench.strategicConflictBlocked' : 'pages.focus.workbench.strategicConflictResolved')}
          </p>
          <p className="mt-1">{strategicConflict.conflicts.map(conflict => `${conflict.against}:${conflict.ref}（${conflict.status}）`).join('、')}</p>
          {strategicConflict.reason !== null && <p className="mt-1">{strategicConflict.reason}</p>}
          {strategicConflict.nextAction !== null && <p className="mt-1">{strategicConflict.nextAction}</p>}
        </div>
      )}
      {review?.approval.status === 'pending' && <details className="mt-4 text-sm text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.approvalNote')}</summary><label className="mt-3 block">{t('pages.focus.workbench.approvalNote')}<textarea value={approveNote} maxLength={2000} onChange={event => setApproveNote(event.target.value)} className="mt-2 block w-full rounded border border-line bg-panel px-3 py-2" /></label></details>}
    </section>

    {/* ⑤ 决定 — pinned to the viewport bottom (R1 / §6.3), on screen for every
        approval regardless of material length. */}
    <section id="approval-section-decision" data-testid="approval-decision-bar" data-primary-action={readiness.primary} className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 px-6 pb-3 pt-4 backdrop-blur lg:left-[256px]">
      <div className="mx-auto max-w-[1120px]">
      <h3 className="mb-3 text-reading font-medium text-ink">{t('pages.focus.workbench.decision')}</h3>
      {lockedReason && <p role="alert" className="mb-3 text-body leading-relaxed text-amber">{lockedReason}</p>}
      {error && <p role="alert" className="mb-3 text-body leading-relaxed text-amber">{error}</p>}
      {resultText && <p role="status" className="mb-3 text-sm leading-relaxed text-ink">{resultText}</p>}
      {!review && !loading && <button type="button" className="text-sm text-gov underline" onClick={() => { void read(); }}>{t('pages.focus.workbench.retry')}</button>}
      {review?.approval.status === 'pending' && <>
        {revisionReview && <label className="mb-2 block text-sm text-ink-2"><input type="checkbox" checked={intentReviewed} onChange={event => setIntentReviewed(event.target.checked)} className="mr-2" />{t('pages.focus.workbench.intentReviewed')}</label>}
        <div className="flex flex-wrap items-center gap-3">
          {readiness.primary === 'look_at_gaps' && <button type="button" onClick={revealGaps} data-testid={`view-missing-btn-${principleId}`} className="rounded-[4px] border border-gov bg-gov px-4 py-2.5 text-body text-paper hover:bg-gov-2">{t('pages.focus.workbench.viewMissing')}</button>}
          {readiness.primary === 'reject' && <button type="button" disabled={primaryDisabled || !readiness.canReject} data-testid={`reject-btn-${principleId}`} onClick={startReject} className="rounded-[4px] border border-danger bg-danger px-4 py-2.5 text-body text-paper disabled:opacity-50">{t('pages.focus.workbench.rejectOne')}</button>}
          <button type="button" disabled={!readiness.canApprove || busy || Boolean(lockedReason) || Boolean(revisionReview && !intentReviewed)} data-testid={`approve-btn-${principleId}`} onClick={() => { void submit('approve'); }} className={`rounded-[4px] px-4 py-2.5 text-body ${readiness.primary === 'approve' ? 'border border-gov bg-gov text-paper' : 'border border-line text-ink'} disabled:opacity-50`}>{t(channel === 'defer_archive' ? 'pages.focus.workbench.approveArchive' : 'pages.focus.workbench.approveOne')}</button>
          {readiness.primary !== 'reject' && <button type="button" disabled={busy || Boolean(lockedReason) || !readiness.canReject} data-testid={`reject-btn-${principleId}`} onClick={startReject} className="rounded-[4px] border border-line px-4 py-2.5 text-body text-ink disabled:opacity-50">{t('pages.focus.workbench.rejectOne')}</button>}
          <button type="button" data-testid={`edit-btn-${principleId}`} disabled={busy || Boolean(lockedReason) || !readiness.canEdit || review.expectedReview.artifactState === 'missing'} onClick={() => setMode('edit')} className="text-body text-gov underline disabled:opacity-50">{t('pages.focus.workbench.replaceOne')}</button>
        </div>
        {!readiness.approveReady && <p className="mt-2 text-[12px] leading-relaxed text-ink-3" data-testid={`approve-blocked-${principleId}`}>{t('pages.focus.workbench.approveBlocked')}</p>}
        {mode && <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void submit(mode); }}>
          {mode === 'edit' && <label className="block text-sm text-ink-2">{t('pages.focus.workbench.replacementId')}<input value={newArtifact} onChange={event => setNewArtifact(event.target.value)} className="mt-2 block w-full rounded border border-line bg-panel px-3 py-2" /></label>}
          <label className="block text-sm text-ink-2">{t('pages.focus.workbench.reason')}<textarea value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} className="mt-2 block w-full rounded border border-line bg-panel px-3 py-2" /></label>
          <button type="submit" disabled={busy || !reason.trim() || (mode === 'edit' && !newArtifact.trim())} className="rounded border border-line px-4 py-2 text-sm disabled:opacity-50">{t('pages.focus.workbench.confirm')}</button>
          <button type="button" onClick={() => setMode(null)} className="ml-3 text-sm text-ink-3">{t('pages.focus.workbench.cancel')}</button>
        </form>}
      </>}
      </div>
    </section>
  </div>;
}
