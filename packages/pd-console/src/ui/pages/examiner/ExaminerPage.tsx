import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageShell } from '../../components/layout/page-shell.js';
import { PageLoading } from '../../components/layout/page-loading.js';
import { SectionTitle } from '../../components/layout/section-title.js';
import { Button } from '../../components/ui/button.js';
import { truncateByCodePoints } from '../../utils/reading-layout.js';
import { enumLabel } from '../../utils/enum-labels.js';
import { deriveStudyListVerdict, type StudyListVerdictCode } from '../../utils/examiner-conclusion.js';
import { FlaskConical, RefreshCw, Loader2, FileText, AlertTriangle, CircleCheck, CircleHelp, ChevronRight } from 'lucide-react';
import {
  fetchExaminerOverview,
  fetchExaminerPrinciples,
  fetchExaminerPrincipleEvidence,
  type ExaminerOverviewData,
  type ExaminerPrincipleItem,
  type ExaminerEvidenceData,
  type ExaminerStudySummary,
} from '../../api.js';
import { ExaminerEvidencePanel } from './examiner-evidence-panel.js';

/**
 * SPEC-PD-EXAMINER-001 §10 Page 1 — Principle Evaluation (2026-11 rework).
 *
 * The Owner opens this page with ONE question: "did my principles actually
 * change the AI's behavior?" The page answers it in layers:
 *
 *   ① answer card   — is this principle in effect, and is there a verified
 *                     effect conclusion yet, plus the next action button;
 *   ② principle list— principle TEXT as the primary key, verification tag;
 *   ③ study list    — human rows (date · principle · preliminary verdict);
 *   ④ technical fold— gates, the full evidence panel, spec id. Raw enums,
 *                     ids and English forensics live ONLY here.
 */

