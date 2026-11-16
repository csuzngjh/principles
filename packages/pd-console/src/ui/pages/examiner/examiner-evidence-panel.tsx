import React from 'react';
import { useTranslation } from 'react-i18next';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { enumLabel } from '../../utils/enum-labels.js';
import type { ExaminerEvidenceData } from '../../api.js';

/**
 * SPEC-PD-EXAMINER-001 §4/§5 — the production-evidence panel.
 *
 * Renders ONE principle's production evidence with the honesty contract
 * pinned in the server contract: Projection / Submitted / Presence /
 * Context Present / Runtime Loaded stay distinct; agent claims never count
 * as runtime verification; a degraded lane shows its reason — an
 * unavailable source is NEVER presented as "zero events".
 *
 * 2026-11 rework: this panel lives inside the page's collapsed technical
 * fold. Every lane/row enum goes through `enumLabel`; degraded reasons lead
 * with the Chinese sentence keyed by the lane's reasonCode (raw English
 * stays as a small forensics sub-line). Long mono tokens (ids, hashes)
 * wrap inside their cell instead of spilling across the grid.
 */
export function ExaminerEvidencePanel({ evidence, compact = false }: { evidence: ExaminerEvidenceData; compact?: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const { principle, activation, injection, receipts, evidenceAudit } = evidence;

  /** Chinese sentence for a degraded lane; generic fallback for unknown codes. */
  const reasonSentence = (code: string | undefined): string =>
    code === undefined
      ? t('pages.examiner.reasons.fallback')
      : t(`pages.examiner.reasons.${code}`, { defaultValue: t('pages.examiner.reasons.fallback') });

  /**
   * Raw server reason as a small forensics sub-line. This panel lives inside
   * the page's collapsed technical fold, so the original diagnostic text
   * (which may embed the real error message) stays available here.
   */
  const reasonForensics = (raw: string | undefined): React.ReactNode =>
    raw === undefined || raw === '' ? null : (
      <span className="mt-0.5 block font-mono text-caption break-all opacity-70" data-technical>{raw}</span>
    );

  const laneChipClass = (ok: boolean): string =>
    ok ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';

  return (
    <div className="grid gap-4" data-testid="examiner-evidence-panel">
      {/* Principle identity + lifecycle */}
      <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-principle">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs" data-testid="examiner-evidence-principle-id">{principle.id}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs">
            {t('pages.examiner.evidence.ledgerStatus')}: {enumLabel('principleStatus', principle.status, t)}
          </span>
          {principle.runtimeDeactivated === true && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">{t('pages.examiner.evidence.runtimeDeactivated')}</span>
          )}
        </div>
        <p className="mt-2 text-ink-2">{truncateByCodePoints(principle.text, compact ? 160 : 400)}</p>
        <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground sm:grid-cols-4">
          <div>{t('pages.examiner.evidence.ruleCount')}: {principle.ruleCount}</div>
          <div data-testid="examiner-evidence-pain-refs">
            {t('pages.examiner.evidence.painRefs')}: {principle.derivedFromPainIds.length}
          </div>
          <div>{t('pages.examiner.evidence.evaluability')}: {enumLabel('evaluability', principle.evaluability, t)}</div>
          <div>{t('pages.examiner.evidence.painPrevented')}: {principle.painPreventedCount}</div>
        </div>
        {/* PRI-956 (F15) in Owner language: asset lifecycle ≠ runtime
            activation — replaces the old server-side ledgerStatusNote. */}
        <p className="mt-2 text-caption text-muted-foreground" data-testid="examiner-evidence-ledger-note">
          {t('pages.examiner.evidence.ledgerNote')}
        </p>
      </div>

      {/* Runtime activation + prompt injection lanes */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-activation">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{t('pages.examiner.evidence.activation.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${laneChipClass(activation.status === 'ok')}`} data-testid="examiner-evidence-activation-status">
              {enumLabel('examinerLane', activation.status, t)}
            </span>
          </div>
          {activation.status !== 'ok' && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="examiner-evidence-activation-reason">
              {reasonSentence(activation.reasonCode)}
              {reasonForensics(activation.reason)}
            </p>
          )}
          <div className="mt-2 grid gap-1 text-xs">
            <div>{t('pages.examiner.evidence.activation.promptRows')}: <span className="font-mono">{activation.prompt.length}</span></div>
            {activation.prompt.filter((_, index) => index < 4).map((row) => (
              <div key={row.activationId} className="font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">
                {enumLabel('activationStatus', row.status, t)} · {row.action}{row.enforcement ? ` · ${row.enforcement}` : ''}
              </div>
            ))}
            <div className="mt-1">{t('pages.examiner.evidence.activation.ruleCodeRows')}: <span className="font-mono">{activation.ruleCode.length}</span></div>
            {activation.ruleCode.filter((_, index) => index < 4).map((row) => (
              <div key={row.activationId} className="font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">
                {row.mode === undefined ? t('pages.examiner.evidence.modeUnknown') : row.mode} · {enumLabel('activationStatus', row.status, t)} · {row.enforcement ?? '—'}
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-injection">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{t('pages.examiner.evidence.injection.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${laneChipClass(injection.status === 'available')}`} data-testid="examiner-evidence-injection-status">
              {enumLabel('examinerLane', injection.status, t)}
            </span>
          </div>
          {injection.status === 'degraded' && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="examiner-evidence-injection-reason">
              {reasonSentence(injection.reasonCode)}
              {reasonForensics(injection.globalReason)}
            </p>
          )}
          <div className="mt-2 grid gap-1 text-xs">
            {injection.statuses.length === 0 && (
              <div className="text-muted-foreground">{t('pages.examiner.evidence.injection.noRows')}</div>
            )}
            {injection.statuses.filter((_, index) => index < 4).map((row) => (
              <div key={row.activationId} className="font-mono text-caption [overflow-wrap:anywhere]">
                {enumLabel('injectionStatus', row.status, t)}
                {row.inCurrentWindow !== undefined ? ` · ${t('pages.examiner.evidence.injection.inWindow', { state: row.inCurrentWindow ? t('common.yes') : t('common.no') })}` : ''}
                {row.costChars !== undefined ? ` · ${t('pages.examiner.evidence.injection.costChars', { count: row.costChars })}` : ''}
                {row.route ? ` · ${row.route}` : ''}
              </div>
            ))}
            {injection.budgetProvenance && (
              <div className="mt-1 text-caption text-muted-foreground" data-testid="examiner-evidence-budget-provenance">
                {t('pages.examiner.evidence.injection.budget')}: {injection.budgetProvenance.capacitySource ?? '—'} / {injection.budgetProvenance.capacityStatus ?? '—'} / {injection.budgetProvenance.policyVersion ?? '—'}
              </div>
            )}
          </div>
          <p className="mt-2 text-caption text-muted-foreground">{t('pages.examiner.evidence.injection.projectionNote')}</p>
        </div>
      </div>

      {/* Receipts + evidence audit */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-receipts">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{t('pages.examiner.evidence.receipts.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${laneChipClass(receipts.status === 'ok')}`}>
              {enumLabel('examinerLane', receipts.status, t)}
            </span>
          </div>
          {receipts.status !== 'ok' && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="examiner-evidence-receipts-reason">
              {reasonSentence(receipts.coverage?.reasonCode)}
              {reasonForensics(receipts.reason)}
            </p>
          )}
          <div className="mt-2 text-xs">
            <div>{t('pages.examiner.evidence.receipts.effects')}: <span className="font-mono">{receipts.effectCount}</span> · {t('pages.examiner.evidence.receipts.presence')}: <span className="font-mono">{receipts.presenceCount}</span></div>
          </div>
        </div>

        <div className="min-w-0 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-audit">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{t('pages.examiner.evidence.audit.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${laneChipClass(evidenceAudit.status === 'ok')}`}>
              {enumLabel('examinerLane', evidenceAudit.status, t)}
            </span>
          </div>
          {evidenceAudit.status !== 'ok' && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="examiner-evidence-audit-reason">
              {reasonSentence(evidenceAudit.reasonCode)}
              {reasonForensics(evidenceAudit.reason)}
            </p>
          )}
          {/* P1-3: these are LOADED counts. hasMore kinds are named explicitly —
              a loaded window is never presented as the total. */}
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3" data-testid="examiner-evidence-counts">
            <div>{t('pages.examiner.evidence.audit.deliveries')}: <span className="font-mono">{evidenceAudit.counts.deliveries}</span>{evidenceAudit.pages?.delivery?.hasMore ? ` ${t('pages.examiner.evidence.audit.loadedSuffix')}` : ''}</div>
            <div>{t('pages.examiner.evidence.audit.applications')}: <span className="font-mono">{evidenceAudit.counts.applications}</span>{evidenceAudit.pages?.application?.hasMore ? ` ${t('pages.examiner.evidence.audit.loadedSuffix')}` : ''}</div>
            <div>{t('pages.examiner.evidence.audit.episodes')}: <span className="font-mono">{evidenceAudit.counts.episodes}</span>{evidenceAudit.pages?.behavior_episode?.hasMore ? ` ${t('pages.examiner.evidence.audit.loadedSuffix')}` : ''}</div>
            <div>{t('pages.examiner.evidence.audit.effects')}: <span className="font-mono">{evidenceAudit.counts.effects}</span>{evidenceAudit.pages?.effect?.hasMore ? ` ${t('pages.examiner.evidence.audit.loadedSuffix')}` : ''}</div>
            <div>{t('pages.examiner.evidence.audit.outcomes')}: <span className="font-mono">{evidenceAudit.counts.outcomes}</span>{evidenceAudit.pages?.outcome?.hasMore ? ` ${t('pages.examiner.evidence.audit.loadedSuffix')}` : ''}</div>
            <div>{t('pages.examiner.evidence.audit.unresolved')}: <span className="font-mono">{evidenceAudit.unresolvedReferences}</span></div>
          </div>
          {evidenceAudit.anyHasMore && (
            <p className="mt-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-caption text-sky-700 dark:text-sky-400" data-testid="examiner-evidence-hasmore">
              {t('pages.examiner.evidence.audit.hasMoreNote')}
            </p>
          )}
          <div className="mt-2 rounded-md border p-2 text-caption" data-testid="examiner-evidence-ladder">
            <div className="font-medium">{t('pages.examiner.evidence.audit.ladder')}</div>
            {/* Each ladder row keeps its machine code as a data attribute —
                assertions target the code, never the localized label. */}
            <div className="mt-1 grid grid-cols-2 gap-x-3 text-muted-foreground sm:grid-cols-3 [overflow-wrap:anywhere]">
              <div data-code="prepared">{enumLabel('proofLadder', 'prepared', t)}: <span className="font-mono">{evidenceAudit.deliveryConfirmations.prepared}</span></div>
              <div data-code="submitted">{enumLabel('proofLadder', 'submitted', t)}: <span className="font-mono">{evidenceAudit.deliveryConfirmations.submitted}</span></div>
              <div data-code="host_accepted">{enumLabel('proofLadder', 'host_accepted', t)}: <span className="font-mono">{evidenceAudit.deliveryConfirmations.hostAccepted}</span></div>
              <div data-code="context_present">{enumLabel('proofLadder', 'context_present', t)}: <span className="font-mono">{evidenceAudit.deliveryConfirmations.contextPresent}</span></div>
              <div data-code="runtime_loaded">{enumLabel('proofLadder', 'runtime_loaded', t)}: <span className="font-mono">{evidenceAudit.deliveryConfirmations.runtimeLoaded}</span></div>
              <div data-code="agent_claimed">{enumLabel('proofLadder', 'agent_claimed', t)}: <span className="font-mono">{evidenceAudit.applicationProof.agentClaimed}</span></div>
              <div data-code="runtime_verified">{enumLabel('proofLadder', 'runtime_verified', t)}: <span className="font-mono">{evidenceAudit.applicationProof.runtimeVerified}</span></div>
            </div>
          </div>
          {evidenceAudit.asOf && (
            <div className="mt-2 text-caption text-muted-foreground" data-testid="examiner-evidence-asof">
              {t('pages.examiner.evidence.audit.asOf')}: {evidenceAudit.asOf} · {t('pages.examiner.evidence.asOf')}: {evidence.asOf}
            </div>
          )}
        </div>
      </div>

      {evidenceAudit.samples.outcomes.length > 0 && (
        <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-outcomes">
          <div className="font-medium">{t('pages.examiner.evidence.outcomes.title')}</div>
          {evidenceAudit.samples.outcomes.map((outcome) => (
            <div key={outcome.evidenceId} className="mt-1 text-xs text-muted-foreground">
              <span>{enumLabel('sourceKind', outcome.sourceKind, t)}</span> · {outcome.summary || outcome.evidenceId}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
