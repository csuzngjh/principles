import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { fetchRuleBindingQueue, fetchRuleBindingReview, mutateRuleBinding, reviseRuleBindingOnce } from '../../api.js';
import type { RuleBindingQueueView, RuleBindingQueueItem, RuleBindingReviewView } from '../../../shared/rule-candidate-binding-contract.js';
import { splitReadingTitleBody } from '../../utils/reading-layout.js';

/**
 * PRI-1048 治理焦点「规则的正式原则归属」队列。
 * 按痛苦信号分组的有界卡片列表；每张卡默认回答三问：
 * 这是哪次反馈 / 现在卡在哪 / 我要做什么。技术 ID 与原始 JSON 只进「技术详情」。
 * 归属、规则审批、激活三权分立不变（文案见 separate/declaration）。
 */

/** Collapsed first screen shows at most this many pain groups. */
const COLLAPSED_GROUP_LIMIT = 3;

export type RuleBindingCardState =
  | 'awaiting_owner'
  | 'bound_generating'
  | 'bound_blocked'
  | 'bound_advanced'
  | 'bound_not_built'
  | 'bound_ambiguous'
  | 'revoked'
  | 'attention';

/** ERR-106: exhaustive display map over the card state union — no default branch. */
export const RULE_BINDING_CARD_STATE_KEY: Record<RuleBindingCardState, string> = {
  awaiting_owner: 'pages.focus.ruleBinding.stateAwaitingOwner',
  bound_generating: 'pages.focus.ruleBinding.stateBoundGenerating',
  bound_blocked: 'pages.focus.ruleBinding.stateBoundBlocked',
  bound_advanced: 'pages.focus.ruleBinding.stateBoundAdvanced',
  bound_not_built: 'pages.focus.ruleBinding.stateBoundNotBuilt',
  bound_ambiguous: 'pages.focus.ruleBinding.stateBoundAmbiguous',
  revoked: 'pages.focus.ruleBinding.stateRevoked',
  attention: 'pages.focus.ruleBinding.stateAttention',
};

export const RULE_BINDING_CARD_STATE_CLASS: Record<RuleBindingCardState, string> = {
  awaiting_owner: 'border-gov/40 text-gov',
  bound_generating: 'border-green/40 text-green',
  bound_blocked: 'border-amber/45 text-amber',
  bound_advanced: 'border-green/40 text-green',
  bound_not_built: 'border-line text-ink-3',
  bound_ambiguous: 'border-amber/45 text-amber',
  revoked: 'border-line text-ink-3',
  attention: 'border-amber/45 text-amber',
};

export function deriveRuleBindingCardState(item: RuleBindingQueueItem): RuleBindingCardState {
  switch (item.binding.status) {
    case 'unlinked': return 'awaiting_owner';
    case 'binding_revoked': return 'revoked';
    case 'attention': return 'attention';
    case 'bound':
      switch (item.generation?.stage) {
        case null:
        case undefined:
        case 'not_built': return 'bound_not_built';
        case 'in_progress': return 'bound_generating';
        case 'blocked': return 'bound_blocked';
        case 'advanced': return 'bound_advanced';
        case 'ambiguous': return 'bound_ambiguous';
      }
  }
}

export interface RuleBindingPainGroup {
  key: string;
  pain: RuleBindingQueueItem['pain'];
  items: RuleBindingQueueItem[];
}

/** Group by canonical pain id; a missing pain id gets its own per-candidate
 * group so unattributable candidates never vanish into someone else's group. */
