import React, { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import { FlaskConical, ShieldCheck, Play, FileText, Loader2 } from "lucide-react";
import {
  fetchExaminerOverview,
  fetchExaminerPrinciples,
  createExaminerStudy,
  fetchExaminerStudyStatus,
  runExaminerPreflight,
  runExaminerStudy,
  generateExaminerReport,
  fetchExaminerReport,
  type ExaminerOverviewData,
  type ExaminerPrincipleItem,
  type ExaminerStudyStatusData,
  type ExaminerPreflightData,
  type ExaminerReportData,
} from "../../api.js";

/**
 * SPEC-PD-EXAMINER-001 v0.9 §8 — Examiner product entry (offline-first).
 *
 * The Owner journey: pick a target principle from the workspace ledger →
 * choose a mode (full-library incremental default / isolated diagnostic) →
 * create the study (server-minted identity) → run the fail-closed preflight →
 * run the OFFLINE-STUB execution → read the Report V2 (ITT + fidelity).
 *
 * Honesty contract: every result is labelled offline-stub / synthetic gold —
 * the console NEVER presents these as real-host behavior; real runs require
 * separate Owner authorization (the gates panel says exactly what is and is
 * not ready).
 */
export function ExaminerPage(): React.ReactElement {
  const { t } = useTranslation();
  // §8.1: prefill the target from the principle-detail entry link
  // (?principle=<id>); only an EXACT id match is honored.
  const [searchParams] = useSearchParams();
  const prefillPrinciple = searchParams.get("principle");
  const [overview, setOverview] = useState<ExaminerOverviewData | null>(null);
  const [principles, setPrinciples] = useState<ExaminerPrincipleItem[]>([]);
  const [targetPrincipleId, setTargetPrincipleId] = useState("");
  const [experimentMode, setExperimentMode] = useState<"full_library_incremental" | "isolated_principle">("full_library_incremental");
  const [repetitions, setRepetitions] = useState(2);
  const [selectedStudy, setSelectedStudy] = useState<string | null>(null);
  const [status, setStatus] = useState<ExaminerStudyStatusData | null>(null);
  const [preflight, setPreflight] = useState<ExaminerPreflightData | null>(null);
  const [report, setReport] = useState<ExaminerReportData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (studyId: string) => {
    const statusResponse = await fetchExaminerStudyStatus(studyId);
    if (!statusResponse.success) {
      setError(statusResponse.error ?? "status unavailable");
      return;
    }
    setStatus(statusResponse.data);
  }, []);

  const selectStudy = useCallback(async (studyId: string) => {
    setSelectedStudy(studyId);
    setStatus(null);
    setPreflight(null);
    setReport(null);
    await refreshStatus(studyId);
    const reportResponse = await fetchExaminerReport(studyId);
    if (reportResponse.success) setReport(reportResponse.data);
  }, [refreshStatus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const overviewResponse = await fetchExaminerOverview();
      if (cancelled) return;
      if (!overviewResponse.success) {
        setError(overviewResponse.error ?? t("pages.examiner.errors.unavailable"));
        return;
      }
      setOverview(overviewResponse.data);
      const principlesResponse = await fetchExaminerPrinciples();
      if (!cancelled && principlesResponse.success) {
        const active = principlesResponse.data.principles.filter((p) => p.status === "active");
        setPrinciples(active);
        if (prefillPrinciple !== null) {
          const prefilled = active.find((p) => p.id === prefillPrinciple);
          if (prefilled !== undefined) setTargetPrincipleId(prefilled.id);
          else if (active[0] !== undefined) setTargetPrincipleId(active[0].id);
        } else if (active[0] !== undefined) {
          setTargetPrincipleId(active[0].id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, prefillPrinciple]);

  const handleCreate = async () => {
    if (!targetPrincipleId) return;
    setBusy("create");
    setError(null);
    const response = await createExaminerStudy({ targetPrincipleId, experimentMode, repetitionsPerCase: repetitions });
    setBusy(null);
    if (!response.success) {
      toast.error(response.error ?? t("pages.examiner.errors.create"));
      return;
    }
    toast.success(t("pages.examiner.created", { studyId: response.data.studyId }));
    const overviewResponse = await fetchExaminerOverview();
    if (overviewResponse.success) setOverview(overviewResponse.data);
    await selectStudy(response.data.studyId);
  };

  const handlePreflight = async () => {
    if (!selectedStudy) return;
    setBusy("preflight");
    const response = await runExaminerPreflight(selectedStudy);
    setBusy(null);
    if (!response.success) {
      toast.error(response.error ?? t("pages.examiner.errors.preflight"));
      return;
    }
    setPreflight(response.data);
  };

  const handleRun = async () => {
    if (!selectedStudy) return;
    setBusy("run");
    const response = await runExaminerStudy(selectedStudy);
    setBusy(null);
    if (!response.success) {
      toast.error(response.error ?? t("pages.examiner.errors.run"));
      return;
    }
    toast.success(t("pages.examiner.runDone", { count: response.data.units.filter((u) => u.state === "SUCCEEDED").length }));
    await refreshStatus(selectedStudy);
  };

  const handleReport = async () => {
    if (!selectedStudy) return;
    setBusy("report");
    const generated = await generateExaminerReport(selectedStudy);
    setBusy(null);
    if (!generated.success) {
      toast.error(generated.error ?? t("pages.examiner.errors.report"));
      return;
    }
    const fetched = await fetchExaminerReport(selectedStudy);
    if (fetched.success) setReport(fetched.data);
    await refreshStatus(selectedStudy);
    toast.success(t("pages.examiner.reportGenerated", { status: generated.data.status }));
  };

  if (!overview && !error) return <PageLoading label={t("pages.examiner.loading")} />;

  return (
    <PageShell>
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold text-ink" data-testid="examiner-page-title">
          {t("pages.examiner.title")}
        </h1>
        <p className="mt-1 text-[14px] text-ink-3">{t("pages.examiner.subtitle")}</p>
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
              {t("pages.examiner.scope.title")}
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

          <SectionTitle>{t("pages.examiner.create.title")}</SectionTitle>
          <div className="grid gap-3 rounded-lg border bg-card p-4" data-testid="examiner-create">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("pages.examiner.create.target")}</span>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={targetPrincipleId}
                onChange={(e) => setTargetPrincipleId(e.target.value)}
                data-testid="examiner-target-select"
              >
                {principles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} — {p.text.slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("pages.examiner.create.mode")}</span>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={experimentMode}
                onChange={(e) => setExperimentMode(e.target.value as typeof experimentMode)}
                data-testid="examiner-mode-select"
              >
                <option value="full_library_incremental">{t("pages.examiner.mode.full")}</option>
                <option value="isolated_principle">{t("pages.examiner.mode.isolated")}</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("pages.examiner.create.repetitions")}</span>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={repetitions}
                onChange={(e) => setRepetitions(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <Button onClick={handleCreate} disabled={!targetPrincipleId || busy === "create"} data-testid="examiner-create-button">
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              {t("pages.examiner.create.submit")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("pages.examiner.create.note")}</p>
          </div>

          <SectionTitle>{t("pages.examiner.studies.title")}</SectionTitle>
          <div className="grid gap-2" data-testid="examiner-study-list">
            {overview.studies.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("pages.examiner.studies.empty")}</p>
            )}
            {overview.studies.map((studyId) => (
              <button
                key={studyId}
                className={`rounded-md border px-3 py-2 text-left font-mono text-xs ${selectedStudy === studyId ? "border-primary bg-primary/10" : "bg-card hover:bg-accent"}`}
                onClick={() => selectStudy(studyId)}
                data-testid={`examiner-study-${studyId}`}
              >
                {studyId}
              </button>
            ))}
          </div>

          {selectedStudy && status && (
            <>
              <SectionTitle>{t("pages.examiner.study.title", { studyId: selectedStudy })}</SectionTitle>
              <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-study-detail">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>{t("pages.examiner.study.mode")}: <span className="font-mono">{status.experimentMode}</span></div>
                  <div>{t("pages.examiner.study.intervention")}: <span className="font-mono">{status.interventionType}</span></div>
                  <div>{t("pages.examiner.study.target")}: <span className="font-mono">{status.targetPrincipleId}</span></div>
                  <div>{t("pages.examiner.study.plannedPairs")}: {status.plannedPairs}</div>
                  <div>{t("pages.examiner.study.run")}: {status.runStarted ? (status.runFinished ? t("pages.examiner.study.finished") : t("pages.examiner.study.running")) : t("pages.examiner.study.notRun")}</div>
                  <div>{t("pages.examiner.study.report")}: <span className="font-mono">{status.reportStatus ?? "—"}</span></div>
                </div>
                {Object.keys(status.unitStates).length > 0 && (
                  <div className="text-xs text-muted-foreground" data-testid="examiner-unit-states">
                    {Object.entries(status.unitStates).map(([state, count]) => `${state}: ${count}`).join(" · ")}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handlePreflight} disabled={busy === "preflight"} data-testid="examiner-preflight-button">
                    {busy === "preflight" ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                    {t("pages.examiner.study.preflight")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleRun} disabled={busy === "run"} data-testid="examiner-run-button">
                    {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                    {t("pages.examiner.study.runOffline")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleReport} disabled={busy === "report"} data-testid="examiner-report-button">
                    {busy === "report" ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                    {t("pages.examiner.study.report")}
                  </Button>
                </div>

                {preflight && (
                  <div className="rounded-md border p-3 text-xs" data-testid="examiner-preflight-result">
                    <div className="font-medium">{t("pages.examiner.preflight.status")}: {preflight.status}</div>
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
            </>
          )}

          {report && report.report && (
            <>
              <SectionTitle>{t("pages.examiner.report.title")}</SectionTitle>
              <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-report">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{report.report.status}</span>
                  {report.report.examiner && (
                    <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{report.report.examiner.experimentMode}</span>
                  )}
                </div>
                {report.report.examiner ? (
                  <div className="grid gap-3">
                    <div className="text-xs text-muted-foreground">
                      {t("pages.examiner.report.target")}: <span className="font-mono">{report.report.examiner.targetPrincipleId}</span> · {t("pages.examiner.report.endpoint")}: <span className="font-mono">{report.report.examiner.primaryEndpoint?.id}</span>
                    </div>
                    <div className="rounded-md border p-3" data-testid="examiner-report-itt">
                      <div className="font-medium">ITT</div>
                      {report.report.examiner.itt.pointEstimate.status === "ESTIMABLE" ? (
                        <div className="text-2xl font-bold">{report.report.examiner.itt.pointEstimate.value}</div>
                      ) : (
                        <div className="font-mono text-sm">
                          [{report.report.examiner.itt.lowerBound.value ?? "n/a"}, {report.report.examiner.itt.upperBound.value ?? "n/a"}]
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {t("pages.examiner.report.ittNote", {
                          planned: report.report.examiner.itt.plannedApplicablePairs,
                          determined: report.report.examiner.itt.determinedPairs,
                          unknown: report.report.examiner.itt.unknownPairs,
                          na: report.report.examiner.applicability.notApplicablePairs,
                        })}
                      </div>
                    </div>
                    <div className="rounded-md border p-3" data-testid="examiner-report-fidelity">
                      <div className="font-medium">{t("pages.examiner.report.fidelity")}</div>
                      <div className="text-xs">
                        CONTEXT_PRESENT+ {report.report.examiner.treatmentFidelity.contextPresent}/{report.report.examiner.treatmentFidelity.plannedTreatmentUnits} · RUNTIME_LOADED {report.report.examiner.treatmentFidelity.runtimeLoaded} · {t("pages.examiner.report.contamination")} {report.report.examiner.treatmentFidelity.controlContamination.units} · {t("pages.examiner.report.evictions")} {report.report.examiner.treatmentFidelity.capacityEvictions.units}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("pages.examiner.report.noExaminerBlock")}</p>
                )}
                <p className="text-xs text-muted-foreground">{t("pages.examiner.report.offlineNote")}</p>
              </div>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}
