import React from 'react';
import { useTranslation } from 'react-i18next';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import type { ExaminerEvidenceData } from '../../api.js';

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §4/§5 — the production-evidence panel.
 *
 * Renders ONE principle's production evidence with the honesty contract
 * pinned in the server contract: Projection / Submitted / Presence /
 * Context Present / Runtime Loaded stay distinct; agent claims never count
 * as runtime verification; a degraded lane shows its reason — an
 * unavailable source is NEVER presented as "zero events".
 */
export function ExaminerEvidencePanel({ evidence, compact = false }: { evidence: ExaminerEvidenceData; compact?: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const { principle, activation, injection, receipts, evidenceAudit } = evidence;

  const laneStatus = (status: string): string => (status === 'ok' || status === 'available' ? 'ok' : status === 'degraded' ? 'degraded' : status);

  return (
    <div className="grid gap-4" data-testid="examiner-evidence-panel">
      {/* Principle identity + lifecycle */}
      <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-principle">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs" data-testid="examiner-evidence-principle-id">{principle.id}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs">{principle.status}</span>
          {principle.runtimeDeactivated === true && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">{t('pages.examiner.evidence.runtimeDeactivated')}</span>
          )}
        </div>
        <p className="mt-2 text-ink-2">{truncateByCodePoints(principle.text, compact ? 160 : 400)}</p>
        <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground sm:grid-cols-4">
          <div>{t('pages.examiner.evidence.ruleCount')}: {principle.ruleCount}</div>
          <div>{t('pages.examiner.evidence.painRefs')}: {principle.derivedFromPainIds.length > 0 ? principle.derivedFromPainIds.join(', ') : '—'}</div>
          <div>{t('pages.examiner.evidence.evaluability')}: {principle.evaluability}</div>
          <div>{t('pages.examiner.evidence.painPrevented')}: {principle.painPreventedCount}</div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="examiner-evidence-ledger-note">{principle.ledgerStatusNote}</p>
      </div>

      {/* Runtime activation + prompt injection lanes */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-activation">
          <div className="flex items-center justify-between">
            <span className="font-medium">{t('pages.examiner.evidence.activation.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${activation.status === 'ok' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'}`} data-testid="examiner-evidence-activation-status">
              {laneStatus(activation.status)}
            </span>
          </div>
          {activation.status !== 'ok' && activation.reason && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="examiner-evidence-activation-reason">{activation.reason}</p>
          )}
          <div className="mt-2 grid gap-1 text-xs">
            <div>{t('pages.examiner.evidence.activation.promptRows')}: <span className="font-mono">{activation.prompt.length}</span></div>
            {activation.prompt.filter((_, index) => index < 4).map((row) => (
              <div key={row.activationId} className="font-mono text-caption text-muted-foreground">
                {row.status} · {row.action}{row.enforcement ? ` · ${row.enforcement}` : ''}
              </div>
            ))}
            <div className="mt-1">{t('pages.examiner.evidence.activation.ruleCodeRows')}: <span className="font-mono">{activation.ruleCode.length}</span></div>
            {activation.ruleCode.filter((_, index) => index < 4).map((row) => (
              <div key={row.activationId} className="font-mono text-caption text-muted-foreground">
                {row.mode ?? 'mode?'} · {row.status} · {row.enforcement ?? '—'}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-injection">
          <div className="flex items-center justify-between">
            <span className="font-medium">{t('pages.examiner.evidence.injection.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${injection.status === 'available' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'}`} data-testid="examiner-evidence-injection-status">
              {injection.status}
            </span>
          </div>
          {injection.globalReason && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="examiner-evidence-injection-reason">{injection.globalReason}</p>
          )}
          <div className="mt-2 grid gap-1 text-xs">
            {injection.statuses.length === 0 && (
              <div className="text-muted-foreground">{t('pages.examiner.evidence.injection.noRows')}</div>
            )}
            {injection.statuses.filter((_, index) => index < 4).map((row) => (
              <div key={row.activationId} className="font-mono text-caption">
                {row.status}
                {row.inCurrentWindow !== undefined ? ` · window:${String(row.inCurrentWindow)}` : ''}
                {row.costChars !== undefined ? ` · ${row.costChars}c` : ''}
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
        <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-receipts">
          <div className="flex items-center justify-between">
            <span className="font-medium">{t('pages.examiner.evidence.receipts.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${receipts.status === 'ok' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'}`}>
              {receipts.status}
            </span>
          </div>
          {receipts.reason && <p className="mt-1 text-xs text-muted-foreground">{receipts.reason}</p>}
          <div className="mt-2 text-xs">
            <div>{t('pages.examiner.evidence.receipts.effects')}: <span className="font-mono">{receipts.effectCount}</span> · {t('pages.examiner.evidence.receipts.presence')}: <span className="font-mono">{receipts.presenceCount}</span></div>
            {receipts.nextAction && <div className="mt-1 text-muted-foreground">→ {receipts.nextAction}</div>}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-evidence-audit">
          <div className="flex items-center justify-between">
            <span className="font-medium">{t('pages.examiner.evidence.audit.title')}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${evidenceAudit.status === 'ok' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'}`}>
              {evidenceAudit.status}
            </span>
          </div>
          {evidenceAudit.reason && <p className="mt-1 text-xs text-muted-foreground">{evidenceAudit.reason}</p>}
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
            {/* Long ladder keys (`runtime_verified:`) are single tokens. At 1024
                they exceed their narrow grid cell and pushed the whole page 2px
                past the viewport on Linux font metrics. Let them wrap inside
                the cell instead of spilling. */}
            <div className="mt-1 grid grid-cols-2 gap-x-3 text-muted-foreground sm:grid-cols-3 [overflow-wrap:anywhere]">
              <div>submitted: <span className="font-mono">{evidenceAudit.deliveryConfirmations.submitted}</span></div>
              <div>host_accepted: <span className="font-mono">{evidenceAudit.deliveryConfirmations.hostAccepted}</span></div>
              <div>context_present: <span className="font-mono">{evidenceAudit.deliveryConfirmations.contextPresent}</span></div>
              <div>runtime_loaded: <span className="font-mono">{evidenceAudit.deliveryConfirmations.runtimeLoaded}</span></div>
              <div>agent_claimed: <span className="font-mono">{evidenceAudit.applicationProof.agentClaimed}</span></div>
              <div>runtime_verified: <span className="font-mono">{evidenceAudit.applicationProof.runtimeVerified}</span></div>
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
              <span className="font-mono">{outcome.sourceKind}</span> · {outcome.summary || outcome.evidenceId}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
