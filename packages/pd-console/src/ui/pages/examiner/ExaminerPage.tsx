import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { SectionTitle } from '../../components/layout/section-title.js';
import { Button } from '../../components/ui/button.js';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { ShieldCheck, FlaskConical, ArrowRight, RefreshCw, Loader2, FileText, AlertTriangle } from 'lucide-react';
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
  const [principlesStatus, setPrinciplesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [principlesError, setPrinciplesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [evidence, setEvidence] = useState<ExaminerEvidenceData | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Monotonic request sequence: a slower earlier response must never overwrite
  // the panel for the principle the Owner selected last (including A→B→A,
  // where comparing ids alone would accept the stale A response).
  const evidenceRequestSeq = useRef(0);
  const loadEvidence = useCallback(async (principleId: string) => {
    const seq = evidenceRequestSeq.current + 1;
    evidenceRequestSeq.current = seq;
    setEvidenceLoading(true);
    setEvidence(null);
    setEvidenceError(null);
    const response = await fetchExaminerPrincipleEvidence(principleId);
    if (evidenceRequestSeq.current !== seq) return;
    setEvidenceLoading(false);
    if (!response.success) {
      setEvidenceError(response.error ?? t('pages.examiner.errors.evidence'));
      return;
    }
    setEvidence(response.data);
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPrinciplesStatus('loading');
      setPrinciplesError(null);
      setError(null);

      const overviewResponse = await fetchExaminerOverview();
      if (cancelled) return;
      if (overviewResponse.success) setOverview(overviewResponse.data);
      else setError(overviewResponse.error ?? t('pages.examiner.errors.unavailable'));

      const principlesResponse = await fetchExaminerPrinciples();
      if (cancelled) return;
      if (!principlesResponse.success) {
        // A failed request is NOT "no evaluable principle": keep the two
        // states visually and semantically separate (Phase B1).
        setPrinciples([]);
        setPrinciplesStatus('error');
        setPrinciplesError(principlesResponse.error ?? t('pages.examiner.errors.principles'));
        setSelected('');
        setEvidence(null);
        return;
      }
      const active = principlesResponse.data.principles.filter((p) => p.status === 'active');
      setPrinciples(active);
      setPrinciplesStatus('ready');
      const initial = prefillPrinciple !== null && active.some((p) => p.id === prefillPrinciple)
        ? prefillPrinciple
        : active[0]?.id ?? '';
      setSelected(initial);
      if (initial !== '') await loadEvidence(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [t, prefillPrinciple, loadEvidence, reloadToken]);

  const handleSelect = async (principleId: string): Promise<void> => {
    setSelected(principleId);
    await loadEvidence(principleId);
  };

  const handleRetryAll = (): void => {
    setReloadToken((token) => token + 1);
  };

  const handleRefresh = async (): Promise<void> => {
    if (selected === '') return;
    setBusy('refresh');
    await loadEvidence(selected);
    const overviewResponse = await fetchExaminerOverview();
    if (overviewResponse.success) setOverview(overviewResponse.data);
    setBusy(null);
  };

  if (principlesStatus === 'loading' && overview === null && error === null) {
    return <PageLoading label={t('pages.examiner.loading')} />;
  }

  return (
    <PageShell>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-ink" data-testid="examiner-page-title">
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

      <section className="mb-5 rounded-lg border bg-card p-4" data-testid="examiner-guide">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FlaskConical className="size-4" />
          {t('pages.examiner.guide.title')}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('pages.examiner.guide.what')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('pages.examiner.guide.target')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('pages.examiner.guide.difference')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="examiner-guide-flow">
          <span className="font-medium text-ink-3">{t('pages.examiner.guide.flowLabel')}</span>
          {([
            'pages.examiner.guide.flowEvidence',
            'pages.examiner.guide.flowSelect',
            'pages.examiner.guide.flowCreate',
            'pages.examiner.guide.flowReport',
            'pages.examiner.guide.flowDecide',
          ] as const).map((key, index) => (
            <React.Fragment key={key}>
              {index > 0 && <ArrowRight className="size-3" />}
              <span className="rounded border bg-muted/40 px-1.5 py-0.5">{t(key)}</span>
            </React.Fragment>
          ))}
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <span className="font-medium">{t('pages.examiner.guide.canTitle')}</span>
            <p className="text-muted-foreground">{t('pages.examiner.guide.canBody')}</p>
          </div>
          <div>
            <span className="font-medium">{t('pages.examiner.guide.cannotTitle')}</span>
            <p className="text-muted-foreground">{t('pages.examiner.guide.cannotBody')}</p>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-ink-3">{t('pages.examiner.guide.whenTitle')}</span>
          <span className="ml-2">
            {[
              t('pages.examiner.guide.when1'),
              t('pages.examiner.guide.when2'),
              t('pages.examiner.guide.when3'),
              t('pages.examiner.guide.when4'),
            ].join(' · ')}
          </span>
        </p>
      </section>

      {error && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-error">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </span>
          <Button variant="outline" size="sm" onClick={handleRetryAll} data-testid="examiner-overview-retry">
            <RefreshCw className="size-4" />
            {t('pages.examiner.errors.retry')}
          </Button>
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
              {principlesStatus === 'error' && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" data-testid="examiner-principles-error">
                  <span className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {t('pages.examiner.errors.principles')}
                      {principlesError !== null && (
                        <span className="mt-1 block font-mono text-caption opacity-80">{principlesError}</span>
                      )}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={handleRetryAll}
                    data-testid="examiner-principles-retry"
                  >
                    <RefreshCw className="size-3.5" />
                    {t('pages.examiner.errors.retry')}
                  </Button>
                </div>
              )}
              {principlesStatus === 'ready' && principles.length === 0 && (
                <div className="rounded-md border bg-card p-3 text-xs" data-testid="examiner-no-active-principles">
                  <p className="font-medium">{t('pages.examiner.evaluation.noActive')}</p>
                  <p className="mt-1 text-muted-foreground">{t('pages.examiner.evaluation.noActiveHint')}</p>
                </div>
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
                  {t('pages.examiner.evaluation.loadingEvidenceFor', { principleId: selected })}
                </div>
              )}
              {!evidenceLoading && evidenceError !== null && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-evidence-error">
                  <span className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {t('pages.examiner.evaluation.evidenceError', { principleId: selected })}
                      <span className="mt-1 block font-mono text-caption opacity-80">{evidenceError}</span>
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void loadEvidence(selected)}
                    data-testid="examiner-evidence-retry"
                  >
                    <RefreshCw className="size-3.5" />
                    {t('pages.examiner.evaluation.evidenceRetry')}
                  </Button>
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
              {!evidenceLoading && !evidence && evidenceError === null && principles.length > 0 && (
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
