import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { fetchRuleBindingQueue, fetchRuleBindingReview, mutateRuleBinding } from '../../api.js';
import type { RuleBindingQueueView, RuleBindingReviewView } from '../../../shared/rule-candidate-binding-contract.js';

/** Inline in Governance Focus; assignment, rule approval and live promotion remain separate. */
export function RuleCandidateBindingPanel() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<RuleBindingQueueView | null>(null);
  const [review, setReview] = useState<RuleBindingReviewView | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { let active = true; void fetchRuleBindingQueue().then(result => {
    if (!active) return;
    if (result.success) setQueue(result.data);
    else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
  }); return () => { active = false; }; }, [t]);

  async function load(candidateId: string, query = '') {
    setBusy(true); setError('');
    const result = await fetchRuleBindingReview(candidateId, query);
    if (result.success) { setReview(result.data); setSelectedId(''); }
    else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
    setBusy(false);
  }
  async function decide(action: 'bind' | 'revoke') {
    if (!review) return;
    const target = review.eligibleTargets.find(p => p.principleId === selectedId);
    if (action === 'bind' && !target) return;
    setBusy(true); setError(''); setMessage('');
    const requestId = crypto.randomUUID();
    const common = { expectedRevision: review.currentRevision, reason, requestId };
    const result = await mutateRuleBinding(review.candidateId, action === 'bind' && target
      ? { ...common, action: 'bind', resumeOnce: true, principleId: target.principleId, expectedCandidateDigest: review.candidateDigest, expectedPrincipleDigest: target.digest }
      : { ...common, action: 'revoke', resumeOnce: false });
    if (result.success) {
      setMessage(action === 'revoke' ? t('pages.focus.ruleBinding.revoked')
        : result.data.revisionStatus === 'refused' ? t('pages.focus.ruleBinding.resumeFailed') : t('pages.focus.ruleBinding.bound'));
      await load(review.candidateId, search);
    } else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
    setBusy(false);
  }
  if (queue?.items.length === 0 && !error) return null;
  const bound = review?.currentBinding?.action === 'bind';
  return <section className="mb-7 rounded border border-line p-4" data-testid="rule-binding-panel" aria-label={t('pages.focus.ruleBinding.title')}>
    <h2 className="text-sm font-medium">{t('pages.focus.ruleBinding.title')}</h2>
    <p className="mt-2 text-sm text-ink-3">{t('pages.focus.ruleBinding.separate')}</p>
    {error && <p role="alert" className="my-2 text-amber">{error}</p>}
    {message && <p role="status" className="my-2">{message}</p>}
    {queue?.items.map(item => <button key={item.candidateId} className="mt-2 block text-left text-sm underline" disabled={busy} onClick={() => { setSearch(''); setReason(''); void load(item.candidateId); }}>
      {item.reason === 'bound' ? t('pages.focus.ruleBinding.manage') : t('pages.focus.ruleBinding.awaiting')} · {item.text.slice(0, 100)}
    </button>)}
    {review && <div className="mt-4 border-t border-line pt-3">
      <h3 className="font-medium">{t('pages.focus.ruleBinding.candidate')}</h3>
      <p className="whitespace-pre-wrap text-sm">{review.candidateText}</p>
      <p className="mt-2 text-sm">{t('pages.focus.ruleBinding.pain')}：{review.sourcePainId}</p>
      <details className="mt-2 text-sm"><summary>{t('pages.focus.ruleBinding.evidence')}</summary><pre className="whitespace-pre-wrap break-words">{review.evidence}</pre></details>
      <p className="mt-3 text-sm">{t('pages.focus.ruleBinding.current')}：{bound ? review.currentBinding?.principleId : t('pages.focus.ruleBinding.unlinked')}</p>
      {!bound && <>
        <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void load(review.candidateId, search); }}>
          <input value={search} onChange={event => setSearch(event.target.value)} maxLength={200} aria-label={t('pages.focus.ruleBinding.search')} className="border border-line p-2 text-sm" />
          <button disabled={busy} type="submit">{t('pages.focus.ruleBinding.search')}</button>
        </form>
        {review.eligibleTargets.length === 0 && <p className="mt-2 text-sm">{t('pages.focus.ruleBinding.noTarget')} <Link to="/principles" className="underline">{t('pages.focus.ruleBinding.formation')}</Link></p>}
        {review.eligibleTargets.map(target => <label key={target.principleId} className="my-3 block border border-line p-3 text-sm">
          <input type="radio" name="binding-target" value={target.principleId} checked={selectedId === target.principleId} onChange={() => setSelectedId(target.principleId)} />
          <span className="ml-2">{t(`principles.status${target.status[0]?.toUpperCase()}${target.status.slice(1)}`, { defaultValue: target.status })} · {t('pages.focus.ruleBinding.version')} {target.version}</span>
          <p className="mt-2 whitespace-pre-wrap">{target.text}</p>
        </label>)}
        <p className="mt-3 text-sm text-ink-3">{review.resumeNotice}</p>
        <p className="mt-2 text-sm">{t('pages.focus.ruleBinding.declaration')}</p>
      </>}
      <label className="mt-3 block text-sm">{t('pages.focus.ruleBinding.reason')}<textarea className="mt-1 block w-full border border-line p-2" maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button className="mt-3 rounded border border-gov px-3 py-2 text-sm" disabled={busy || !reason.trim() || (!bound && !selectedId)} onClick={() => void decide(bound ? 'revoke' : 'bind')}>
        {bound ? t('pages.focus.ruleBinding.revoke') : t('pages.focus.ruleBinding.bind')}
      </button>
      <p className="mt-3 text-sm text-ink-3">{t('pages.focus.ruleBinding.revokeBoundary')} <Link to="/activation" className="underline">{t('pages.focus.ruleBinding.stop')}</Link></p>
    </div>}
  </section>;
}
