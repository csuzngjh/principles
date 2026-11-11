import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { SectionTitle } from '../../components/layout/section-title.js';
import { Button } from '../../components/ui/button.js';
import { ShieldCheck, Play, FileText, Loader2, ArrowLeft, ArrowRight, ServerCog, Radio } from 'lucide-react';
import {
  fetchExaminerStudyStatus,
  runExaminerPreflight,
  runExaminerStudy,
  generateExaminerReport,
  startExaminerAsyncRun,
  type ExaminerPreflightData,
  type ExaminerStudyStatusData,
} from '../../api.js';

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §10 Page 3 — Execution & Evidence.
 *
 * Answers "did the evaluation actually run, and is the evidence trustworthy?"
 * — study status, the frozen production snapshot (where the A/B start differs
 * from production), the fail-closed preflight, three run modes (offline-stub
 * synchronous / host dry-run / F2 request) and the async console-run ledger
 * with live polling, read-only boundaries and recovery visibility.
 */
export function ExaminerStudyPage(): React.ReactElement {
  const { t } = useTranslation();
  const { studyId = '' } = useParams();
  const [status, setStatus] = useState<ExaminerStudyStatusData | null>(null);
  const [preflight, setPreflight] = useState<ExaminerPreflightData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetchExaminerStudyStatus(studyId);
    if (!response.success) {
      setError(response.error ?? t('pages.examiner.errors.status'));
      return;
    }
    setError(null);
    setStatus(response.data);
  }, [studyId, t]);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Poll while an async console run is in progress (or an offline run is mid-flight).
  const consoleRuns = status?.consoleRuns ?? null;
  const runStarted = status?.runStarted === true;
  const runFinished = status?.runFinished === true;
  useEffect(() => {
    const active = (consoleRuns?.current !== null && consoleRuns?.current !== undefined) || (runStarted && !runFinished);
    if (active && pollRef.current === null) {
      pollRef.current = setInterval(() => {
        void refresh();
      }, 1200);
    }
    if (!active && pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [consoleRuns?.current, runStarted, runFinished, refresh]);

  const handlePreflight = async (): Promise<void> => {
    setBusy('preflight');
    setActionError(null);
    const response = await runExaminerPreflight(studyId);
    setBusy(null);
    if (!response.success) {
      setActionError(response.error ?? t('pages.examiner.errors.preflight'));
      return;
    }
    setPreflight(response.data);
  };

  const handleOfflineRun = async (): Promise<void> => {
    setBusy('offline');
    setActionError(null);
    const response = await runExaminerStudy(studyId);
    setBusy(null);
    if (!response.success) {
      setActionError(response.error ?? t('pages.examiner.errors.run'));
      return;
    }
    toast.success(t('pages.examiner.runDone', { count: response.data.units.filter((u) => u.state === 'SUCCEEDED').length }));
    await refresh();
  };

  // Phase D1: only the offline comparison and the host dry-run are executable
  // from the console. F2 real-host runs are NOT wired to a click path — they
  // need an APPROVED Stage R authorization and the server would refuse anyway.
  const handleAsyncRun = async (): Promise<void> => {
    setBusy('host-dry-run');
    setActionError(null);
    const response = await startExaminerAsyncRun(studyId, 'host-dry-run');
    setBusy(null);
    if (!response.success) {
      setActionError(response.error ?? t('pages.examiner.errors.run'));
      return;
    }
    toast.success(t('pages.examiner.study.accepted.dryRun'));
    await refresh();
  };

  const handleReport = async (): Promise<void> => {
    setBusy('report');
    setActionError(null);
    const response = await generateExaminerReport(studyId);
    setBusy(null);
    if (!response.success) {
      setActionError(response.error ?? t('pages.examiner.errors.report'));
      return;
    }
    toast.success(t('pages.examiner.reportGenerated', { status: response.data.status }));
    await refresh();
  };

  if (!status && !error) return <PageLoading label={t('pages.examiner.loading')} />;
  const readOnly = status?.readOnly === true;
  const snapshot = status?.productionSnapshot ?? null;
  const unitStates = status?.unitStates ?? {};
  const runs = consoleRuns?.runs ?? [];
  const reportStatus = status?.reportStatus ?? null;

  return (
    <PageShell>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/examiner" className="inline-flex items-center gap-1 hover:text-ink">
            <ArrowLeft className="size-3.5" />
            {t('pages.examiner.study.back')}
          </Link>
        </div>
        <h1 className="mt-1 break-all font-mono text-subtitle font-semibold text-ink" data-testid="examiner-study-title">
          {studyId}
        </h1>
      </header>
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-error">{error}</div>
      )}
      {status && (
        <>
          {readOnly && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400" data-testid="examiner-study-readonly">
              {t('pages.examiner.study.readOnly')}: {status.access ?? ''}
            </div>
          )}

          <SectionTitle>{t('pages.examiner.study.statusTitle')}</SectionTitle>
          <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-study-detail">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              <div>{t('pages.examiner.study.mode')}: <span className="font-mono">{status.experimentMode}</span></div>
              <div>{t('pages.examiner.study.intervention')}: <span className="font-mono">{status.interventionType}</span></div>
              <div>{t('pages.examiner.study.target')}: <span className="font-mono">{status.targetPrincipleId ?? ''}</span></div>
              <div>{t('pages.examiner.study.plannedPairs')}: {status.plannedPairs ?? '—'}</div>
              <div>{t('pages.examiner.study.run')}: {runStarted ? (runFinished ? t('pages.examiner.study.finished') : t('pages.examiner.study.running')) : t('pages.examiner.study.notRun')}</div>
              <div>{t('pages.examiner.study.report')}: <span className="font-mono">{reportStatus ?? '—'}</span></div>
            </div>
            {Object.keys(unitStates).length > 0 && (
              <div className="text-xs text-muted-foreground" data-testid="examiner-unit-states">
                {Object.entries(unitStates).map(([state, count]) => `${state}: ${count}`).join(' · ')}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void handlePreflight()} disabled={busy !== null} data-testid="examiner-preflight-button">
                {busy === 'preflight' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                {t('pages.examiner.study.preflight')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleOfflineRun()} disabled={busy !== null || readOnly} data-testid="examiner-run-button">
                {busy === 'offline' ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {t('pages.examiner.study.runOffline')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleAsyncRun()} disabled={busy !== null || readOnly} data-testid="examiner-dryrun-button">
                {busy === 'host-dry-run' ? <Loader2 className="size-4 animate-spin" /> : <ServerCog className="size-4" />}
                {t('pages.examiner.study.runDry')}
              </Button>
              {/* Phase D1/D2: F2 is NOT an executable action. It is shown as a
                  stated, non-clickable limitation with the reason and next step,
                  so nobody can mistake it for an available run mode. */}
              <div className="w-full rounded-md border border-dashed p-2 text-caption text-muted-foreground" data-testid="examiner-f2-unavailable">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" disabled data-testid="examiner-f2-button">
                    <Radio className="size-4" />
                    {t('pages.examiner.study.requestF2')}
                  </Button>
                  <span className="font-medium text-ink-3">{t('pages.examiner.study.f2ClosedTitle')}</span>
                </div>
                <p className="mt-1">{t('pages.examiner.study.f2ClosedBody')}</p>
                <p className="mt-1">{t('pages.examiner.study.f2ClosedNext')}</p>
              </div>
              <Button size="sm" onClick={() => void handleReport()} disabled={busy !== null || readOnly} data-testid="examiner-report-button">
                {busy === 'report' ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                {t('pages.examiner.study.report')}
              </Button>
              {reportStatus !== null && (
                <Button asChild size="sm" variant="outline" data-testid="examiner-open-report">
                  <Link to={`/examiner/studies/${encodeURIComponent(studyId)}/report`}>
                    {t('pages.examiner.study.openReport')}
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              )}
            </div>
            <p className="text-caption text-muted-foreground">{t('pages.examiner.study.modesNote')}</p>

            {actionError !== null && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" data-testid="examiner-action-error">
                <div>{actionError}</div>
                <div className="mt-1 text-muted-foreground">{t('pages.examiner.study.actionErrorNext')}</div>
              </div>
            )}

            {preflight && (
              <div className="rounded-md border p-3 text-xs" data-testid="examiner-preflight-result">
                <div className="font-medium">{t('pages.examiner.preflight.status')}: {preflight.status}</div>
                {preflight.blockers.length > 0 && (
                  <div className="mt-2 text-destructive">
                    {preflight.blockers.map((b) => (
                      <div key={b.id}>⛔ {b.id}: {b.detail}</div>
                    ))}
                  </div>
                )}
                {preflight.warnings.length > 0 && (
                  <div className="mt-2 text-amber-600 dark:text-amber-400">
                    {preflight.warnings.map((w) => (
                      <div key={w.id}>⚠ {w.id}: {w.detail}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {snapshot && (
            <>
              <SectionTitle>{t('pages.examiner.study.snapshot.title')}</SectionTitle>
              <div className="grid gap-2 rounded-lg border bg-card p-4 text-xs" data-testid="examiner-study-snapshot">
                <div className="text-sm">{t('pages.examiner.study.snapshot.frozenAt')}: {snapshot.asOf}</div>
                <div>{t('pages.examiner.study.snapshot.route')}: <span className="font-mono">{snapshot.promptRoute.routeName ?? '—'}</span> ({snapshot.promptRoute.status})</div>
                <div>
                  {t('pages.examiner.study.snapshot.budget')}: <span className="font-mono">{snapshot.budget.chars ?? '—'}</span> {snapshot.budget.unit}
                  {snapshot.budget.capacitySource ? ` · ${snapshot.budget.capacitySource}/${snapshot.budget.capacityStatus}` : ''}
                </div>
                <div>
                  {t('pages.examiner.study.snapshot.divergence')}: <span className="font-mono">{snapshot.divergence.activeInLedgerNotRuntime.length}</span>
                </div>
                {/* P1-2: a degraded activation read is shown with its reason —
                    the frozen baseline is UNKNOWN, never silently "zero". */}
                {snapshot.runtimeActivation?.status === 'degraded' && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-400" data-testid="examiner-study-snapshot-activation-degraded">
                    {t('pages.examiner.study.snapshot.activationDegraded')}: {snapshot.runtimeActivation.reason ?? ''}
                    {snapshot.runtimeActivation.nextAction ? ` → ${snapshot.runtimeActivation.nextAction}` : ''}
                  </div>
                )}
                <div className="flex flex-wrap gap-1" data-testid="examiner-study-snapshot-markers">
                  {snapshot.experimentVsProduction.markers.map((marker) => (
                    <span key={marker} className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-caption text-amber-700 dark:text-amber-400">{marker}</span>
                  ))}
                  {snapshot.experimentVsProduction.markers.length === 0 && (
                    <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-caption text-emerald-700 dark:text-emerald-400">
                      {t('pages.examiner.study.snapshot.matchesProduction')}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground">{snapshot.experimentVsProduction.note}</p>
              </div>
            </>
          )}

          <SectionTitle>{t('pages.examiner.study.runs.title')}</SectionTitle>
          {consoleRuns?.ledgerProblem && (
            <div className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" data-testid="examiner-console-runs-problem">
              {t('pages.examiner.study.runs.ledgerProblem')}: {consoleRuns.ledgerProblem.message}
            </div>
          )}
          <div className="grid gap-2 rounded-lg border bg-card p-4 text-xs" data-testid="examiner-console-runs">
            {runs.length === 0 && <p className="text-muted-foreground">{t('pages.examiner.study.runs.empty')}</p>}
            {runs.map((run) => (
              <div key={run.runId} className="rounded-md border p-2" data-testid={`examiner-console-run-${run.status}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 font-mono text-caption ${run.status === 'FINISHED' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : run.status === 'RUNNING' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'}`}>
                    {run.status}
                  </span>
                  <span className="font-mono">{run.mode}</span>
                  <span className="text-muted-foreground">{new Date(run.acceptedAt).toLocaleString()}</span>
                  {run.outcome !== null && <span className="font-mono text-caption">{run.outcome}</span>}
                </div>
                {run.reason !== null && <div className="mt-1 text-muted-foreground">{run.reason}</div>}
                {run.checks !== undefined && run.checks.length > 0 && (
                  <ul className="mt-1 grid gap-0.5 font-mono text-caption" data-testid={`examiner-console-run-checks-${run.runId}`}>
                    {run.checks.map((check) => (
                      <li key={check.id} className={check.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
                        {check.ok ? 'PASS' : 'FAIL'} · {check.id}: {check.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}
