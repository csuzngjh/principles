import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { SectionTitle } from '../../components/layout/section-title.js';
import { Button } from '../../components/ui/button.js';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { ShieldCheck, FlaskConical, ArrowRight, RefreshCw, Loader2, FileText } from 'lucide-react';
import {
  fetchExaminerOverview,
  fetchExaminerPrinciples,
  fetchExaminerPrincipleEvidence,
  type ExaminerOverviewData,
  type ExaminerPrincipleItem,
  type ExaminerEvidenceData,
} from '../../api.js';
import { ExaminerEvidencePanel } from './examiner-evidence-panel.js';

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §10 Page 1 — Principle Evaluation.
 *
 * The Owner-facing question this page answers: "WHY does this principle need
 * evaluating, and what is its real production state?" — ledger identity, pain
 * lineage, runtime activation, prompt-injection status, receipts and the
 * intervention evidence audit (all with honest degraded lanes), plus the gate
 * panel and the entry into study configuration and existing studies.
 */
export function ExaminerPage(): React.ReactElement {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const prefillPrinciple = searchParams.get('principle');
  const [overview, setOverview] = useState<ExaminerOverviewData | null>(null);
  const [principles, setPrinciples] = useState<ExaminerPrincipleItem[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [evidence, setEvidence] = useState<ExaminerEvidenceData | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request sequence: a slower earlier response must never overwrite
  // the panel for the principle the Owner selected last (including A→B→A,
  // where comparing ids alone would accept the stale A response).
  const evidenceRequestSeq = useRef(0);
  const loadEvidence = useCallback(async (principleId: string) => {
    const seq = evidenceRequestSeq.current + 1;
    evidenceRequestSeq.current = seq;
    setEvidenceLoading(true);
    setEvidence(null);
    const response = await fetchExaminerPrincipleEvidence(principleId);
    if (evidenceRequestSeq.current !== seq) return;
    setEvidenceLoading(false);
    if (!response.success) {
      toast.error(response.error ?? t('pages.examiner.errors.evidence'));
      return;
    }
    setEvidence(response.data);
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const overviewResponse = await fetchExaminerOverview();
      if (cancelled) return;
      if (!overviewResponse.success) {
        setError(overviewResponse.error ?? t('pages.examiner.errors.unavailable'));
        return;
      }
      setOverview(overviewResponse.data);
      const principlesResponse = await fetchExaminerPrinciples();
      if (cancelled || !principlesResponse.success) return;
      const active = principlesResponse.data.principles.filter((p) => p.status === 'active');
      setPrinciples(active);
      const initial = prefillPrinciple !== null && active.some((p) => p.id === prefillPrinciple)
        ? prefillPrinciple
        : active[0]?.id ?? '';
      setSelected(initial);
      if (initial !== '') await loadEvidence(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [t, prefillPrinciple, loadEvidence]);

  const handleSelect = async (principleId: string): Promise<void> => {
    setSelected(principleId);
    await loadEvidence(principleId);
  };

  const handleRefresh = async (): Promise<void> => {
    if (selected === '') return;
    setBusy('refresh');
    await loadEvidence(selected);
    const overviewResponse = await fetchExaminerOverview();
    if (overviewResponse.success) setOverview(overviewResponse.data);
    setBusy(null);
  };

  if (!overview && !error) return <PageLoading label={t('pages.examiner.loading')} />;

  return (
    <PageShell>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-ink" data-testid="examiner-page-title">
            {t('pages.examiner.title')}
          </h1>
          <p className="mt-1 text-[14px] text-ink-3">{t('pages.examiner.subtitle')}</p>
        </div>
        {selected !== '' && (
          <Button asChild data-testid="examiner-configure-cta">
            <Link to={`/examiner/configure?principle=${encodeURIComponent(selected)}`}>
              <FlaskConical className="size-4" />
              {t('pages.examiner.evaluation.configureCta')}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        )}
      </header>
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-error">
          {error}
        </div>
      )}
      {overview && (
        <>
          <div className="rounded-lg border bg-card p-4 text-sm" data-testid="examiner-scope">
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4" />
              {t('pages.examiner.scope.title')}
            </div>
            <p className="mt-1 text-muted-foreground">{overview.executionScope}</p>
            <div className="mt-3 grid gap-1 text-xs text-muted-foreground">
              {Object.entries(overview.gates).map(([gate, state]) => (
                <div key={gate} data-testid={`examiner-gate-${gate}`}>
                  <span className="font-mono">{gate}</span>: {state}
                </div>
              ))}
            </div>
          </div>

          <SectionTitle>{t('pages.examiner.evaluation.title')}</SectionTitle>
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="grid content-start gap-2" data-testid="examiner-principle-list">
              {principles.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('pages.examiner.evaluation.noActive')}</p>
              )}
              {principles.map((p) => (
                <button
                  key={p.id}
                  className={`rounded-md border px-3 py-2 text-left text-xs ${selected === p.id ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent'}`}
                  onClick={() => void handleSelect(p.id)}
                  data-testid={`examiner-principle-${p.id}`}
                >
                  <span className="font-mono">{p.id}</span>
                  <span className="mt-0.5 block truncate text-muted-foreground">{truncateByCodePoints(p.text, 48)}</span>
                </button>
              ))}
            </div>

            <div className="grid content-start gap-3">
              {evidenceLoading && (
                <div className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground" data-testid="examiner-evidence-loading">
                  <Loader2 className="size-4 animate-spin" />
                  {t('pages.examiner.evaluation.loadingEvidence')}
                </div>
              )}
              {!evidenceLoading && evidence && (
                <>
                  <ExaminerEvidencePanel evidence={evidence} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={busy === 'refresh'} data-testid="examiner-evidence-refresh">
                      {busy === 'refresh' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                      {t('pages.examiner.evaluation.refresh')}
                    </Button>
                    <Button asChild size="sm" data-testid="examiner-evidence-governance">
                      <Link to={`/principles/${encodeURIComponent(selected)}`}>{t('pages.examiner.evaluation.openGovernance')}</Link>
                    </Button>
                  </div>
                </>
              )}
              {!evidenceLoading && !evidence && principles.length > 0 && (
                <p className="text-sm text-muted-foreground">{t('pages.examiner.evaluation.selectPrinciple')}</p>
              )}
            </div>
          </div>

          <SectionTitle>{t('pages.examiner.studies.title')}</SectionTitle>
          <div className="grid gap-2" data-testid="examiner-study-list">
            {overview.studies.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('pages.examiner.studies.empty')}</p>
            )}
            {overview.studies.map((studyId) => (
              <Link
                key={studyId}
                to={`/examiner/studies/${encodeURIComponent(studyId)}`}
                className="flex items-center justify-between rounded-md border bg-card px-3 py-2 font-mono text-xs hover:bg-accent"
                data-testid={`examiner-study-${studyId}`}
              >
                <span>{studyId}</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <FileText className="size-3.5" />
                  {t('pages.examiner.evaluation.openStudy')}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}
