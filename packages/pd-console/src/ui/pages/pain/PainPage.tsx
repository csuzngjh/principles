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
import { PageLoading } from '../../components/layout/page-loading.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { ShinyText } from '../../components/ui/shiny-text.js';
import { fetchEvidenceChain, recordIntentDecision, listIntentDecisionsByPainId, listIntentDecisionsByTaskId } from '../../api.js';
import type { EvidenceChainRecordData, EvidenceChainStateData, EvidenceChainData, IntentDecisionRecordData } from '../../api.js';
import type { IntentTensionData } from '../../utils/validators.js';
import { formatDate } from '../../utils/format.js';
import { mapConfidenceLabel, buildCardLayers, buildDebugIdSummary, isLayer2EffectivelyEmpty, shouldRenderIntentTensionPanel, shouldRenderFollowUpActions, buildIntentDecisionPayload, type IntentDecisionContext } from './pain-card-helpers.js';
import { enumLabel } from '../../utils/enum-labels.js';

// ── State grouping ─────────────────────────────────────────────────────────────

type StateGroup = 'active_chain' | 'evidence_only' | 'failed';

function groupForState(state: EvidenceChainStateData): StateGroup {
  switch (state) {
    case 'evidence-only':
      return 'evidence_only';
    case 'recorded-only':
    case 'diagnosis-queued':
    case 'diagnosis-running':
    case 'diagnosis-succeeded':
    case 'candidate-generated':
    case 'internalization-missing':
    case 'internalization-pending':
    case 'internalization-running':
    case 'internalization-succeeded':
    case 'owner-reviewable':
      return 'active_chain';
    case 'diagnosis-failed':
    case 'diagnosis-retry-wait':
    case 'internalization-failed':
      return 'failed';
    case 'malformed':
    case 'degraded':
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
        <ShinyText
          as="h1"
          className="text-[29px] font-semibold tracking-tight text-ink mt-3 mb-2"
          duration={4.5}
          brightness={0.5}
          disabled={state.status !== 'loaded' || state.data.records.length === 0}
        >
          {t('pages.pain.title')}
        </ShinyText>
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
        <PageLoading cardCount={4} label={t('common.loading')} />
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
        <div className="animate-[pdFadeIn_400ms_ease-out]">
          <LoadedContent
            data={state.data}
            expandedIds={expandedIds}
            onToggle={toggleExpanded}
            onRefresh={loadData}
            t={t}
          />
        </div>
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
  const [reviewQueueExpanded, setReviewQueueExpanded] = useState(false);
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

            // For active_chain group, fold owner-reviewable records into a count
            // row when there are 2+ — they are already in the governance queue
            // and repeating each as a full card here is noise. Single record
            // stays expanded. Click the fold row to expand in-place.
            if (group === 'active_chain') {
              const inReview = records.filter((r) => r.state === 'owner-reviewable');
              const others = records.filter((r) => r.state !== 'owner-reviewable');
              const foldReviewQueue = inReview.length >= 2;
              const reviewQueueLabel = t('pages.pain.inReviewQueueCount').replace('{{count}}', String(inReview.length));

              return (
                <div key={group}>
                  <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-4 mb-3">
                    {t(`pages.pain.group_${group}`)} ({records.length})
                  </div>
                  <div className="space-y-4">
                    {others.map((record) => (
                      <EvidenceChainCard
                        key={record.id}
                        record={record}
                        expanded={expandedIds.has(record.id)}
                        onToggle={() => onToggle(record.id)}
                        t={t}
                      />
                    ))}
                    {foldReviewQueue && !reviewQueueExpanded && (
                      <button
                        type="button"
                        onClick={() => setReviewQueueExpanded(true)}
                        className="w-full text-left p-3 bg-panel border border-line rounded-[var(--radius-md)] text-ink-3 text-sm hover:bg-paper-2 transition-colors"
                      >
                        {reviewQueueLabel} · {t('pages.pain.goToGovernance')}
                      </button>
                    )}
                    {(!foldReviewQueue || reviewQueueExpanded) && inReview.map((record) => (
                      <EvidenceChainCard
                        key={record.id}
                        record={record}
                        expanded={expandedIds.has(record.id)}
                        onToggle={() => onToggle(record.id)}
                        t={t}
                      />
                    ))}
                    {foldReviewQueue && reviewQueueExpanded && (
                      <button
                        type="button"
                        onClick={() => setReviewQueueExpanded(false)}
                        className="font-mono text-[11px] text-ink-4 hover:text-ink-3 transition-colors"
                      >
                        {reviewQueueLabel} ▲
                      </button>
                    )}
                  </div>
                </div>
              );
            }

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
  const [copied, setCopied] = useState(false);
  const layer2Empty = isLayer2EffectivelyEmpty(record);
  const stateVariant = stateToVariant(record.state);
  const stateLabel = enumLabel('evidenceState', record.state, t);
  const sourceLabel = enumLabel('sourceKind', record.sourceKind, t);

  const layers = buildCardLayers(record);

  // Confidence label — resolve via enumLabel for consistent i18n
  const confidenceDisplay = layers.layer2.confidence
    ? `${enumLabel('confidence', layers.layer2.confidence.label, t)} (${layers.layer2.confidence.raw.toFixed(2)})`
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
                {enumLabel('admission', record.admissionDecision, t)}
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
            {layer2Empty ? (
              <p className="text-ink-3 text-sm italic leading-relaxed">
                {t('pages.pain.noHumanSummary')}
              </p>
            ) : (
              <CardTitle className="text-[15px] leading-relaxed">{layers.layer2.triggerSummary}</CardTitle>
            )}
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

        {/* PRI-469: Intent Tension panel (SPEC §22.1.2)
            Rendered only when shouldRenderIntentTensionPanel returns true.
            SPEC §22.1.3: source='none' is suppressed (no high-salience panel).
            SPEC §22.1.4: follow-up actions are NOT shown in PRI-469 (stub returns false).
            The panel is a distinct visual block between Layer 2 and Layer 3. */}
        {shouldRenderIntentTensionPanel(layers.layer2.intentTension) && (
          <IntentTensionPanel
            tension={layers.layer2.intentTension}
            recordId={record.id}
            painId={record.id}
            taskId={record.linkedTaskId ?? undefined}
            t={t}
          />
        )}

        {/* Layer 3: Debug IDs — hidden by default; copy button is primary action */}
        <div className="mt-4 pt-3 border-t border-line">
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(buildDebugIdSummary(record));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch (error) {
                  // clipboard unavailable — expand details as fallback
                  console.warn("Debug ID copy failed; falling back to expanded details.", error);
                  if (!expanded) onToggle();
                }
              }}
              className="font-mono text-[11px] h-7"
            >
              {copied ? t('pages.pain.copied') : t('pages.pain.copyDebugId')}
            </Button>
            <button
              type="button"
              onClick={onToggle}
              className="font-mono text-[11px] text-ink-4 hover:text-ink-3 transition-colors underline-offset-2 hover:underline"
            >
              {t('pages.pain.expandTechDetails')}
            </button>
          </div>
          {expanded && (
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

                {layers.layer3.internalizationTaskId && (
                  <>
                    <span className="font-mono text-ink-4">{t('pages.pain.chainInternalizationTask')}</span>
                    <span className="font-mono text-ink-2">{layers.layer3.internalizationTaskId}</span>
                  </>
                )}

                {layers.layer3.dreamerTaskStatus && (
                  <>
                    <span className="font-mono text-ink-4">{t('pages.pain.chainDreamerStatus')}</span>
                    <span className="font-mono text-ink-2">{layers.layer3.dreamerTaskStatus}</span>
                  </>
                )}

                <span className="font-mono text-ink-4">{t('pages.pain.chainSourceKind')}</span>
                <span className="font-mono text-ink-2">{layers.layer3.sourceKind}</span>

                <span className="font-mono text-ink-4">{t('pages.pain.chainState')}</span>
                <span className="font-mono text-ink-2">{layers.layer3.state}</span>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stateToVariant(state: EvidenceChainStateData): 'default' | 'amber' | 'green' | 'destructive' | 'secondary' {
  switch (state) {
    case 'evidence-only':
      return 'secondary';
    case 'recorded-only':
    case 'diagnosis-queued':
    case 'diagnosis-running':
    case 'internalization-pending':
    case 'internalization-running':
      return 'amber';
    case 'diagnosis-succeeded':
    case 'candidate-generated':
    case 'internalization-succeeded':
    case 'owner-reviewable':
      return 'green';
    case 'diagnosis-failed':
    case 'internalization-failed':
      return 'destructive';
    case 'diagnosis-retry-wait':
      return 'amber';
    case 'malformed':
    case 'degraded':
    default:
      return 'secondary';
  }
}

// ── PRI-469: Intent Tension panel (SPEC §22.1) ───────────────────────────────

/**
 * Convert a snake_case enum value to a PascalCase suffix for i18n keys.
 * E.g. 'action_drift' → 'ActionDrift', 'none' → 'None'.
 */
function snakeToPascal(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Resolve an intentTension enum value to its localized label.
 * kind determines the i18n key prefix:
 * - 'source' → pages.pain.intentTensionSource{Pascal}
 * - 'evidenceStrength' → pages.pain.intentTensionEvidenceStrength{Pascal}
 * - 'suggestedAction' → pages.pain.intentTensionSuggestedAction{Pascal}
 */
function intentTensionEnumLabel(
  value: string,
  kind: 'source' | 'evidenceStrength' | 'suggestedAction',
  t: (key: string) => string,
): string {
  const keyPrefix =
    kind === 'source'
      ? 'intentTensionSource'
      : kind === 'evidenceStrength'
        ? 'intentTensionEvidenceStrength'
        : 'intentTensionSuggestedAction';
  return t(`pages.pain.${keyPrefix}${snakeToPascal(value)}`);
}

interface IntentTensionPanelProps {
  tension: IntentTensionData;
  recordId: string;
  painId?: string;
  taskId?: string;
  t: (key: string) => string;
}

/**
 * IntentTensionPanel — renders the intent tension decision panel (SPEC §22.1.2).
 *
 * This panel is rendered only when shouldRenderIntentTensionPanel returns true
 * (i.e., tension is non-null AND source !== 'none' per SPEC §22.1.3).
 *
 * Follow-up actions (SPEC §22.1.4) are NOT rendered in PRI-469 — they require
 * an Owner decision written to IntentDecisionRecord first (PRI-471 scope).
 * shouldRenderFollowUpActions() is called here as a stub so the UI structure
 * is in place for PRI-471.
 *
 * Accessibility (EP-09):
 * - Uses semantic <section> with aria-label
 * - Uses <dl>/<dt>/<dd> for label-value pairs
 * - Color is not the only indicator (text labels always present)
 */
function IntentTensionPanel({ tension, recordId, painId, taskId, t }: IntentTensionPanelProps) {
  const sourceLabel = intentTensionEnumLabel(tension.source, 'source', t);
  const strengthLabel = intentTensionEnumLabel(tension.evidenceStrength, 'evidenceStrength', t);
  const actionLabel = intentTensionEnumLabel(tension.suggestedOwnerAction, 'suggestedAction', t);

  return (
    <section
      className="mt-4 p-4 border border-line rounded-[var(--radius-sm)] bg-paper-2"
      aria-label={t('pages.pain.intentTensionTitle')}
    >
      {/* Panel title */}
      <h4 className="text-[13px] font-semibold text-ink mb-3 flex items-center gap-2">
        <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-amber" />
        {t('pages.pain.intentTensionTitle')}
      </h4>

      {/* Label-value pairs */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="font-mono text-ink-4">{t('pages.pain.intentTensionSourceLabel')}</dt>
        <dd className="text-ink-2">{sourceLabel}</dd>

        <dt className="font-mono text-ink-4">{t('pages.pain.intentTensionEvidenceStrengthLabel')}</dt>
        <dd className="text-ink-2">{strengthLabel}</dd>

        <dt className="font-mono text-ink-4">{t('pages.pain.intentTensionSuggestedActionLabel')}</dt>
        <dd className="text-ink-2 font-medium">{actionLabel}</dd>
      </dl>

      {/* Related INTENT fields */}
      {tension.relatedIntentFields.length > 0 && (
        <div className="mt-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
            {t('pages.pain.intentTensionRelatedIntentFieldsLabel')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tension.relatedIntentFields.map((field, idx) => (
              <Badge key={`${field}-${idx}`} variant="outline">
                {field}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Evidence list */}
      {tension.evidence.length > 0 && (
        <div className="mt-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
            {t('pages.pain.intentTensionEvidenceLabel')}
          </div>
          <ul className="text-ink-2 text-sm leading-relaxed space-y-1">
            {tension.evidence.map((item, idx) => (
              <li key={`${idx}-${item.slice(0, 12)}`} className="pl-3 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1 before:h-1 before:rounded-full before:bg-ink-4">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Explanation */}
      <div className="mt-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
          {t('pages.pain.intentTensionExplanationLabel')}
        </div>
        <p className="text-ink-2 text-sm leading-relaxed">{tension.explanation}</p>
      </div>

      {/* Optional INTENT doc hash */}
      {tension.intentDocHash && (
        <div className="mt-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
            {t('pages.pain.intentTensionIntentDocHashLabel')}
          </div>
          <p className="font-mono text-[11px] text-ink-3 break-all">{tension.intentDocHash}</p>
        </div>
      )}

      {/* PRI-470: Owner Decision Panel (SPEC §22.1.4)
          Renders the Owner decision flow. Follow-up actions appear only
          after a decision is persisted (shouldRenderFollowUpActions). */}
      <OwnerDecisionPanel
        tension={tension}
        recordId={recordId}
        painId={painId}
        taskId={taskId}
        t={t}
      />
    </section>
  );
}

// ── PRI-470: Owner Decision Panel (SPEC §22.1.4) ─────────────────────────────

interface OwnerDecisionPanelProps {
  tension: IntentTensionData;
  recordId: string;
  painId?: string;
  taskId?: string;
  t: (key: string) => string;
}

type DecisionPanelState = 'idle' | 'submitting' | 'recorded' | 'error';
type DecisionLoadState = 'loading' | 'loaded' | 'error';

const OWNER_ACTION_BUTTONS: ReadonlyArray<{
  action: string;
  labelKey: string;
}> = [
  { action: 'confirm_drift', labelKey: 'pages.pain.ownerDecisionSubmitConfirmDrift' },
  { action: 'revise_intent', labelKey: 'pages.pain.ownerDecisionSubmitReviseIntent' },
  { action: 'observe', labelKey: 'pages.pain.ownerDecisionSubmitObserve' },
  { action: 'dismiss', labelKey: 'pages.pain.ownerDecisionSubmitDismiss' },
  { action: 'promote_to_principle', labelKey: 'pages.pain.ownerDecisionSubmitPromoteToPrinciple' },
  { action: 'promote_to_rulehost', labelKey: 'pages.pain.ownerDecisionSubmitPromoteToRulehost' },
];

/**
 * OwnerDecisionPanel — renders the Owner decision flow for an intent tension.
 *
 * State machine: 'idle' | 'submitting' | 'recorded' | 'error'
 * - On mount, fetches existing decisions by painId (or taskId fallback).
 * - Shows 6 action buttons + optional note input.
 * - On submit, calls buildIntentDecisionPayload + recordIntentDecision.
 * - Follow-up actions placeholder appears when existingDecisions is non-empty.
 *
 * Accessibility (EP-09):
 * - Uses semantic <section> with aria-label
 * - Buttons have descriptive text labels
 */
function OwnerDecisionPanel({ tension, recordId, painId, taskId, t }: OwnerDecisionPanelProps) {
  const [panelState, setPanelState] = useState<DecisionPanelState>('idle');
  const [loadState, setLoadState] = useState<DecisionLoadState>('loading');
  const [existingDecisions, setExistingDecisions] = useState<IntentDecisionRecordData[]>([]);
  const [note, setNote] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch existing decisions on mount — use painId when available, fall back to taskId.
  useEffect(() => {
    let cancelled = false;
    const loadExisting = async () => {
      setLoadState('loading');
      const hasPainId = painId !== undefined && painId.length > 0;
      const hasTaskId = taskId !== undefined && taskId.length > 0;
      if (!hasPainId && !hasTaskId) {
        // Nothing to query by — skip loading, treat as empty.
        if (!cancelled) setLoadState('loaded');
        return;
      }
      const result = hasPainId
        ? await listIntentDecisionsByPainId(painId!)
        : await listIntentDecisionsByTaskId(taskId!);
      if (cancelled) return;
      if (!result.success) {
        setLoadState('error');
        return;
      }
      setExistingDecisions(result.data);
      setLoadState('loaded');
    };
    void loadExisting();
    return () => { cancelled = true; };
  }, [painId, taskId]);

  const handleSubmit = async (ownerAction: string) => {
    setPanelState('submitting');
    setErrorMsg(null);
    const context: IntentDecisionContext = {
      recordId,
      painId,
      taskId,
      intentDocHash: tension.intentDocHash,
    };
    const payload = buildIntentDecisionPayload(tension, context, { ownerAction, note });
    const result = await recordIntentDecision(payload);
    if (!result.success) {
      setPanelState('error');
      setErrorMsg(result.error ?? t('pages.pain.ownerDecisionFailed'));
      return;
    }
    setPanelState('recorded');
    // Add the new decision so follow-up actions appear.
    setExistingDecisions([result.data.record, ...existingDecisions]);
  };

  const hasExisting = existingDecisions.length > 0;
  const showFollowUp = shouldRenderFollowUpActions(existingDecisions);

  return (
    <div className="mt-4 pt-3 border-t border-line">
      <h5 className="text-[13px] font-semibold text-ink mb-1">
        {t('pages.pain.ownerDecisionPanelTitle')}
      </h5>
      <p className="text-ink-3 text-[12px] leading-relaxed mb-3">
        {t('pages.pain.ownerDecisionPanelSubtitle')}
      </p>

      {/* Loading existing decisions */}
      {loadState === 'loading' && (
        <p className="text-ink-4 text-[12px] italic">
          {t('pages.pain.ownerDecisionLoadingExisting')}
        </p>
      )}

      {/* Failed to load existing decisions */}
      {loadState === 'error' && (
        <p className="text-amber text-[12px]">
          {t('pages.pain.ownerDecisionLoadFailed')}
        </p>
      )}

      {/* Existing decision banner */}
      {loadState === 'loaded' && hasExisting && panelState !== 'recorded' && (
        <p className="text-ink-3 text-[12px] mb-3 italic">
          {t('pages.pain.ownerDecisionExisting')}
        </p>
      )}

      {/* Recorded success message */}
      {panelState === 'recorded' && (
        <p className="text-emerald text-[12px] mb-3 font-medium">
          {t('pages.pain.ownerDecisionRecorded')}
        </p>
      )}

      {/* Error message */}
      {panelState === 'error' && errorMsg && (
        <p className="text-danger text-[12px] mb-3">
          {t('pages.pain.ownerDecisionFailed')}: {errorMsg}
        </p>
      )}

      {/* Note input (optional) — disabled during submission or after recorded */}
      {panelState !== 'recorded' && loadState === 'loaded' && (
        <>
          <div className="mb-3">
            <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
              {t('pages.pain.ownerDecisionNoteLabel')}
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('pages.pain.ownerDecisionNotePlaceholder')}
              disabled={panelState === 'submitting'}
              className="w-full px-3 py-1.5 text-[13px] bg-surface border border-line rounded-[var(--radius-sm)] text-ink-2 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50"
            />
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            {OWNER_ACTION_BUTTONS.map(({ action, labelKey }) => (
              <Button
                key={action}
                variant="outline"
                size="sm"
                disabled={panelState === 'submitting'}
                onClick={() => void handleSubmit(action)}
              >
                {panelState === 'submitting'
                  ? t('pages.pain.ownerDecisionSubmitting')
                  : t(labelKey)}
              </Button>
            ))}
          </div>
        </>
      )}

      {/* Follow-up actions placeholder (SPEC §22.1.4) */}
      {showFollowUp && (
        <div className="mt-4 p-3 bg-paper-2 border border-line rounded-[var(--radius-sm)]">
          <p className="text-ink-3 text-[12px] italic">
            {t('pages.pain.ownerDecisionFollowUpPlaceholder')}
          </p>
        </div>
      )}
    </div>
  );
}
