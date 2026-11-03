import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { Button } from '../../components/ui/button.js';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { FlaskConical, Loader2, ArrowLeft, ArrowRight, Info } from 'lucide-react';
import {
  fetchExaminerPrinciples,
  fetchExaminerSuites,
  fetchExaminerHostReadiness,
  createExaminerStudy,
  type ExaminerPrincipleItem,
  type ExaminerSuiteItem,
  type ExaminerHostReadiness,
} from '../../api.js';

/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §10 Page 2 — Study Configuration.
 *
 * Answers "WHAT exactly will this evaluation compare?" — target principle,
 * experiment mode (full-library incremental default / isolated diagnostic),
 * the challenge suite (from the fixed catalog, with its Gold gate status),
 * the host execution requirements, and the honest configuration-difference
 * note the creation freezes into the study (production vs experiment budget).
 */
export function ExaminerConfigurePage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillPrinciple = searchParams.get('principle');
  const [principles, setPrinciples] = useState<ExaminerPrincipleItem[] | null>(null);
  const [suites, setSuites] = useState<ExaminerSuiteItem[]>([]);
  const [readiness, setReadiness] = useState<ExaminerHostReadiness | null>(null);
  const [targetPrincipleId, setTargetPrincipleId] = useState('');
  const [experimentMode, setExperimentMode] = useState<'full_library_incremental' | 'isolated_principle'>('full_library_incremental');
  const [suiteKey, setSuiteKey] = useState('didactic-pair');
  const [repetitions, setRepetitions] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [principlesResponse, suitesResponse, readinessResponse] = await Promise.all([
        fetchExaminerPrinciples(),
        fetchExaminerSuites(),
        fetchExaminerHostReadiness(),
      ]);
      if (cancelled) return;
      if (!principlesResponse.success) {
        setError(principlesResponse.error ?? t('pages.examiner.errors.unavailable'));
        return;
      }
      const active = principlesResponse.data.principles.filter((p) => p.status === 'active');
      setPrinciples(active);
      if (prefillPrinciple !== null && active.some((p) => p.id === prefillPrinciple)) setTargetPrincipleId(prefillPrinciple);
      else if (active[0] !== undefined) setTargetPrincipleId(active[0].id);
      if (suitesResponse.success) setSuites(suitesResponse.data.suites);
      if (readinessResponse.success) setReadiness(readinessResponse.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [t, prefillPrinciple]);

  const selectedSuite = useMemo(() => suites.find((suite) => suite.key === suiteKey) ?? null, [suites, suiteKey]);
  const target = useMemo(() => principles?.find((p) => p.id === targetPrincipleId) ?? null, [principles, targetPrincipleId]);

  const handleCreate = async (): Promise<void> => {
    if (targetPrincipleId === '') return;
    setBusy(true);
    const response = await createExaminerStudy({ targetPrincipleId, experimentMode, repetitionsPerCase: repetitions, suiteKey });
    setBusy(false);
    if (!response.success) {
      toast.error(response.error ?? t('pages.examiner.errors.create'));
      return;
    }
    toast.success(t('pages.examiner.created', { studyId: response.data.studyId }));
    void navigate(`/examiner/studies/${encodeURIComponent(response.data.studyId)}`);
  };

  if (principles === null && !error) return <PageLoading label={t('pages.examiner.loading')} />;

  return (
    <PageShell>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/examiner" className="inline-flex items-center gap-1 hover:text-ink">
            <ArrowLeft className="size-3.5" />
            {t('pages.examiner.configure.back')}
          </Link>
        </div>
        <h1 className="mt-1 text-[22px] font-semibold text-ink" data-testid="examiner-configure-title">
          {t('pages.examiner.configure.title')}
        </h1>
        <p className="mt-1 text-[14px] text-ink-3">{t('pages.examiner.configure.subtitle')}</p>
      </header>
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-error">{error}</div>
      )}
      {principles !== null && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Target + mode */}
          <div className="grid content-start gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-configure-target">
            <label className="block">
              <span className="mb-1 block font-medium">{t('pages.examiner.create.target')}</span>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={targetPrincipleId}
                onChange={(e) => setTargetPrincipleId(e.target.value)}
                data-testid="examiner-target-select"
              >
                {principles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} — {truncateByCodePoints(p.text, 52)}
                  </option>
                ))}
              </select>
            </label>
            {target && (
              <p className="rounded-md border p-2 text-xs text-muted-foreground" data-testid="examiner-configure-target-text">
                {truncateByCodePoints(target.text, 200)}
              </p>
            )}
            <label className="block">
              <span className="mb-1 block font-medium">{t('pages.examiner.create.mode')}</span>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={experimentMode}
                onChange={(e) => setExperimentMode(e.target.value as typeof experimentMode)}
                data-testid="examiner-mode-select"
              >
                <option value="full_library_incremental">{t('pages.examiner.mode.full')}</option>
                <option value="isolated_principle">{t('pages.examiner.mode.isolated')}</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {experimentMode === 'full_library_incremental' ? t('pages.examiner.configure.fullNote') : t('pages.examiner.configure.isolatedNote')}
            </p>
            <label className="block">
              <span className="mb-1 block font-medium">{t('pages.examiner.create.repetitions')}</span>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={repetitions}
                onChange={(e) => setRepetitions(Number(e.target.value))}
                data-testid="examiner-repetitions-select"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Suite selection */}
          <div className="grid content-start gap-3 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-configure-suite">
            <div className="font-medium">{t('pages.examiner.configure.suite.title')}</div>
            {suites.map((suite) => (
              <button
                key={suite.key}
                className={`rounded-md border p-3 text-left text-xs ${suiteKey === suite.key ? 'border-primary bg-primary/10' : 'bg-background hover:bg-accent'}`}
                onClick={() => setSuiteKey(suite.key)}
                data-testid={`examiner-suite-${suite.key}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{suite.title}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{suite.caseCount} cases</span>
                </div>
                <div className="mt-1 text-muted-foreground">{suite.description}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {suite.variantLabels.map((label) => (
                    <span key={label} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{label}</span>
                  ))}
                </div>
              </button>
            ))}
            {selectedSuite && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400" data-testid="examiner-suite-gold-gate">
                <Info className="mr-1 inline size-3.5" />
                {selectedSuite.goldGate}
              </p>
            )}
          </div>

          {/* Host execution requirements */}
          {readiness && (
            <div className="grid content-start gap-2 rounded-lg border bg-card p-4 text-sm lg:col-span-2" data-testid="examiner-configure-readiness">
              <div className="font-medium">{t('pages.examiner.configure.readiness.title')} — {readiness.host}</div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                {readiness.requirements.map((requirement) => (
                  <div key={requirement.id} data-testid={`examiner-readiness-${requirement.id}`}>
                    <span className="font-mono">{requirement.id}</span>: {requirement.detail}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{readiness.note}</p>
            </div>
          )}

          {/* Honest configuration difference */}
          <div className="grid content-start gap-1 rounded-lg border bg-card p-4 text-xs text-muted-foreground lg:col-span-2" data-testid="examiner-configure-difference">
            <div className="text-sm font-medium text-ink">{t('pages.examiner.configure.difference.title')}</div>
            <p>{t('pages.examiner.configure.difference.note')}</p>
          </div>

          <div className="flex items-center justify-between gap-2 lg:col-span-2">
            <span className="text-xs text-muted-foreground" data-testid="examiner-configure-summary">
              {t('pages.examiner.configure.summary', {
                target: targetPrincipleId || '—',
                suite: selectedSuite ? `${selectedSuite.title} (${selectedSuite.caseCount})` : suiteKey,
                pairs: (selectedSuite?.caseCount ?? 2) * repetitions,
              })}
            </span>
            <Button onClick={() => void handleCreate()} disabled={targetPrincipleId === '' || busy} data-testid="examiner-create-button">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              {t('pages.examiner.create.submit')}
              <ArrowRight className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground lg:col-span-2">{t('pages.examiner.create.note')}</p>
        </div>
      )}
    </PageShell>
  );
}
