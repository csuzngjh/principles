import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchApprovalReview, fetchOwnerDecisionView, approveApproval, rejectApproval, editApproval, fetchAllActivations } from '../../api.js';
import { localizeApprovalWarning } from '../../utils/approval-warning-localization.js';
import type { ApprovalsGroupedData } from '../../api.js';
import type { ApprovalReviewData } from '../../utils/approval-review.js';
import type { OwnerDecisionViewCore, NarrativeField } from '@principles/core/runtime-v2';

export function ApprovalSubjectReading({ principleId, approvalId, artifactId, channel, lockedReason, targetHost, onResolved, revisionReview, revisionReviewUnavailable, budgetNotice, promptInjection, sourceUnlinked }: {
  principleId: string; approvalId: string; artifactId: string; channel: string; lockedReason?: string;
  targetHost?: 'openclaw' | 'codex' | 'workbuddy'; onResolved?: (message: string) => void;
  revisionReview?: { artifactId?: string; artifactDigest?: string; oldStatement: string; newStatement: string; intentFields: Record<string, string> };
  revisionReviewUnavailable?: boolean; budgetNotice?: string; promptInjection?: ApprovalsGroupedData['promptInjection']; sourceUnlinked?: boolean;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [review, setReview] = useState<ApprovalReviewData | null>(null);
  const [view, setView] = useState<OwnerDecisionViewCore | null>(null);
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
    setReview(null); setLoading(true); setIntentReviewed(false);
    const result = await fetchApprovalReview(approvalId);
    if (current !== epoch.current) return null;
    setLoading(false);
    if (result.success) { setReview(result.data); return result.data; }
    setError([result.error, result.nextAction].filter(Boolean).join(' '));
    return null;
  }, [approvalId]);
  useEffect(() => {
    setError(''); setResultText(''); setView(null); setMode(null); setReason(''); setNewArtifact(''); setApproveNote('');
    let current = true;
    void read();
    void fetchOwnerDecisionView(principleId).then(result => { if (current && result.success) setView(result.data); });
    return () => { current = false; epoch.current++; };
  }, [principleId, approvalId, artifactId, channel, read]);
  const narrative = (field: NarrativeField) => field.status === 'known' ? field.value.map(item => item.text).join('\n\n') : field.reason.ownerText;
  const subject = view?.decisionSubjects.find(item => item.key === approvalId && item.channel === channel
    && item.revisionArtifactId.status === 'known' && item.revisionArtifactId.value === review?.expectedReview.artifactId);
  const materialBlocks = subject?.materialGates.find(gate => gate.actionSemantic === 'approve')?.requiredItems.filter(item => item.status !== 'satisfied') ?? [];
  const revisionMatches = !revisionReview || (review?.expectedReview.artifactState === 'present' && review.expectedReview.artifactId === artifactId
    && revisionReview.artifactId === review.expectedReview.artifactId && revisionReview.artifactDigest === review.expectedReview.artifactDigest);
  const approveReady = review?.approval.status === 'pending' && review.expectedReview.artifactState === 'present' && review.material.exactBody !== null && review.material.availability === 'available' && revisionMatches && !revisionReviewUnavailable && materialBlocks.length === 0;
  async function submit(action: 'approve' | 'reject' | 'edit') {
    if (!review || busy || lockedReason || review.approval.status !== 'pending') return;
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
      let message = t(fresh.approval.status === 'approved' ? 'pages.focus.workbench.approved' : 'pages.focus.workbench.rejected');
      if (fresh.approval.status === 'approved' && !result.success) {
        const activations = await fetchAllActivations(targetHost);
        if (epoch.current !== current + 1) return;
        const active = activations.success && activations.data.activations.some(item => item.artifactId === fresh.approval.artifactId && item.status === 'active');
        message = t(active ? 'pages.focus.workbench.approved' : result.reason === 'activation_failed' ? 'pages.focus.workbench.activationFailed' : 'pages.focus.workbench.approvedRuntimeUnknown');
      }
      if (result.success && result.data.warning) {
        const warning = localizeApprovalWarning(result.data.warning, t);
        message += ` ${warning.title} ${warning.body ?? warning.detail}`;
      }
      setResultText(message); onResolved?.(message); return;
    }
    if (!result.success) setError(t('pages.focus.workbench.notRecorded') + ' ' + [result.error, result.nextAction].filter(Boolean).join(' '));
    else if (action === 'edit') { setResultText(t('pages.focus.workbench.replaced')); setMode(null); setReason(''); setNewArtifact(''); setApproveNote(''); }
  }
  const body = review?.material.exactBody;
  const bodyText = body?.text ?? review?.material.statement ?? '';
  return <div className="space-y-7">
    <section><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.why')}</h3>
      {sourceUnlinked && <p role="alert" className="mb-3 text-sm leading-relaxed text-amber">{t('pages.focus.workbench.sourceUnlinked')}</p>}
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{view ? narrative(view.incidentSummary) : t('pages.focus.workbench.materialUnavailable')}</p>
    </section>
    <section><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.proposal')}</h3>
      {loading ? <p role="status" className="text-sm text-ink-3">{t('pages.focus.workbench.loading')}</p> : <>
        {bodyText ? <>
          <p className="mb-2 text-[12px] text-ink-4">{t(body?.kind === 'rule_code' ? 'pages.focus.workbench.codePreview' : 'pages.focus.workbench.textPreview')}</p>
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.85] text-ink">{bodyText.length > 240 ? bodyText.slice(0, 240) + '…' : bodyText}</p>
          <details className="mt-4 rounded-[4px] border border-line px-4 py-3 text-[13px]"><summary className="cursor-pointer text-gov">{t(body?.kind === 'rule_code' ? 'pages.focus.workbench.fullCode' : 'pages.focus.workbench.fullText')}</summary>
            <div className="mt-4 whitespace-pre-wrap break-words leading-[1.85] text-ink-2">{bodyText}</div>
          </details>
        </> : <p className="text-sm text-amber">{t('pages.focus.workbench.exactMaterialMissing')}</p>}
        {review?.material.scope.length ? <div className="mt-4"><h4 className="text-sm font-medium text-ink">{t('pages.focus.workbench.scope')}</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-ink-2">{review.material.scope.map((scope, index) => <li key={index}>{scope}</li>)}</ul></div> : null}
        {review?.material.rationale && <details className="mt-4 text-[13px] text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.reasonAndScope')}</summary><p className="mt-3 whitespace-pre-wrap leading-relaxed">{review.material.rationale}</p></details>}
        {revisionReview && <details className="mt-4 text-[13px] leading-relaxed text-ink-2"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.compare')}</summary>
          <p className="mt-3 whitespace-pre-wrap">{revisionReview.oldStatement}</p><p className="mt-3 whitespace-pre-wrap">{revisionReview.newStatement}</p>
          <dl className="mt-3">{Object.entries(revisionReview.intentFields).map(([key, value]) => <div key={key}><dt className="font-medium">{t(`pages.focus.intentField.${key}`, { defaultValue: key })}</dt><dd>{value}</dd></div>)}</dl>
        </details>}
      </>}
    </section>
    <section className="border-t border-line pt-5" data-testid="approval-review-limits"><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.beforeDecision')}</h3>
      {!subject && <p className="text-sm leading-relaxed text-amber">{t('pages.focus.workbench.subjectUnconfirmed')}</p>}
      {review && <div className="mb-3 text-sm leading-relaxed text-ink-2" data-testid="approval-exact-risks">
        {review.material.risks?.length ? <ul className="list-disc space-y-1 pl-5">{review.material.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul> : <p>{t(review.material.risks === null ? 'pages.focus.workbench.risksUnknown' : 'pages.focus.workbench.risksEmpty')}</p>}
      </div>}
      {materialBlocks.map(item => <p key={item.key} className="mb-2 text-sm leading-relaxed text-amber">{item.ownerText}</p>)}
      {!revisionMatches && <p role="alert" className="mb-2 text-sm text-amber">{t('pages.focus.workbench.revisionChanged')}</p>}
      {revisionReviewUnavailable && <p role="alert" className="mb-2 text-sm text-amber">{t('pages.focus.revisionReviewUnavailable')}</p>}
      {budgetNotice && channel === 'prompt' && <p role="alert" className="mb-2 text-sm leading-relaxed text-amber" data-testid={`approve-queue-badge-${principleId}`}>{budgetNotice}</p>}
      {promptInjection && channel === 'prompt' && <details className="mb-3 text-[12px] leading-relaxed text-ink-3" data-testid={`approve-queue-badge-scope-${principleId}`}><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.budgetBasis')}</summary>
        <p className="mt-2">{promptInjection.route === 'shared_render' ? t('pages.focus.promptScopeShared') : t('pages.focus.promptScopeList', { full: promptInjection.fullRenderChars !== undefined ? t('pages.focus.promptScopeFullRender', { count: promptInjection.fullRenderChars }) : '' })}{promptInjection.hostKind ? ` · ${promptInjection.hostKind}` : ''}</p>
        <p className="mt-2">{promptInjection.budgetCapacityStatus === 'confirmed' && promptInjection.budgetContextWindowTokens !== undefined
          ? promptInjection.budgetObservedAt !== undefined ? t('pages.focus.promptBudgetObservedNote', { source: t(promptInjection.budgetCapacitySource === 'pi_catalog_exact' ? 'pages.focus.budgetCapacitySourcePiCatalog' : promptInjection.budgetCapacitySource === 'operator_declared' ? 'pages.focus.budgetCapacitySourceOperatorDeclared' : 'pages.focus.budgetCapacitySourceHostWindow'), window: promptInjection.budgetContextWindowTokens, observedAt: promptInjection.budgetObservedAt })
            : t('pages.focus.promptBudgetModelAwareNote', { window: promptInjection.budgetContextWindowTokens, sourceSuffix: promptInjection.budgetCapacitySource === 'operator_declared' ? t('pages.focus.budgetCapacitySourceOperatorDeclaredSuffix') : '' })
          : promptInjection.budgetObservedAt !== undefined ? t('pages.focus.promptBudgetFallbackObservedNote', { reason: t(`pages.focus.budgetFallbackReason.${promptInjection.budgetFallbackReason}`, { defaultValue: promptInjection.budgetFallbackReason ?? 'unknown' }), observedAt: promptInjection.budgetObservedAt })
            : t('pages.focus.promptBudgetFallbackNote', { reason: promptInjection.budgetFallbackReason ? t('pages.focus.promptBudgetFallbackReasonSuffix', { code: t(`pages.focus.budgetFallbackReason.${promptInjection.budgetFallbackReason}`, { defaultValue: promptInjection.budgetFallbackReason }) }) : '' })}</p>
      </details>}
      {subject && <p className="text-sm leading-relaxed text-ink-2">{narrative(subject.decisionMaterial.consequence)}</p>}
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('pages.focus.workbench.scopeUnknown')}</p>
      {view && <details className="mt-3 text-[13px] leading-relaxed text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.principleLimits')}</summary>
        <p className="mt-3">{view.nonApplicabilityOrUnknown.status === 'known' ? view.nonApplicabilityOrUnknown.value.map(item => item.text).join(' ') : view.nonApplicabilityOrUnknown.reason.ownerText}</p>
        <p className="mt-2">{view.risk.status === 'known' ? view.risk.value?.items.map(item => item.text).join(' ') || t('pages.principles.detail.ownerDecision.riskNotAssessed') : view.risk.reason?.ownerText}</p>
        <p className="mt-2">{view.uncertainty.status === 'known' ? view.uncertainty.value.map(item => item.text).join(' ') : view.uncertainty.reason.ownerText}</p>
      </details>}
    </section>
    <section className="border-t border-line pt-5"><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.decision')}</h3>
      {lockedReason && <p role="alert" className="mb-3 text-[13px] leading-relaxed text-amber">{lockedReason}</p>}
      {error && <p role="alert" className="mb-3 text-[13px] leading-relaxed text-amber">{error}</p>}
      {resultText && <p role="status" className="mb-3 text-sm leading-relaxed text-ink">{resultText}</p>}
      {!review && !loading && <button type="button" className="text-sm text-gov underline" onClick={() => { void read(); }}>{t('pages.focus.workbench.retry')}</button>}
      {review?.approval.status === 'pending' && <>
        <details className="mb-4 text-sm text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.approvalNote')}</summary><label className="mt-3 block">{t('pages.focus.workbench.approvalNote')}<textarea value={approveNote} maxLength={2000} onChange={event => setApproveNote(event.target.value)} className="mt-2 block w-full rounded border border-line bg-panel px-3 py-2" /></label></details>
        {revisionReview && <label className="mb-4 block text-sm text-ink-2"><input type="checkbox" checked={intentReviewed} onChange={event => setIntentReviewed(event.target.checked)} className="mr-2" />{t('pages.focus.workbench.intentReviewed')}</label>}
        <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3">{t(channel === 'code_tool_hook' ? 'pages.focus.workbench.ruleConsequence' : channel === 'defer_archive' ? 'pages.focus.workbench.archiveConsequence' : 'pages.focus.workbench.promptConsequence')}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={!approveReady || busy || Boolean(lockedReason) || Boolean(revisionReview && !intentReviewed)} data-testid={`approve-btn-${principleId}`} onClick={() => { void submit('approve'); }} className="rounded-[4px] border border-gov bg-gov px-4 py-2.5 text-[13px] text-paper disabled:opacity-50">{t(channel === 'defer_archive' ? 'pages.focus.workbench.approveArchive' : 'pages.focus.workbench.approveOne')}</button>
          <button type="button" disabled={busy || Boolean(lockedReason)} onClick={() => setMode('reject')} className="rounded-[4px] border border-line px-4 py-2.5 text-[13px] text-ink disabled:opacity-50">{t('pages.focus.workbench.rejectOne')}</button>
          <button type="button" data-testid={`edit-btn-${principleId}`} disabled={busy || Boolean(lockedReason) || review.expectedReview.artifactState === 'missing'} onClick={() => setMode('edit')} className="text-[13px] text-gov underline disabled:opacity-50">{t('pages.focus.workbench.replaceOne')}</button>
        </div>
        {mode && <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void submit(mode); }}>
          {mode === 'edit' && <label className="block text-sm text-ink-2">{t('pages.focus.workbench.replacementId')}<input value={newArtifact} onChange={event => setNewArtifact(event.target.value)} className="mt-2 block w-full rounded border border-line bg-panel px-3 py-2" /></label>}
          <label className="block text-sm text-ink-2">{t('pages.focus.workbench.reason')}<textarea value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} className="mt-2 block w-full rounded border border-line bg-panel px-3 py-2" /></label>
          <button type="submit" disabled={busy || !reason.trim() || (mode === 'edit' && !newArtifact.trim())} className="rounded border border-line px-4 py-2 text-sm disabled:opacity-50">{t('pages.focus.workbench.confirm')}</button>
          <button type="button" onClick={() => setMode(null)} className="ml-3 text-sm text-ink-3">{t('pages.focus.workbench.cancel')}</button>
        </form>}
      </>}
      <Link className="mt-5 inline-block text-[13px] text-gov underline underline-offset-4" state={{ returnTo: `/focus${location.search}` }} to={`/principles/${encodeURIComponent(principleId)}`}>{t('pages.focus.workbench.openPrinciple')}</Link>
      <details className="mt-4 text-[12px] text-ink-4"><summary className="cursor-pointer">{t('pages.focus.workbench.subjectDetails')}</summary>
        <dl className="mt-2 break-all font-mono"><div>approval: {approvalId}</div><div>artifact: {review?.expectedReview.artifactId ?? artifactId}</div><div>channel: {review?.expectedReview.channel ?? channel}</div></dl>
      </details>
    </section>
  </div>;
}