const GATE_ORDER = ['gate1_challenge_trust', 'gate2_behavior_evaluation', 'gate3_llm_authoring', 'gate4_product_integration'] as const;

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

  // Studies grouped per principle, newest first (createdAt-less rows last,
  // stable). Feeds the answer card and both list tags.
  const studiesByPrinciple = useMemo(() => {
    const map = new Map<string, ExaminerStudySummary[]>();
    if (overview === null) return map;
    const ordered = [...overview.studies].sort((a, b) => {
      if (a.createdAt !== null && b.createdAt !== null) return a.createdAt < b.createdAt ? 1 : -1;
      if (a.createdAt !== null) return -1;
      if (b.createdAt !== null) return 1;
      return 0;
    });
    for (const study of ordered) {
      if (study.targetPrincipleId === null) continue;
      const bucket = map.get(study.targetPrincipleId);
      if (bucket === undefined) map.set(study.targetPrincipleId, [study]);
      else bucket.push(study);
    }
    return map;
  }, [overview]);

  const latestStudyForSelected = selected === '' ? undefined : studiesByPrinciple.get(selected)?.[0];
  const selectedPrinciple = principles.find((p) => p.id === selected) ?? null;

  if (principlesStatus === 'loading' && overview === null && error === null) {
    return <PageLoading label={t('pages.examiner.loading')} />;
  }

  return (
    <PageShell>
      <header className="mb-4">
        <h1 className="text-title font-semibold text-ink" data-testid="examiner-page-title">
          {t('pages.examiner.title')}
        </h1>
        <p className="mt-1 text-[14px] text-ink-3">{t('pages.examiner.subtitle')}</p>
      </header>

      {/* One-line help instead of the old manual card (R1-4: header copy ≤2 lines). */}
      <details className="mb-4" data-testid="examiner-guide">
        <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground">
          <CircleHelp className="size-3.5" />
          {t('pages.examiner.guide.title')}
        </summary>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t('pages.examiner.guide.what')}</p>
      </details>

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
          {/* ① Answer card — the one question this page exists to answer. */}
          {selectedPrinciple !== null && (
            <section className="mb-5 rounded-lg border bg-card p-4" data-testid="examiner-answer">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-2xl">
                  <p className="text-reading font-medium text-ink" data-testid="examiner-answer-principle">
                    {truncateByCodePoints(selectedPrinciple.text, 80)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <span
                      className={`rounded px-2 py-0.5 ${
                        evidence !== null && evidence.activation.status === 'ok' && evidence.principle.runtimeDeactivated !== true
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      }`}
                      data-testid="examiner-answer-status"
                    >
                      {t('pages.examiner.answer.statusPrefix')}
                      {evidenceLoading && evidence === null
                        ? t('pages.examiner.answer.loading')
                        : evidence === null
                          ? t('pages.examiner.answer.partial')
                          : evidence.activation.status === 'ok'
                            ? evidence.principle.runtimeDeactivated === true
                              ? t('pages.examiner.answer.runtimeDeactivated')
                              : t('pages.examiner.answer.effective')
                            : t('pages.examiner.answer.partial')}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 ${
                        latestStudyForSelected === undefined
                          ? 'bg-muted text-ink-3'
                          : 'bg-sky-500/15 text-sky-700 dark:text-sky-400'
                      }`}
                      data-testid="examiner-answer-verdict"
                    >
                      {t('pages.examiner.answer.verdictPrefix')}
                      {latestStudyForSelected === undefined
                        ? t('pages.examiner.answer.verdictUnverified')
                        : t(`pages.examiner.studies.verdict.${deriveStudyListVerdict(latestStudyForSelected)}`)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground" data-testid="examiner-answer-reason">
                    {latestStudyForSelected === undefined
                      ? t('pages.examiner.answer.reasonUnverified')
                      : t(`pages.examiner.answer.reasonVerdict.${deriveStudyListVerdict(latestStudyForSelected)}`)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button asChild size="sm" data-testid="examiner-configure-cta">
                    <Link to={`/examiner/configure?principle=${encodeURIComponent(selected)}`}>
                      <FlaskConical className="size-4" />
                      {t('pages.examiner.evaluation.configureCta')}
                    </Link>
                  </Button>
                  {latestStudyForSelected !== undefined && (
                    <Button asChild variant="outline" size="sm" data-testid="examiner-answer-view-study">
                      <Link to={`/examiner/studies/${encodeURIComponent(latestStudyForSelected.studyId)}`}>
                        <FileText className="size-4" />
                        {t('pages.examiner.answer.ctaViewStudy')}
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ② principle selector + ③ study list */}
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="min-w-0">
              <SectionTitle>{t('pages.examiner.evaluation.title')}</SectionTitle>
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
                {principles.map((p) => {
                  const verdict = deriveStudyListVerdict(studiesByPrinciple.get(p.id)?.[0] ?? { reportStatus: null, hasExaminerResult: false, pointEstimate: null });
                  const verified = verdict !== 'noReport';
                  return (
                    <button
                      key={p.id}
                      className={`min-w-0 rounded-md border px-3 py-2 text-left text-xs ${selected === p.id ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent'}`}
                      onClick={() => void handleSelect(p.id)}
                      data-testid={`examiner-principle-${p.id}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {verified ? (
                          <CircleCheck className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                        ) : (
                          <CircleHelp className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{truncateByCodePoints(p.text, 48)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-muted-foreground">
                        {verified
                          ? t(`pages.examiner.studies.verdict.${verdict}`)
                          : t('pages.examiner.answer.verdictUnverified')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0">
              <SectionTitle>{t('pages.examiner.studies.title')}</SectionTitle>
              <div className="grid gap-2" data-testid="examiner-study-list">
                {overview.studies.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('pages.examiner.studies.empty')}</p>
                )}
                {overview.studies.map((study) => {
                  const verdict: StudyListVerdictCode = deriveStudyListVerdict(study);
                  const principleText = study.targetPrincipleId === selected && selectedPrinciple !== null
                    ? selectedPrinciple.text
                    : principles.find((p) => p.id === study.targetPrincipleId)?.text ?? null;
                  return (
                    <Link
                      key={study.studyId}
                      to={`/examiner/studies/${encodeURIComponent(study.studyId)}`}
                      className="flex min-w-0 items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs hover:bg-accent"
                      data-testid={`examiner-study-${study.studyId}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink">
                          {principleText !== null
                            ? truncateByCodePoints(principleText, 40)
                            : study.targetPrincipleId ?? study.studyId}
                        </span>
                        <span className="mt-0.5 block truncate text-muted-foreground">
                          {study.createdAt !== null
                            ? new Date(study.createdAt).toLocaleDateString()
                            : t('pages.examiner.studies.dateUnknown')}
                          {study.readOnly ? ` · ${t('pages.examiner.studies.readOnly')}` : ''}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        <span
                          className={`rounded px-2 py-0.5 ${verdict === 'positive' || verdict === 'negative' || verdict === 'noDifference' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400' : 'bg-muted text-ink-3'}`}
                        >
                          {t(`pages.examiner.studies.verdict.${verdict}`)}
                        </span>
                        <ChevronRight className="size-3.5" />
                      </span>
                    </Link>
                  );
                })}
                {overview.studies.length > 0 && (
                  <p className="text-caption text-muted-foreground">{t('pages.examiner.studies.preliminaryNote')}</p>
                )}
              </div>
            </div>
          </div>

          {/* ④ Technical fold — gates + the full evidence panel + spec.
              Raw enums/ids/English live ONLY inside this collapsed section. */}
          <details className="mt-5" data-testid="examiner-technical" data-technical>
            <summary className="cursor-pointer select-none text-sm text-ink-3">
              {t('pages.examiner.technical.title')}
            </summary>
            <div className="mt-3 grid gap-4">
              <div className="rounded-lg border bg-card p-4 text-sm">
                <div className="font-medium">{t('pages.examiner.scope.title')}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`pages.examiner.scope.mode.${overview.executionScopeCode}`, {
                    defaultValue: t('pages.examiner.scope.mode.offline_stub_only'),
                  })}
                </p>
                <div className="mt-3 grid gap-1 text-xs text-muted-foreground">
                  {GATE_ORDER.map((gateId) => {
                    const gate = overview.gates.find((g) => g.id === gateId);
                    if (gate === undefined) return null;
                    return (
                      <div key={gate.id} data-testid={`examiner-gate-${gate.id}`} data-state={gate.state}>
                        <span className="font-medium text-ink-3">{t(`pages.examiner.gates.${gate.id}.label`)}</span>
                        {'：'}
                        <span className={gate.state === 'ACTIVE' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                          {enumLabel('gateState', gate.state, t)}
                        </span>
                        <span className="mt-0.5 block pl-4 text-muted-foreground">{t(`pages.examiner.gates.${gate.id}.desc`)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {(evidenceLoading || evidence !== null) && (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t('pages.examiner.technical.evidenceTitle')}</span>
                    <span className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={busy === 'refresh'} data-testid="examiner-evidence-refresh">
                        {busy === 'refresh' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                        {t('pages.examiner.evaluation.refresh')}
                      </Button>
                      {selected !== '' && (
                        <Button asChild size="sm" data-testid="examiner-evidence-governance">
                          <Link to={`/principles/${encodeURIComponent(selected)}`}>{t('pages.examiner.evaluation.openGovernance')}</Link>
                        </Button>
                      )}
                    </span>
                  </div>
                  {evidenceLoading && (
                    <div className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground" data-testid="examiner-evidence-loading">
                      <Loader2 className="size-4 animate-spin" />
                      {t('pages.examiner.evaluation.loadingEvidenceFor', { principleId: selected })}
                    </div>
                  )}
                  {!evidenceLoading && evidence !== null && <ExaminerEvidencePanel evidence={evidence} />}
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
              <p className="font-mono text-caption text-muted-foreground" data-testid="examiner-spec">{overview.spec}</p>
            </div>
          </details>
        </>
      )}
    </PageShell>
  );
}
