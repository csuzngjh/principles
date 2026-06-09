/**
 * PainPage — Behavior Evidence page showing real evidence/pain/diagnosis chain states.
 *
 * PRI-331: Replaces the old approach of deriving evidence from principle metrics
 * with a direct read model from pain_events, tasks, candidates, and ledger.
 *
 * Privacy boundary (G.2 / F.3 / F.5):
 * - No raw prompt, chat, trajectory, token, full absolute path, or stack trace
 * - All summaries are already sanitized by the backend EvidenceChainConsoleModel
 * - Degraded paths show reason + nextAction, never silent fallback (ERR-002)
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../../components/layout/page-shell.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { fetchEvidenceChain } from '../../api.js';
import type { EvidenceChainRecordData, EvidenceChainStateData, EvidenceChainData } from '../../api.js';
import { formatDate } from '../../utils/format.js';
import { mapConfidenceLabel, buildCardLayers } from './pain-card-helpers.js';

// ── State grouping ─────────────────────────────────────────────────────────────

type StateGroup = 'active_chain' | 'evidence_only' | 'failed';

/**
 * Translate with fallback — if the i18n key doesn't exist (returns the key itself),
 * return the fallback instead. Prevents raw keys like "pages.pain.source_unknown_value"
 * from being displayed to the user.
 */
function tFallback(t: (key: string) => string, key: string, fallback: string): string {
  const result = t(key);
  return result === key ? fallback : result;
}

function groupForState(state: EvidenceChainStateData): StateGroup {
  switch (state) {
    case 'pain_recorded':
    case 'diagnosis_queued':
    case 'diagnosis_running':
    case 'diagnosis_succeeded':
    case 'candidate_generated':
    case 'internalization_started':
      return 'active_chain';
    case 'evidence_only':
      return 'evidence_only';
    case 'diagnosis_failed':
    case 'diagnosis_retry_wait':
      return 'failed';
    default:
      return 'evidence_only';
  }
}

const GROUP_ORDER: StateGroup[] = ['active_chain', 'failed', 'evidence_only'];

// ── Page state ─────────────────────────────────────────────────────────────────

type PageState =
  | { status: 'loading' }
  | { status: 'loaded'; data: EvidenceChainData }
  | { status: 'error'; message: string };

export function PainPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    setState({ status: 'loading' });
    const result = await fetchEvidenceChain();

    if (!result.success) {
      setState({ status: 'error', message: result.error ?? 'Unknown error' });
      return;
    }

    if (result.data) {
      setState({ status: 'loaded', data: result.data });
    } else {
      // Validation returned null — degraded state
      setState({
        status: 'error',
        message: t('pages.pain.validationError'),
      });
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <PageShell>
      {/* Page header */}
      <div className="mb-8">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
          {t('pages.pain.eyebrow')}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mt-3 mb-2">
          {t('pages.pain.title')}
        </h1>
        <p className="text-ink-3 text-sm leading-relaxed max-w-[712px]">
          {t('pages.pain.description')}
        </p>
      </div>

      {/* Honest boundary statement (F.5) */}
      <div className="mb-6 p-3 bg-panel border border-line rounded-[var(--radius-md)] text-ink-3 text-[13px] leading-relaxed">
        {t('pages.pain.honestyNote')}
      </div>

      {/* Content area */}
      {state.status === 'loading' && (
        <div className="text-ink-3 text-sm py-8">{t('common.loading')}…</div>
      )}

      {state.status === 'error' && (
        <div className="py-8">
          <div className="text-danger text-sm mb-2">
            {t('pages.pain.loadError')}: {state.message}
          </div>
          <Button variant="outline" size="sm" onClick={loadData}>
            {t('common.refresh')}
          </Button>
        </div>
      )}

      {state.status === 'loaded' && (
        <LoadedContent
          data={state.data}
          expandedIds={expandedIds}
          onToggle={toggleExpanded}
          onRefresh={loadData}
          t={t}
        />
      )}
    </PageShell>
  );
}

// ── Loaded content ─────────────────────────────────────────────────────────────

interface LoadedContentProps {
  data: EvidenceChainData;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onRefresh: () => void;
  t: (key: string) => string;
}

