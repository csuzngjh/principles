import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../../components/layout/page-shell.js';
import { SectionTitle } from '../../components/layout/section-title.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { fetchPainEvidence } from '../../api.js';
import {
  parsePainEvidenceListResponse,
  isDegraded,
  getErrorMessage,
} from './PainEvidenceValidators.js';
import type { PainEvidence, PainEvidenceListData, PainEvidenceDegraded } from './PainEvidenceValidators.js';
import { formatDate } from '../../utils/format.js';

type PageState =
  | { status: 'loading' }
  | { status: 'loaded'; data: PainEvidenceListData }
  | { status: 'degraded'; degraded: PainEvidenceDegraded }
  | { status: 'error'; message: string };

export function PainPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    setState({ status: 'loading' });
    const result = await fetchPainEvidence();

    if (!result.success) {
      // API endpoint may not exist yet — show honest boundary
      if (result.error?.includes('404') || result.error?.includes('not found')) {
        setState({
          status: 'degraded',
          degraded: {
            reason: t('pages.pain.capabilityBoundary'),
            nextAction: t('pages.pain.capabilityNextAction'),
          },
        });
      } else {
        setState({ status: 'error', message: result.error ?? 'Unknown error' });
      }
      return;
    }

    const parsed = parsePainEvidenceListResponse(result.data);
    if (isDegraded(parsed)) {
      setState({ status: 'degraded', degraded: parsed });
    } else {
      setState({ status: 'loaded', data: parsed });
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

      {state.status === 'degraded' && (
        <div className="py-8">
          <div className="p-4 bg-panel border border-line rounded-[var(--radius-md)]">
            <div className="text-ink-2 text-sm mb-2">{state.degraded.reason}</div>
            <div className="text-ink-3 text-[13px]">{state.degraded.nextAction}</div>
          </div>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={loadData}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>
      )}

      {state.status === 'loaded' && (
        <>
          {state.data.note && (
            <div className="mb-4 p-3 bg-panel border border-amber/20 rounded-[var(--radius-md)] text-amber text-[13px]">
              {state.data.note}
            </div>
          )}

          {state.data.evidence.length === 0 ? (
            <EmptyState t={t} />
          ) : (
            <div className="space-y-4">
              {state.data.evidence.map((item) => (
                <EvidenceCard
                  key={item.id}
                  evidence={item}
                  expanded={expandedIds.has(item.id)}
                  onToggle={() => toggleExpanded(item.id)}
                  t={t}
                />
              ))}
            </div>
          )}
        </>
      )}
    </PageShell>
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

// ── Evidence card (single-item, three-layer structure) ────────────────────────

interface EvidenceCardProps {
  evidence: PainEvidence;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}

function EvidenceCard({ evidence, expanded, onToggle, t }: EvidenceCardProps) {
  const sourceLabel = evidence.source === 'tool_call'
    ? t('pages.pain.sourceToolCall')
    : t('pages.pain.sourcePrompt');

  const stateVariant = evidence.recommendationState === 'pending'
    ? 'amber'
    : evidence.recommendationState === 'candidate'
      ? 'default'
      : evidence.recommendationState === 'principle'
        ? 'green'
        : 'secondary';

  const stateLabel = t(`pages.pain.state_${evidence.recommendationState}`);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        {/* Layer 1: Summary — what happened */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={stateVariant}>{stateLabel}</Badge>
            <Badge variant="outline">{sourceLabel}</Badge>
          </div>
          <span className="font-mono text-[11px] text-ink-4 whitespace-nowrap">
            {formatDate(evidence.createdAt)}
          </span>
        </div>
        <CardTitle className="mt-2">{evidence.title}</CardTitle>
      </CardHeader>

      <CardContent>
        {/* Layer 2: Context and behavior — why */}
        <SectionTitle>{t('pages.pain.layerContext')}</SectionTitle>
        <div className="space-y-3 mb-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
              {t('pages.pain.fieldContext')}
            </div>
            <p className="text-ink-2 text-sm leading-relaxed">{evidence.context}</p>
          </div>
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
              {t('pages.pain.fieldAgentBehavior')}
            </div>
            <p className="text-ink-2 text-sm leading-relaxed">{evidence.agentBehavior}</p>
          </div>
          {evidence.expectedBehavior && (
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-1">
                {t('pages.pain.fieldExpectedBehavior')}
              </div>
              <p className="text-ink-2 text-sm leading-relaxed">{evidence.expectedBehavior}</p>
            </div>
          )}
        </div>

        {/* Layer 3: Full trajectory — collapsed by default (D section) */}
        <details open={expanded} onToggle={onToggle}>
          <summary className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 cursor-pointer select-none hover:text-ink transition-colors">
            {t('pages.pain.trajectoryToggle')}
          </summary>
          <div className="mt-3 p-3 bg-paper-2 border border-line rounded-[var(--radius-sm)]">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              <span className="font-mono text-ink-4">{t('pages.pain.trajectoryTaskId')}</span>
              <span className="font-mono text-ink-2">{evidence.trajectorySummary.taskId}</span>
              <span className="font-mono text-ink-4">{t('pages.pain.trajectoryTool')}</span>
              <span className="font-mono text-ink-2">{evidence.trajectorySummary.toolName}</span>
              <span className="font-mono text-ink-4">{t('pages.pain.trajectoryTime')}</span>
              <span className="font-mono text-ink-2">{formatDate(evidence.trajectorySummary.timestamp)}</span>
            </div>
          </div>
        </details>

        {/* Sediment action (US-2.4 / J.4) */}
        {evidence.recommendationState === 'pending' && (
          <div className="mt-4 pt-4 border-t border-line">
            <div className="flex items-start gap-3">
              <Button variant="outline" size="sm" disabled>
                {t('pages.pain.sedimentAction')}
              </Button>
              <span className="text-ink-4 text-[13px] leading-relaxed pt-1">
                {t('pages.pain.sedimentHint')}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
