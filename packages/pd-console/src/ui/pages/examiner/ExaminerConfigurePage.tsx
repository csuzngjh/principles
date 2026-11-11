import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { Button } from '../../components/ui/button.js';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { FlaskConical, Loader2, ArrowLeft, ArrowRight, Info, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  fetchExaminerPrinciples,
  fetchExaminerSuites,
  fetchExaminerHostReadiness,
  fetchExaminerEligibility,
  createExaminerStudy,
  type ExaminerPrincipleItem,
  type ExaminerSuiteItem,
  type ExaminerHostReadiness,
  type ExaminerEligibilityData,
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
  const [principlesError, setPrinciplesError] = useState<string | null>(null);
  const [suites, setSuites] = useState<ExaminerSuiteItem[]>([]);
  const [readiness, setReadiness] = useState<ExaminerHostReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [targetPrincipleId, setTargetPrincipleId] = useState('');
  const [experimentMode, setExperimentMode] = useState<'full_library_incremental' | 'isolated_principle'>('full_library_incremental');
  const [suiteKey, setSuiteKey] = useState('didactic-pair');
  const [repetitions, setRepetitions] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suiteError, setSuiteError] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<ExaminerEligibilityData | null>(null);
  const [eligibilityStatus, setEligibilityStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [eligibilityToken, setEligibilityToken] = useState(0);
  const eligibilitySeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPrinciplesError(null);
      setReadinessError(null);
      const [principlesResponse, suitesResponse, readinessResponse] = await Promise.all([
        fetchExaminerPrinciples(),
        fetchExaminerSuites(),
        fetchExaminerHostReadiness(),
      ]);
      if (cancelled) return;
      if (!principlesResponse.success) {
        // A failed request is NOT an empty catalog (Phase B3): keep the reason
        // and offer a retry instead of a silent dead end.
        setPrinciples(null);
        setPrinciplesError(principlesResponse.error ?? t('pages.examiner.errors.principles'));
        return;
      }
      const active = principlesResponse.data.principles.filter((p) => p.status === 'active');
      setPrinciples(active);
      setTargetPrincipleId((current) => {
        if (prefillPrinciple !== null && active.some((p) => p.id === prefillPrinciple)) return prefillPrinciple;
        if (current !== '' && active.some((p) => p.id === current)) return current;
        return active[0]?.id ?? '';
      });
      if (suitesResponse.success) {
        setSuites(suitesResponse.data.suites);
        setSuiteError(null);
      } else {
        setSuites([]);
        setSuiteError(suitesResponse.error ?? t('pages.examiner.errors.unavailable'));
      }
      if (readinessResponse.success) {
        setReadiness(readinessResponse.data);
        setReadinessError(null);
      } else {
        setReadiness(null);
        setReadinessError(readinessResponse.error ?? t('pages.examiner.errors.unavailable'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, prefillPrinciple, reloadToken]);

  // Phase C3: the eligibility verdict is re-derived server-side whenever a
  // selection that feeds it changes. It is advisory UI state — the server
  // re-runs the SAME pre-check at creation time.
  useEffect(() => {
    if (targetPrincipleId === '') {
      setEligibility(null);
      setEligibilityStatus('idle');
      setEligibilityError(null);
      return;
    }
    let cancelled = false;
    const seq = eligibilitySeq.current + 1;
    eligibilitySeq.current = seq;
    setEligibilityStatus('loading');
    setEligibility(null);
    setEligibilityError(null);
    (async () => {
      const response = await fetchExaminerEligibility(targetPrincipleId, { mode: experimentMode, suiteKey });
      if (cancelled || eligibilitySeq.current !== seq) return;
      if (!response.success) {
        setEligibilityStatus('error');
        setEligibilityError(response.error ?? t('pages.examiner.eligibility.error'));
        return;
      }
      setEligibility(response.data);
      setEligibilityStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [t, targetPrincipleId, experimentMode, suiteKey, eligibilityToken]);

  const selectedSuite = useMemo(() => suites.find((suite) => suite.key === suiteKey) ?? null, [suites, suiteKey]);
  const target = useMemo(() => principles?.find((p) => p.id === targetPrincipleId) ?? null, [principles, targetPrincipleId]);
  const eligibilityBlocked = eligibilityStatus === 'ready' && eligibility?.status === 'BLOCKED';
  // Host readiness is a DIFFERENT concern and must never gate an offline study
  // (Phase B3). Only the study-eligibility verdict can refuse creation.
  const eligibilityUnresolved = eligibilityStatus !== 'ready';

  const handleCreate = async (): Promise<void> => {
    if (targetPrincipleId === '' || eligibilityUnresolved || eligibilityBlocked) return;
    setBusy(true);
    setError(null);
    const response = await createExaminerStudy({ targetPrincipleId, experimentMode, repetitionsPerCase: repetitions, suiteKey });
    setBusy(false);
    if (!response.success) {
      // In-page, actionable failure (Phase B3): the server's refusal reason is
      // preserved instead of being reduced to a toast.
      setError(response.error ?? t('pages.examiner.errors.create'));
      setEligibilityToken((token) => token + 1);
      return;
    }
    toast.success(t('pages.examiner.created', { studyId: response.data.studyId }));
    void navigate(`/examiner/studies/${encodeURIComponent(response.data.studyId)}`);
  };

  if (principles === null && principlesError === null) return <PageLoading label={t('pages.examiner.loading')} />;

  const eligibilitySummary = eligibility === null
    ? null
    : eligibility.status === 'ELIGIBLE'
      ? t('pages.examiner.eligibility.summaryEligible')
      : eligibility.status === 'DEGRADED'
        ? t('pages.examiner.eligibility.summaryDegraded')
        : t('pages.examiner.eligibility.summaryBlocked', {
          reason: t(`pages.examiner.eligibility.reason.${eligibility.blockingReasonCode ?? 'unknown'}`, {
            defaultValue: eligibility.blockingReasonCode ?? t('pages.examiner.eligibility.reason.unknown'),
          }),
        });

  return (
    <PageShell>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/examiner" className="inline-flex items-center gap-1 hover:text-ink">
            <ArrowLeft className="size-3.5" />
            {t('pages.examiner.configure.back')}
          </Link>
        </div>
        <h1 className="mt-1 text-title font-semibold text-ink" data-testid="examiner-configure-title">
          {t('pages.examiner.configure.title')}
        </h1>
        <p className="mt-1 text-[14px] text-ink-3">{t('pages.examiner.configure.subtitle')}</p>
      </header>
      {principlesError !== null && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-principles-error">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {t('pages.examiner.errors.principles')}
              <span className="mt-1 block font-mono text-caption opacity-80">{principlesError}</span>
            </span>
          </span>
          <Button variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)} data-testid="examiner-principles-retry">
            <RefreshCw className="size-4" />
            {t('pages.examiner.errors.retry')}
          </Button>
        </div>
      )}
      {principles !== null && principles.length === 0 && principlesError === null && (
        <div className="mb-4 rounded-lg border bg-card p-4 text-sm" data-testid="examiner-no-active-principles">
          <p className="font-medium">{t('pages.examiner.evaluation.noActive')}</p>
          <p className="mt-1 text-muted-foreground">{t('pages.examiner.evaluation.noActiveHint')}</p>
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" data-testid="examiner-error">{error}</div>
      )}
      {principles !== null && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Target + mode */}
          <div className="grid min-w-0 grid-cols-1 content-start gap-3 rounded-lg border bg-card p-4 text-sm break-words" data-testid="examiner-configure-target">
            <label className="block min-w-0">
              <span className="mb-1 block font-medium">{t('pages.examiner.create.target')}</span>
              <select
                className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 text-sm"
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
            <label className="block min-w-0">
              <span className="mb-1 block font-medium">{t('pages.examiner.create.mode')}</span>
              <select
                className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 text-sm"
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
            <label className="block min-w-0">
              <span className="mb-1 block font-medium">{t('pages.examiner.create.repetitions')}</span>
              <select
                className="w-full min-w-0 max-w-full rounded-md border bg-background px-3 py-2 text-sm"
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
          <div className="grid min-w-0 grid-cols-1 content-start gap-3 rounded-lg border bg-card p-4 text-sm break-words" data-testid="examiner-configure-suite">
            <div className="font-medium">{t('pages.examiner.configure.suite.title')}</div>
            {suiteError !== null && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-caption text-destructive" data-testid="examiner-suite-error">
                {suiteError}
              </p>
            )}
            {suites.map((suite) => (
              <button
                key={suite.key}
                className={`rounded-md border p-3 text-left text-xs ${suiteKey === suite.key ? 'border-primary bg-primary/10' : 'bg-background hover:bg-accent'}`}
                onClick={() => setSuiteKey(suite.key)}
                data-testid={`examiner-suite-${suite.key}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{suite.title}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption">{suite.caseCount} cases</span>
                </div>
                <div className="mt-1 text-muted-foreground">{suite.description}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {suite.variantLabels.map((label) => (
                    <span key={label} className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption">{label}</span>
                  ))}
                </div>
              </button>
            ))}
            {selectedSuite && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-caption text-amber-700 dark:text-amber-400" data-testid="examiner-suite-gold-gate">
                <Info className="mr-1 inline size-3.5" />
                {selectedSuite.goldGate}
              </p>
            )}
          </div>

          {/* Phase C3: eligibility verdict — the reason a study cannot be created
              is shown here, with what to do next, instead of only at submit. */}
          <div
            className="grid min-w-0 grid-cols-1 content-start gap-2 rounded-lg border bg-card p-4 text-sm break-words lg:col-span-2"
            data-testid="examiner-eligibility-panel"
            data-eligibility-status={eligibilityStatus === 'ready' ? eligibility?.status ?? 'UNKNOWN' : eligibilityStatus}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 font-medium">{t('pages.examiner.eligibility.title')}</div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                {eligibilityStatus === 'loading' && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground" data-testid="examiner-eligibility-loading">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('pages.examiner.eligibility.checking')}
                  </span>
                )}
                {eligibilityStatus === 'ready' && eligibility && (
                  <span
                    className={`inline-block max-w-full rounded border px-1.5 py-0.5 text-left ${eligibility.status === 'ELIGIBLE'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : eligibility.status === 'DEGRADED'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-destructive/40 bg-destructive/10 text-destructive'}`}
                    data-testid="examiner-eligibility-status"
                  >
                    {eligibility.status === 'ELIGIBLE'
                      ? <CheckCircle2 className="mr-1 inline size-3.5 align-text-bottom" />
                      : <AlertTriangle className="mr-1 inline size-3.5 align-text-bottom" />}
                    {t(`pages.examiner.eligibility.status.${eligibility.status}`)}
                  </span>
                )}
                {eligibilityStatus === 'error' && (
                  <Button variant="outline" size="sm" onClick={() => setEligibilityToken((token) => token + 1)} data-testid="examiner-eligibility-retry">
                    <RefreshCw className="size-3.5" />
                    {t('pages.examiner.errors.retry')}
                  </Button>
                )}
              </div>
            </div>
            {eligibilityStatus === 'error' && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-testid="examiner-eligibility-error">
                {t('pages.examiner.eligibility.error')}
                <span className="mt-1 block font-mono text-caption opacity-80">{eligibilityError}</span>
              </p>
            )}
            {eligibilityStatus === 'ready' && eligibility && (
              <>
                <p className="text-xs" data-testid="examiner-eligibility-summary">{eligibilitySummary}</p>
                {eligibility.checks.filter((check) => check.status !== 'PASS').length > 0 && (
                  <ul className="grid gap-1.5 text-xs" data-testid="examiner-eligibility-checks">
                    {eligibility.checks.filter((check) => check.status !== 'PASS').map((check, index) => (
                      <li
                        key={`${check.id}-${check.reasonCode}-${index}`}
                        data-testid={`examiner-eligibility-check-${check.id}`}
                        className={`rounded border p-2 ${check.status === 'BLOCKED' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'}`}
                      >
                        <div className="font-medium">
                          {t(`pages.examiner.eligibility.check.${check.id}`, { defaultValue: check.id })}
                        </div>
                        <div className="mt-0.5 text-muted-foreground">
                          {t(`pages.examiner.eligibility.reason.${check.reasonCode}`, { defaultValue: check.reasonCode })}
                        </div>
                        {check.detail !== null && (
                          <div className="mt-1 font-mono text-caption text-muted-foreground" title={check.detail}>
                            {truncateByCodePoints(check.detail, 240)}
                          </div>
                        )}
                        {check.nextAction !== null && (
                          <div className="mt-1">
                            <span className="font-medium">{t('pages.examiner.eligibility.nextStep')}</span>
                            {' — '}
                            {check.nextAction}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {/* Host execution requirements — ALWAYS visible (Phase D2): an
              unavailable projection is a stated limitation, never a hidden
              section, and Host Dry-run stays reachable from the study page. */}
          <div className="grid min-w-0 grid-cols-1 content-start gap-2 rounded-lg border bg-card p-4 text-sm break-words lg:col-span-2" data-testid="examiner-configure-readiness">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">
                {t('pages.examiner.configure.readiness.title')}
                {readiness !== null ? ` — ${readiness.host}` : ''}
              </div>
              {readinessError !== null && (
                <Button variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)} data-testid="examiner-readiness-retry">
                  <RefreshCw className="size-3.5" />
                  {t('pages.examiner.errors.retry')}
                </Button>
              )}
            </div>
            {readinessError !== null ? (
              <p className="text-xs text-destructive" data-testid="examiner-readiness-error">
                {t('pages.examiner.configure.readiness.unavailable')}
                <span className="mt-1 block font-mono text-caption opacity-80">{readinessError}</span>
              </p>
            ) : readiness === null ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('pages.examiner.configure.readiness.loading')}
              </p>
            ) : (
              <div className="grid gap-1 text-xs text-muted-foreground">
                {readiness.requirements.map((requirement) => (
                  <div key={requirement.id} data-testid={`examiner-readiness-${requirement.id}`}>
                    <span className="font-mono">{requirement.id}</span>: {requirement.detail}
                  </div>
                ))}
                <p className="text-caption">{readiness.note}</p>
              </div>
            )}
            <p className="text-caption text-muted-foreground" data-testid="examiner-f2-unavailable-note">
              {t('pages.examiner.configure.readiness.f2Note')}
            </p>
          </div>

          {/* Honest configuration difference */}
          <div className="grid min-w-0 grid-cols-1 content-start gap-1 rounded-lg border bg-card p-4 text-xs text-muted-foreground break-words lg:col-span-2" data-testid="examiner-configure-difference">
            <div className="text-sm font-medium text-ink">{t('pages.examiner.configure.difference.title')}</div>
            <p>{t('pages.examiner.configure.difference.note')}</p>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 lg:col-span-2">
            <span className="min-w-0 text-xs text-muted-foreground" data-testid="examiner-configure-summary">
              {t('pages.examiner.configure.summary', {
                target: targetPrincipleId || '—',
                suite: selectedSuite ? `${selectedSuite.title} (${selectedSuite.caseCount})` : suiteKey,
                pairs: (selectedSuite?.caseCount ?? 2) * repetitions,
              })}
            </span>
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={() => void handleCreate()}
                disabled={targetPrincipleId === '' || busy || suiteError !== null || eligibilityUnresolved || eligibilityBlocked}
                data-testid="examiner-create-button"
                title={eligibilityBlocked
                  ? t('pages.examiner.eligibility.createBlocked')
                  : eligibilityUnresolved ? t('pages.examiner.eligibility.checking') : undefined}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
                {t('pages.examiner.create.submit')}
                <ArrowRight className="size-4" />
              </Button>
              {eligibilityBlocked && (
                <span className="text-caption text-destructive" data-testid="examiner-create-blocked-hint">
                  {t('pages.examiner.eligibility.createBlocked')}
                </span>
              )}
            </div>
          </div>
          <p className="min-w-0 break-words text-xs text-muted-foreground lg:col-span-2">{t('pages.examiner.create.note')}</p>
        </div>
      )}
    </PageShell>
  );
}
