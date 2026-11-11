import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { SectionTitle } from '../../components/layout/section-title.js';
import { Button } from '../../components/ui/button.js';
import { ArrowLeft, ExternalLink, Scale, RefreshCw, Loader2 } from 'lucide-react';
import {
  fetchExaminerReport,
  fetchExaminerStudyStatus,
  fetchExaminerPrincipleEvidence,
  type ExaminerReportData,
  type ExaminerStudyStatusData,
  type ExaminerEvidenceData,
} from '../../api.js';
import { ExaminerEvidencePanel } from './examiner-evidence-panel.js';

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §10 Page 4 — Evaluation Report.
 *
 * Answers "is this principle worth keeping, and what happens next?" — the
 * Controlled A/B result (Report V2: ITT + fidelity + randomization + replay
 * verification), its limitations, the SEPARATE production observation for the
 * same principle, and the Owner Decision handoff into the existing governance
 * workflow (the report never mutates lifecycle itself).
 */
export function ExaminerReportPage(): React.ReactElement {
  const { t } = useTranslation();
  const { studyId = '' } = useParams();
  const [report, setReport] = useState<ExaminerReportData | null>(null);
  const [evidence, setEvidence] = useState<ExaminerEvidenceData | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [studyStatus, setStudyStatus] = useState<ExaminerStudyStatusData | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [reportResponse, statusResponse] = await Promise.all([
        fetchExaminerReport(studyId),
        fetchExaminerStudyStatus(studyId),
      ]);
      if (cancelled) return;
      if (statusResponse.success) {
        setReadOnly(statusResponse.data.readOnly === true);
        setStudyStatus(statusResponse.data);
      }
      // Commit the REPORT state first: the production-evidence aggregate is a
      // separate, optional lane and must never hold the report behind its own
      // slow request.
      if (!reportResponse.success) {
        if (reportResponse.code === 'report_not_generated') setMissing(true);
        else setError(reportResponse.error ?? t('pages.examiner.errors.report'));
      } else {
        setReport(reportResponse.data);
      }
      const targetId = statusResponse.success ? statusResponse.data.targetPrincipleId : null;
      if (typeof targetId === 'string' && targetId !== '') {
        const evidenceResponse = await fetchExaminerPrincipleEvidence(targetId);
        if (!cancelled && evidenceResponse.success) setEvidence(evidenceResponse.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studyId, t]);

  const handleRefresh = async (): Promise<void> => {
    setBusy(true);
    const [reportResponse, evidenceResponse] = await Promise.all([
      fetchExaminerReport(studyId),
      report?.report.examiner?.targetPrincipleId
        ? fetchExaminerPrincipleEvidence(report.report.examiner.targetPrincipleId)
        : Promise.resolve(null),
    ]);
    setBusy(false);
    if (!reportResponse.success) {
      toast.error(reportResponse.error ?? t('pages.examiner.errors.report'));
      return;
    }
    setReport(reportResponse.data);
    if (evidenceResponse !== null && evidenceResponse.success) setEvidence(evidenceResponse.data);
  };

  if (!report && !missing && !error) return <PageLoading label={t('pages.examiner.loading')} />;
  const examiner = report?.report.examiner ?? null;
  const verificationOk = report ? report.verification.checks.every((check) => check.ok) : false;
  const targetId = examiner?.targetPrincipleId ?? null;

  const executionMode = report?.report.scope?.executionMode ?? null;
  const modeKey = executionMode === 'real' ? 'modeReal' : executionMode === 'offline-stub' ? 'modeOffline' : 'modeUnknown';
  const modeLabel = t(`pages.examiner.executionMode.${modeKey}`);
  const modeNoteKey = executionMode === 'real' ? 'realNote' : executionMode === 'offline-stub' ? 'offlineNote' : 'unknownNote';
  const dryRunCount = studyStatus?.consoleRuns?.runs.filter((run) => run.mode === 'host-dry-run').length ?? 0;
  const realRunCount = studyStatus?.consoleRuns?.runs.filter((run) => run.mode === 'f2-real-host').length ?? 0;
  const offlineRan = examiner !== null;
  const estimateStatus = examiner?.itt.pointEstimate.status ?? null;
  const estimateValue = typeof examiner?.itt.pointEstimate.value === 'number' ? examiner.itt.pointEstimate.value : null;
  const estimateText = estimateValue === null ? null : `${(Math.abs(estimateValue) * 100).toFixed(1)}%`;

  let conclusion: string;
  if (!verificationOk) conclusion = t('pages.examiner.ownerSummary.conclusionUnverified');
  else if (examiner === null) conclusion = t('pages.examiner.ownerSummary.conclusionNoControlled');
  else if (estimateStatus !== 'ESTIMABLE' || estimateValue === null) {
    conclusion = t('pages.examiner.ownerSummary.conclusionInsufficient', {
      planned: examiner.itt.plannedApplicablePairs,
      determined: examiner.itt.determinedPairs,
    });
  } else if (estimateValue === 0) conclusion = t('pages.examiner.ownerSummary.conclusionNoDifference');
  else if (estimateValue > 0) conclusion = t('pages.examiner.ownerSummary.conclusionPositive', { value: estimateText });
  else conclusion = t('pages.examiner.ownerSummary.conclusionNegative', { value: estimateText });

  const rationale: string[] = [t('pages.examiner.ownerSummary.rationaleMode', { mode: modeLabel })];
  if (examiner !== null) {
    rationale.push(t('pages.examiner.ownerSummary.rationalePairs', {
      planned: examiner.itt.plannedApplicablePairs,
      determined: examiner.itt.determinedPairs,
      unknown: examiner.itt.unknownPairs,
      na: examiner.applicability.notApplicablePairs,
    }));
    rationale.push(t('pages.examiner.ownerSummary.rationaleFidelity', {
      present: examiner.treatmentFidelity.contextPresent,
      planned: examiner.treatmentFidelity.plannedTreatmentUnits,
      contamination: examiner.treatmentFidelity.controlContamination.units,
      evictions: examiner.treatmentFidelity.capacityEvictions.units,
    }));
  }
  rationale.push(t('pages.examiner.ownerSummary.rationaleReplay', { status: verificationOk ? 'OK' : 'FAILED' }));
  if (Array.isArray(report?.report.limitations) && report.report.limitations.length > 0) {
    rationale.push(t('pages.examiner.ownerSummary.rationaleLimitations', { count: report.report.limitations.length }));
  }
  const evidenceSufficient = verificationOk && examiner !== null && estimateStatus === 'ESTIMABLE' && estimateValue !== null;
  // Phase E1: "what this cannot prove yet" is stated explicitly, not left to
  // the Owner to infer from missing sections.
  const cannotProve: string[] = [];
  if (executionMode !== 'real') cannotProve.push(t('pages.examiner.ownerSummary.cannotProveOffline'));
  cannotProve.push(t('pages.examiner.ownerSummary.cannotProveCausal'));
  if (!evidenceSufficient) cannotProve.push(t('pages.examiner.ownerSummary.cannotProveVerdict'));
  const nextStep = evidenceSufficient
    ? t('pages.examiner.ownerSummary.nextGovernance')
    : t('pages.examiner.ownerSummary.nextFixEvidence');

  return (
    <PageShell>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to={`/examiner/studies/${encodeURIComponent(studyId)}`} className="inline-flex items-center gap-1 hover:text-ink">
            <ArrowLeft className="size-3.5" />
            {t('pages.examiner.report.back')}
          </Link>
        </div>
        <h1 className="mt-1 text-[20px] font-semibold text-ink" data-testid="examiner-report-title">
          {t('pages.examiner.report.title')}
        </h1>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{studyId}</p>
      </header>
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-error">{error}</div>
      )}
      {missing && (
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground" data-testid="examiner-report-missing">
          {t('pages.examiner.report.missing')}
        </div>
      )}

      {report && (
        <>
          {/* Phase E2: Owner Summary — conclusion and next step first, in plain
              language; technical detail is pushed below. Rendered even when no
              controlled result exists: "we cannot conclude yet" is itself the
              answer the Owner needs, never a missing section. */}
          <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-owner-summary">
              <div>
                <div className="text-xs font-medium text-ink-3">{t('pages.examiner.ownerSummary.title')}</div>
                <p className="mt-1 text-[15px] font-medium text-ink" data-testid="examiner-owner-summary-conclusion">{conclusion}</p>
              </div>
              <div data-testid="examiner-owner-summary-rationale">
                <div className="text-xs font-medium text-ink-3">{t('pages.examiner.ownerSummary.rationale')}</div>
                <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                  {rationale.map((line) => <li key={line}>· {line}</li>)}
                </ul>
              </div>
              <div data-testid="examiner-owner-summary-cannot-prove">
                <div className="text-xs font-medium text-ink-3">{t('pages.examiner.ownerSummary.cannotProveTitle')}</div>
                <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                  {cannotProve.map((line) => <li key={line}>· {line}</li>)}
                </ul>
              </div>
              <div data-testid="examiner-owner-summary-next">
                <div className="text-xs font-medium text-ink-3">{t('pages.examiner.ownerSummary.next')}</div>
                <p className="mt-1 text-xs text-muted-foreground">{nextStep}</p>
              </div>
          </div>

          {/* Phase E3: which execution mode produced this report, and what each
              mode can / cannot support. */}
          <div className="mb-4 grid gap-2 rounded-lg border bg-card p-4 text-xs" data-testid="examiner-execution-mode" data-mode={executionMode ?? 'unknown'}>
            <div className="font-medium text-ink-3">{t('pages.examiner.executionMode.title')}</div>
            <div className="font-medium text-ink" data-testid="examiner-execution-mode-current">
              {t('pages.examiner.executionMode.current', { mode: modeLabel })}
            </div>
            <p className="text-muted-foreground">{t(`pages.examiner.executionMode.${modeNoteKey}`)}</p>
            <div className="grid gap-0.5 text-muted-foreground">
              <span data-testid="examiner-execution-mode-offline">
                {t('pages.examiner.executionMode.offlineLine', { state: offlineRan ? t('pages.examiner.executionMode.ran') : t('pages.examiner.executionMode.notRun') })}
              </span>
              <span data-testid="examiner-execution-mode-dryrun">
                {t('pages.examiner.executionMode.dryRunLine', { count: dryRunCount })}
              </span>
              <span data-testid="examiner-execution-mode-f2">
                {t('pages.examiner.executionMode.f2Line', { count: realRunCount })}
              </span>
            </div>
          </div>

          {/* Phase E1: scope and limitations collected in ONE place. */}
          <div className="mb-4 grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-700 dark:text-amber-400" data-testid="examiner-report-scope-limits">
            <div className="font-medium">{t('pages.examiner.report.limitationsSection')}</div>
            <p data-testid="examiner-report-offline-note">{t('pages.examiner.report.offlineNote')}</p>
            {Array.isArray(report.report.limitations) && report.report.limitations.length > 0 && (
              <div data-testid="examiner-report-limitations">
                {report.report.limitations.map((limitation) => (
                  <div key={limitation}>· {limitation}</div>
                ))}
              </div>
            )}
            {examiner === null && <p>{t('pages.examiner.report.noExaminerBlock')}</p>}
          </div>

          <SectionTitle>{t('pages.examiner.report.technicalTitle')}</SectionTitle>
          <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-report">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{report.report.status}</span>
              {examiner && <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{examiner.experimentMode}</span>}
              <span className={`rounded px-2 py-0.5 text-xs ${verificationOk ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-destructive/15 text-destructive'}`} data-testid="examiner-report-verification">
                {t('pages.examiner.report.replay')} {verificationOk ? 'OK' : 'FAILED'}
              </span>
              {readOnly && <span className="rounded bg-muted px-2 py-0.5 text-xs">{t('pages.examiner.study.readOnly')}</span>}
            </div>

            {examiner ? (
              <div className="grid gap-3">
                <div className="text-xs text-muted-foreground">
                  {t('pages.examiner.report.target')}: <span className="font-mono">{examiner.targetPrincipleId}</span> · {t('pages.examiner.report.endpoint')}: <span className="font-mono">{examiner.primaryEndpoint?.id ?? '—'}</span>
                </div>
                <div className="rounded-md border p-3" data-testid="examiner-report-itt">
                  <div className="font-medium">ITT</div>
                  {examiner.itt.pointEstimate.status === 'ESTIMABLE' ? (
                    <div className="text-2xl font-bold">{examiner.itt.pointEstimate.value}</div>
                  ) : (
                    <div className="font-mono text-sm">
                      [{examiner.itt.lowerBound.value ?? 'n/a'}, {examiner.itt.upperBound.value ?? 'n/a'}]
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {t('pages.examiner.report.ittNote', {
                      planned: examiner.itt.plannedApplicablePairs,
                      determined: examiner.itt.determinedPairs,
                      unknown: examiner.itt.unknownPairs,
                      na: examiner.applicability.notApplicablePairs,
                    })}
                  </div>
                </div>
                <div className="rounded-md border p-3" data-testid="examiner-report-fidelity">
                  <div className="font-medium">{t('pages.examiner.report.fidelity')}</div>
                  <div className="text-xs">
                    CONTEXT_PRESENT+ {examiner.treatmentFidelity.contextPresent}/{examiner.treatmentFidelity.plannedTreatmentUnits} · RUNTIME_LOADED {examiner.treatmentFidelity.runtimeLoaded} · {t('pages.examiner.report.contamination')} {examiner.treatmentFidelity.controlContamination.units} · {t('pages.examiner.report.evictions')} {examiner.treatmentFidelity.capacityEvictions.units}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Owner Decision handoff — existing governance, no new decision system */}
          <SectionTitle>{t('pages.examiner.report.handoff.title')}</SectionTitle>
          <div className="grid gap-2 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-report-handoff">
            <p className="text-xs text-muted-foreground">{t('pages.examiner.report.handoff.note')}</p>
            <div className="flex flex-wrap gap-2">
              {targetId !== null && (
                <Button asChild size="sm" data-testid="examiner-report-handoff-governance">
                  <Link to={`/principles/${encodeURIComponent(targetId)}`}>
                    <Scale className="size-4" />
                    {t('pages.examiner.report.handoff.openGovernance')}
                    <ExternalLink className="size-3.5" />
                  </Link>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={busy} data-testid="examiner-report-refresh">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {t('pages.examiner.report.handoff.refresh')}
              </Button>
            </div>
          </div>

          {/* Production observation — a SEPARATE lane, never merged into the A/B numbers */}
          <SectionTitle>{t('pages.examiner.report.production.title')}</SectionTitle>
          {evidence ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground" data-testid="examiner-report-production-note">
                {t('pages.examiner.report.production.note')}
              </p>
              <ExaminerEvidencePanel evidence={evidence} compact />
            </>
          ) : (
            <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground" data-testid="examiner-report-production-missing">
              {t('pages.examiner.report.production.missing')}
            </p>
          )}
        </>
      )}
    </PageShell>
  );
}