function LoadedContent({ data, expandedIds, onToggle, onRefresh, t }: LoadedContentProps) {
  // Show degraded banner if data sources are partially unavailable
  const hasDegraded = !!data.degradedReason;

  // Group records by state category
  const grouped = new Map<StateGroup, EvidenceChainRecordData[]>();
  for (const record of data.records) {
    const group = groupForState(record.state);
    const existing = grouped.get(group) ?? [];
    existing.push(record);
    grouped.set(group, existing);
  }

  const hasRecords = data.records.length > 0;

  return (
    <>
      {/* Degraded banner (ERR-002: never silent fallback) */}
      {hasDegraded && (
        <div className="mb-4 p-3 bg-panel border border-amber/20 rounded-[var(--radius-md)] text-amber text-[13px]">
          <div className="mb-1">{data.degradedReason}</div>
          {data.nextAction && (
            <div className="text-ink-3 text-[12px]">{data.nextAction}</div>
          )}
        </div>
      )}

      {/* Note when no records but sources are available */}
      {!hasRecords && data.note && (
        <div className="mb-4 p-3 bg-panel border border-line rounded-[var(--radius-md)] text-ink-3 text-[13px]">
          {data.note}
        </div>
      )}

      {/* Empty state */}
      {!hasRecords && !hasDegraded && <EmptyState t={t} />}

      {/* Records grouped by state category */}
      {hasRecords && (
        <div className="space-y-8">
          {GROUP_ORDER.map((group) => {
            const records = grouped.get(group);
            if (!records || records.length === 0) return null;

            return (
              <div key={group}>
                <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-4 mb-3">
                  {t(`pages.pain.group_${group}`)} ({records.length})
                </div>
                <div className="space-y-4">
                  {records.map((record) => (
                    <EvidenceChainCard
                      key={record.id}
                      record={record}
                      expanded={expandedIds.has(record.id)}
                      onToggle={() => onToggle(record.id)}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Generated-at timestamp */}
      <div className="mt-8 font-mono text-[11px] text-ink-4">
        {t('pages.pain.generatedAt')}: {formatDate(data.generatedAt)}
      </div>
    </>
  );
}

// ── Empty state (E section: guide next step, not "暂无数据") ──────────────────

function EmptyState({ t }: { t: (key: string) => string }) {
  return (
    <div className="py-8">
      <div className="p-5 bg-panel border border-line rounded-[var(--radius-md)]">
        <h3 className="text-[17px] font-semibold text-ink mb-2">
          {t('pages.pain.emptyTitle')}
        </h3>
        <p className="text-ink-3 text-sm leading-relaxed">
          {t('pages.pain.emptyDescription')}
        </p>
      </div>
    </div>
  );
}

// ── Evidence chain card (single-item, three-layer structure) ───────────────────

interface EvidenceChainCardProps {
  record: EvidenceChainRecordData;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}

function EvidenceChainCard({ record, expanded, onToggle, t }: EvidenceChainCardProps) {
  const stateVariant = stateToVariant(record.state);
  const stateLabel = tFallback(t, `pages.pain.state_${record.state}`, record.state);
  const sourceLabel = tFallback(t, `pages.pain.source_${record.sourceKind}`, record.sourceKind);

  const layers = buildCardLayers(record);

  // Confidence i18n key
  const confidenceI18nKey = layers.layer2.confidence
    ? `pages.pain.confidence${layers.layer2.confidence.label.charAt(0).toUpperCase() + layers.layer2.confidence.label.slice(1)}`
    : null;
  const confidenceDisplay = confidenceI18nKey
    ? `${tFallback(t, confidenceI18nKey, layers.layer2.confidence!.label)} (${layers.layer2.confidence!.raw.toFixed(2)})`
    : null;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        {/* Layer 1: Status badges + source + timestamp */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={stateVariant}>{stateLabel}</Badge>
            <Badge variant="outline">{sourceLabel}</Badge>
            {record.admissionDecision && (
              <Badge variant="secondary">
                {tFallback(t, `pages.pain.admission_${record.admissionDecision}`, record.admissionDecision)}
              </Badge>
            )}
          </div>
          <span className="font-mono text-[11px] text-ink-4 whitespace-nowrap">
            {formatDate(record.observedAt)}
          </span>
        </div>
      </CardHeader>

      <CardContent>
        {/* Layer 2: Human-readable content */}
        <div className="space-y-3 mb-4">
          {/* Trigger behavior */}
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
              {t('pages.pain.fieldTrigger')}
            </div>
            <CardTitle className="text-[15px] leading-relaxed">{layers.layer2.triggerSummary}</CardTitle>
          </div>

          {/* PD's conclusion (conditional: candidateTitle exists) */}
          {layers.layer2.conclusion && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldConclusion')}
              </div>
              <p className="text-ink text-sm leading-relaxed font-medium">{layers.layer2.conclusion}</p>
            </div>
          )}

          {/* Applicability (conditional: candidateSummary or rootCauseSummary) */}
          {layers.layer2.applicability && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldApplicability')}
              </div>
              <p className="text-ink-2 text-sm leading-relaxed">{layers.layer2.applicability}</p>
            </div>
          )}

          {/* Confidence (conditional: confidence exists) */}
          {confidenceDisplay && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldConfidence')}
              </div>
              <p className="text-ink-2 text-sm">{confidenceDisplay}</p>
            </div>
          )}

          {/* Failure reason for failed/retry states */}
          {layers.layer2.failureReason && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldFailureReason')}
              </div>
              <p className="text-danger text-sm leading-relaxed">{layers.layer2.failureReason}</p>
            </div>
          )}

          {/* Degraded reason at record level */}
          {layers.layer2.degradedReason && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldDegradedReason')}
              </div>
              <p className="text-amber text-sm leading-relaxed">{layers.layer2.degradedReason}</p>
            </div>
          )}

          {/* Next action guidance */}
          {layers.layer2.nextAction && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldNextAction')}
              </div>
              <p className="text-ink-2 text-sm leading-relaxed">{layers.layer2.nextAction}</p>
            </div>
          )}
        </div>

        {/* Layer 3: Technical details (collapsed by default) */}
        <details open={expanded} onToggle={onToggle}>
          <summary className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 cursor-pointer select-none hover:text-ink transition-colors">
            {t('pages.pain.techDetails')}
          </summary>
          <div className="mt-3 p-3 bg-paper-2 border border-line rounded-[var(--radius-sm)]">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              <span className="font-mono text-ink-4">{t('pages.pain.chainId')}</span>
              <span className="font-mono text-ink-2">{layers.layer3.id}</span>

              {layers.layer3.linkedTaskId && (
                <>
                  <span className="font-mono text-ink-4">{t('pages.pain.chainTaskId')}</span>
                  <span className="font-mono text-ink-2">{layers.layer3.linkedTaskId}</span>
                </>
              )}

              {layers.layer3.linkedTaskStatus && (
                <>
                  <span className="font-mono text-ink-4">{t('pages.pain.chainTaskStatus')}</span>
                  <span className="font-mono text-ink-2">{layers.layer3.linkedTaskStatus}</span>
                </>
              )}

              {layers.layer3.linkedCandidateId && (
                <>
                  <span className="font-mono text-ink-4">{t('pages.pain.chainCandidateId')}</span>
                  <span className="font-mono text-ink-2">{layers.layer3.linkedCandidateId}</span>
                </>
              )}

              {layers.layer3.linkedPrincipleId && (
                <>
                  <span className="font-mono text-ink-4">{t('pages.pain.chainPrincipleId')}</span>
                  <span className="font-mono text-ink-2">{layers.layer3.linkedPrincipleId}</span>
                </>
              )}

              <span className="font-mono text-ink-4">{t('pages.pain.chainSourceKind')}</span>
              <span className="font-mono text-ink-2">{layers.layer3.sourceKind}</span>

              <span className="font-mono text-ink-4">{t('pages.pain.chainState')}</span>
              <span className="font-mono text-ink-2">{layers.layer3.state}</span>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stateToVariant(state: EvidenceChainStateData): 'default' | 'amber' | 'green' | 'destructive' | 'secondary' {
  switch (state) {
    case 'pain_recorded':
    case 'diagnosis_queued':
    case 'diagnosis_running':
      return 'amber';
    case 'diagnosis_succeeded':
    case 'candidate_generated':
    case 'internalization_started':
      return 'green';
    case 'diagnosis_failed':
      return 'destructive';
    case 'diagnosis_retry_wait':
      return 'amber';
    case 'evidence_only':
    default:
      return 'secondary';
  }
}