export function groupRuleBindingQueue(items: RuleBindingQueueItem[]): RuleBindingPainGroup[] {
  const groups = new Map<string, RuleBindingPainGroup>();
  for (const item of items) {
    const key = item.pain.painId === '' ? `candidate:${item.candidateId}` : item.pain.painId;
    const group = groups.get(key) ?? { key, pain: item.pain, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The resume action may only appear when the real backend says ready AND the
 * chain is not currently running — a revision during an active run would be
 * a fake retry, not the bounded source revision. */
export function canOfferRuleBindingResume(item: RuleBindingQueueItem): boolean {
  return item.binding.status === 'bound'
    && item.resume?.status === 'ready'
    && item.generation?.stage !== 'in_progress'
    && item.generation?.stage !== 'ambiguous';
}

/** ERR-106: next-step copy and the left bar also use exhaustive maps. */
const RULE_BINDING_NEXT_STEP_KEY: Record<RuleBindingCardState, string> = {
  awaiting_owner: 'pages.focus.ruleBinding.nextAwaitingOwner',
  bound_generating: 'pages.focus.ruleBinding.nextBoundGenerating',
  bound_blocked: 'pages.focus.ruleBinding.nextBoundBlocked',
  bound_advanced: 'pages.focus.ruleBinding.nextBoundAdvanced',
  bound_not_built: 'pages.focus.ruleBinding.nextBoundNotBuilt',
  bound_ambiguous: 'pages.focus.ruleBinding.nextBoundAmbiguous',
  revoked: 'pages.focus.ruleBinding.nextRevoked',
  attention: 'pages.focus.ruleBinding.nextAttention',
};

const RULE_BINDING_CARD_STATE_BAR: Record<RuleBindingCardState, string> = {
  awaiting_owner: 'bg-gov',
  bound_generating: 'bg-green',
  bound_blocked: 'bg-amber',
  bound_advanced: 'bg-green',
  bound_not_built: 'bg-line-2',
  bound_ambiguous: 'bg-amber',
  revoked: 'bg-line-2',
  attention: 'bg-amber',
};

/** Model-synthesized fallback sources must stay localized (CodeRabbit PRI-1048:
 * `unknown` previously fell through to raw English in the zh-CN group header). */
export const PAIN_SOURCE_KEY: Record<string, string> = {
  unreadable: 'pages.focus.ruleBinding.sourceUnreadable',
  unknown: 'pages.focus.ruleBinding.sourceUnknown',
  manual: 'pages.focus.ruleBinding.sourceManual',
  tool_failure: 'pages.focus.ruleBinding.sourceToolFailure',
};

const STAGE_KIND_KEY: Record<string, string> = {
  dreamer: 'pages.focus.ruleBinding.stageDreamer',
  philosopher: 'pages.focus.ruleBinding.stagePhilosopher',
  scribe: 'pages.focus.ruleBinding.stageScribe',
  artificer: 'pages.focus.ruleBinding.stageArtificer',
  evaluator: 'pages.focus.ruleBinding.stageEvaluator',
  rollout_reviewer: 'pages.focus.ruleBinding.stageRolloutReviewer',
};

/** i18n with graceful fallback to the raw server code (visible, not dropped). */
function codeText(t: (key: string, params?: Record<string, unknown>) => string, prefix: string, code: string | null): string {
  if (!code) return '';
  const key = `${prefix}.${code}`;
  const text = t(key);
  return text === key ? code : text;
}

function painSourceLabel(t: (key: string) => string, source: string): string {
  const key = PAIN_SOURCE_KEY[source];
  return key ? t(key) : source;
}

function stageKindLabel(t: (key: string) => string, stageKind: string | null): string | null {
  if (!stageKind) return null;
  const key = STAGE_KIND_KEY[stageKind];
  return key ? t(key) : stageKind;
}

/** Inline in Governance Focus; assignment, rule approval and live promotion remain separate. */
export function RuleCandidateBindingPanel() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<RuleBindingQueueView | null>(null);
  const [review, setReview] = useState<RuleBindingReviewView | null>(null);
  const [openCandidateId, setOpenCandidateId] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showAllGroups, setShowAllGroups] = useState(false);
  useEffect(() => { let active = true; void fetchRuleBindingQueue().then(result => {
    if (!active) return;
    if (result.success) setQueue(result.data);
    else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
  }); return () => { active = false; }; }, [t]);

  async function load(candidateId: string, query = '') {
    setBusy(true); setError('');
    const result = await fetchRuleBindingReview(candidateId, query);
    if (result.success) { setReview(result.data); setOpenCandidateId(candidateId); setSelectedId(''); }
    else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
    setBusy(false);
  }
  function closeReview() { setOpenCandidateId(''); setReview(null); setSearch(''); setReason(''); }
  async function refreshQueue() {
    const result = await fetchRuleBindingQueue();
    if (result.success) setQueue(result.data);
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
      await refreshQueue();
    } else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
    setBusy(false);
  }
  /** Only reachable when the real resolver said ready (canOfferRuleBindingResume). */
  async function revise() {
    if (!review?.resume || review.resume.status !== 'ready' || review.resume.scribeTaskId === null || review.resume.taskRevisionEpoch === null) return;
    setBusy(true); setError(''); setMessage('');
    const result = await reviseRuleBindingOnce(review.candidateId, {
      expectedBindingRevision: review.currentRevision,
      expectedScribeTaskId: review.resume.scribeTaskId,
      expectedTaskRevisionEpoch: review.resume.taskRevisionEpoch,
      requestId: crypto.randomUUID(),
    });
    if (result.success) {
      setMessage(result.data.status === 'revision_already_started'
        ? t('pages.focus.ruleBinding.reviseAlreadyStarted')
        : t('pages.focus.ruleBinding.reviseStarted'));
      await load(review.candidateId, search);
      await refreshQueue();
    } else setError([result.error, result.nextAction].filter(Boolean).join(' ') || t('pages.focus.ruleBinding.unavailable'));
    setBusy(false);
  }

  if ((queue === null || queue.items.length === 0) && !error) return null;
  const groups = groupRuleBindingQueue(queue?.items ?? []);
  const visibleGroups = showAllGroups ? groups : groups.slice(0, COLLAPSED_GROUP_LIMIT);
  const bound = review?.currentBinding?.action === 'bind';
  return <section className="mb-7 rounded border border-line p-4" data-testid="rule-binding-panel" aria-label={t('pages.focus.ruleBinding.title')}>
    <h2 className="text-sm font-medium">{t('pages.focus.ruleBinding.title')}</h2>
    <p className="mt-2 text-sm text-ink-3">{t('pages.focus.ruleBinding.separate')}</p>
    {queue && <p className="mt-2 text-[13px] text-ink-3" role="status" data-testid="rule-binding-counts">
      {t('pages.focus.ruleBinding.countsLine', { candidates: queue.summary.candidates, painGroups: queue.summary.painGroups, bound: queue.summary.bound, unlinked: queue.summary.unlinked, blocked: queue.summary.blocked })}
    </p>}
    {queue?.truncated && <p className="mt-1 text-[12.5px] text-amber">{t('pages.focus.ruleBinding.truncatedNote', { count: queue.items.length })}</p>}
    {error && <p role="alert" className="my-2 text-amber">{error}</p>}
    {message && <p role="status" className="my-2">{message}</p>}
    {visibleGroups.map(group => <div key={group.key} className="mt-4" data-testid="rule-binding-pain-group">
      <div className="border-l-2 border-line pl-3">
        <div className="text-[13px] text-ink-2 leading-relaxed">
          <span className="font-medium text-ink">{t('pages.focus.ruleBinding.groupPrefix')}</span>
          {' '}
          {group.pain.text
            ? splitReadingTitleBody(group.pain.text).title
            : t('pages.focus.ruleBinding.painUnrecorded')}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-4">
          {painSourceLabel(t, group.pain.source)}
          {group.pain.createdAt ? ` · ${group.pain.createdAt.slice(0, 10)}` : ''}
          {' · '}
          {t('pages.focus.ruleBinding.groupCount', { count: group.items.length })}
        </div>
      </div>
      {group.items.map(item => {
        const cardState = deriveRuleBindingCardState(item);
        const layout = splitReadingTitleBody(item.text);
        const open = openCandidateId === item.candidateId;
        return <article key={item.candidateId} className="relative mt-3 pl-[22px] py-[14px] pr-[18px] bg-panel border border-line rounded-[6px]" data-testid={`rule-binding-card-${item.candidateId}`}>
          <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[6px] ${RULE_BINDING_CARD_STATE_BAR[cardState]}`} />
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center border rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${RULE_BINDING_CARD_STATE_CLASS[cardState]}`}>
              {t(RULE_BINDING_CARD_STATE_KEY[cardState])}
            </span>
            {(() => { const stageLabel = stageKindLabel(t, item.generation?.stageKind ?? null); return stageLabel
              ? <span className="text-[11.5px] text-ink-4">{t('pages.focus.ruleBinding.currentStage')}{stageLabel}</span>
              : null; })()}
          </div>
          <div className="mt-[10px] mb-1 font-semibold text-ink leading-snug" data-testid={`rule-binding-title-${item.candidateId}`}>{layout.title}</div>
          {layout.body !== null && <div className="mb-2 text-[14px] leading-relaxed text-ink-2 whitespace-pre-wrap break-words">{layout.body}</div>}
          {item.binding.status === 'bound' && <div className="mt-2 px-3 py-2 bg-surface/60 border-l-2 border-gov text-[13px] leading-relaxed">
            <span className="text-ink-3">{t('pages.focus.ruleBinding.boundTo')}</span>{' '}
            <span className="text-ink">{splitReadingTitleBody(item.binding.principle.text).title}</span>
            {' · '}
            <span className="text-ink-4">{t(`principles.status${item.binding.principle.status[0]?.toUpperCase()}${item.binding.principle.status.slice(1)}`, { defaultValue: item.binding.principle.status })} · {t('pages.focus.ruleBinding.version')} {item.binding.principle.version}</span>
            {' · '}
            <Link to={`/principles/${item.binding.principle.principleId}`} className="text-gov underline">{t('pages.focus.ruleBinding.viewPrinciple')}</Link>
          </div>}
          {cardState === 'bound_blocked' && item.generation && <div className="mt-2 text-[12.5px] leading-relaxed text-amber" data-testid={`rule-binding-blocked-${item.candidateId}`}>
            {t('pages.focus.ruleBinding.blockedLine', {
              stage: stageKindLabel(t, item.generation.stageKind) ?? '',
              reason: codeText(t, 'pages.focus.ruleBinding.blockReason', item.generation.reasonCode) || t('pages.focus.ruleBinding.blockReasonUnknown'),
            })}
            <div className="mt-0.5 text-ink-3">{t('pages.focus.ruleBinding.blockedNoOwnerApproval')}</div>
            {item.generation.detail && <details className="mt-1 text-[11.5px]">
              <summary className="cursor-pointer select-none">{t('pages.focus.ruleBinding.blockedDetail')}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{item.generation.detail}</pre>
            </details>}
          </div>}
          {cardState === 'attention' && <div className="mt-2 text-[12.5px] leading-relaxed text-amber" data-testid={`rule-binding-attention-${item.candidateId}`}>
            {t('pages.focus.ruleBinding.attentionLine', { reason: item.binding.status === 'attention' ? item.binding.reason : '' })}
          </div>}
          <div className="mt-2 text-[12.5px] text-ink-3 leading-relaxed" data-testid={`rule-binding-next-${item.candidateId}`}>
            <span className="font-medium">{t('pages.focus.ruleBinding.nextLabel')}</span>{' '}
            {cardState === 'bound_blocked' && item.resume?.status === 'refused'
              ? t('pages.focus.ruleBinding.nextBoundBlockedNoResume', { reason: codeText(t, 'pages.focus.ruleBinding.resumeReason', item.resume.reason) })
              : t(RULE_BINDING_NEXT_STEP_KEY[cardState])}
          </div>
          <details className="mt-2 text-[11.5px] text-ink-4">
            <summary className="cursor-pointer select-none">{t('pages.focus.ruleBinding.techDetails')}</summary>
            <dl className="mt-1 font-mono text-[11px] break-all">
              <div>candidateId: {item.candidateId}</div>
              <div>painId: {item.pain.painId || '—'}</div>
              {item.binding.status === 'bound' && <div>bindingRevision: {item.binding.principle.revision} · decidedAt: {item.binding.principle.decidedAt || '—'}</div>}
              {item.resume && <div>resume: {item.resume.status}{item.resume.reason ? ` (${item.resume.reason})` : ''}{item.resume.scribeTaskId ? ` · ${item.resume.scribeTaskId}` : ''}</div>}
            </dl>
          </details>
          <button type="button" className="mt-3 inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy} aria-expanded={open}
            onClick={() => { if (open) closeReview(); else { setSearch(''); setReason(''); void load(item.candidateId); } }}>
            {open ? t('pages.focus.ruleBinding.closeReview') : t('pages.focus.ruleBinding.openReview')}
          </button>
          {open && review && review.candidateId === item.candidateId && <div className="mt-4 border-t border-line pt-3">
            <h3 className="font-medium text-[13px]">{t('pages.focus.ruleBinding.candidate')}</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm">{review.candidateText}</p>
            <p className="mt-2 text-sm">{t('pages.focus.ruleBinding.pain')}：{review.sourcePain.text ?? t('pages.focus.ruleBinding.painUnrecorded')}</p>
            <details className="mt-2 text-sm"><summary>{t('pages.focus.ruleBinding.evidence')}</summary><pre className="whitespace-pre-wrap break-words">{review.evidence}</pre></details>
            {bound && review.boundPrinciple && <>
              <div className="mt-3 px-3 py-2 bg-surface/60 border-l-2 border-gov text-[13px] leading-relaxed">
                <div className="whitespace-pre-wrap">{review.boundPrinciple.text}</div>
                <div className="mt-1 text-ink-4">{t('pages.focus.ruleBinding.boundSince', { revision: review.boundPrinciple.revision, date: review.boundPrinciple.decidedAt.slice(0, 10) || '—' })} · <Link to={`/principles/${review.boundPrinciple.principleId}`} className="text-gov underline">{t('pages.focus.ruleBinding.viewPrinciple')}</Link></div>
              </div>
              {canOfferRuleBindingResume({ ...item, resume: review.resume }) && <button type="button" className="mt-3 rounded border border-gov bg-gov text-paper px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => void revise()}>
                {t('pages.focus.ruleBinding.reviseCta')}
              </button>}
              {review.resume?.status === 'refused' && <p className="mt-3 text-[12.5px] text-ink-3 leading-relaxed">
                {t('pages.focus.ruleBinding.resumeUnavailable', { reason: codeText(t, 'pages.focus.ruleBinding.resumeReason', review.resume.reason) })}
              </p>}
              {review.generation?.stage === 'in_progress' && <p className="mt-3 text-[12.5px] text-ink-3">{t('pages.focus.ruleBinding.nextBoundGenerating')}</p>}
            </>}
            {!bound && <>
              <p className="mt-3 text-sm text-ink-3">{t('pages.focus.ruleBinding.chooseTarget')}</p>
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
            <div className="mt-3 flex gap-2 flex-wrap">
              {!bound && <button type="button" className="rounded border border-gov px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !reason.trim() || !selectedId} onClick={() => void decide('bind')}>
                {t('pages.focus.ruleBinding.bind')}
              </button>}
              {bound && <button type="button" className="rounded border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !reason.trim()} onClick={() => void decide('revoke')}>
                {t('pages.focus.ruleBinding.revokeSecondary')}
              </button>}
            </div>
            <p className="mt-3 text-sm text-ink-3">{t('pages.focus.ruleBinding.revokeBoundary')} <Link to="/activation" className="underline">{t('pages.focus.ruleBinding.stop')}</Link></p>
          </div>}
        </article>;
      })}
    </div>)}
    {groups.length > COLLAPSED_GROUP_LIMIT && <button type="button" className="mt-3 text-[12.5px] text-gov underline" onClick={() => setShowAllGroups(value => !value)}
      aria-expanded={showAllGroups} data-testid="rule-binding-groups-toggle">
      {showAllGroups
        ? t('pages.focus.ruleBinding.hideRemaining')
        : t('pages.focus.ruleBinding.viewRemaining', { count: groups.length - COLLAPSED_GROUP_LIMIT })}
    </button>}
  </section>;
}
