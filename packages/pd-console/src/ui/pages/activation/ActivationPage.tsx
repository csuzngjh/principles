import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { ShinyText } from "../../components/ui/shiny-text.js";
import { Button } from "../../components/ui/button.js";
import {
  fetchAllActivations,
  disableActivation,
  fetchLifecycleMetrics,
  fetchReceiptCounts,
  fetchRuleCodeOwnerReview,
  ruleCodeDecision,
  pauseAllRuleCode,
  releaseRuleCodePause,
} from "../../api.js";
import type {
  ActivationRecord,
  ActivationsData,
  LifecycleMetricsData,
  ReceiptCountEntryData,
  ReceiptEvidenceCoverageData,
  RuleCodeOwnerReviewData,
} from "../../api.js";
import { ReceiptCoverageDisclosure, getReceiptSourceStatusLabelKey } from "../../components/receipts/ReceiptCoverageDisclosure.js";
import {
  validateActivationsData,
  validateLifecycleMetricsData,
  isReversibleChannel,
} from "./ActivationValidators.js";
import { enumLabel } from "../../utils/enum-labels.js";
import { formatDate } from "../../utils/format-date.js";

// Date+time rendering options — mirrors the old default toLocaleString() shape
// (numeric date, hours/minutes/seconds) while following the UI language.
const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

// ── Channel label helper ─────────────────────────────────────────────────────

function getChannelLabel(channel: string, t: (key: string) => string): string {
  return enumLabel('channel', channel, t);
}

// ── Sub-components ───────────────────────────────────────────────────────────

function CapabilityBoundaryDeclaration() {
  const { t } = useTranslation();
  return (
    <div
      className="px-[18px] py-[14px] bg-panel border border-line rounded-[6px] text-ink-3 text-[13px] leading-relaxed"
      role="note"
      aria-label={t("pages.activation.boundaryLabel")}
    >
      {t("pages.activation.boundaryText")}
    </div>
  );
}

function RuleCodeOwnerPanel({ record, onChanged }: { record: ActivationRecord; onChanged: () => void }) {
  const { t } = useTranslation();
  const [review, setReview] = useState<RuleCodeOwnerReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('rare_behavior');
  const load = useCallback(async () => { const result = await fetchRuleCodeOwnerReview(record.activationId); if (result.success) { setReview(result.data); setError(null); } else setError(result.error); }, [record.activationId]);
  useEffect(() => { void load(); }, [load]);
  const decide = async (action: 'continue-observing' | 'reject-after-shadow' | 'emergency-deactivate' | 'promote' | 'recover-to-shadow') => {
    if (!review) return; setBusy(true);
    const reasonCode = action === 'promote' && review.readiness.status === 'evidence_insufficient'
      ? overrideReason
      : action;
    const body: Record<string, unknown> = { idempotencyKey: `${action}-${crypto.randomUUID()}`, reasonCode, note };
    if (action === 'promote') Object.assign(body, { confirmed: true, artifactId: review.artifact.artifactId, artifactDigest: review.artifact.digest, controlVersion: review.controlState?.version });
    if (action === 'recover-to-shadow') Object.assign(body, { controlVersion: review.controlState?.version });
    const result = await ruleCodeDecision(record.activationId, action, body); setBusy(false);
    if (result.success) { toast.success(t('pages.activation.ownerDecisionRecorded')); onChanged(); await load(); } else { setError(result.error); if (result.nextAction) toast.info(result.nextAction); }
  };
  const releasePause = async () => { if (!review?.globalPause) return; setBusy(true); const result = await releaseRuleCodePause(review.globalPause.pauseId, { idempotencyKey: `release-${crypto.randomUUID()}`, reasonCode: 'owner_releases_global_latch', expectedVersion: review.globalPause.version, note }); setBusy(false); if (result.success) { toast.success(t('pages.activation.globalPauseReleased')); onChanged(); await load(); } else setError(result.error); };
  if (error) return <div className="mt-3 border-l-2 border-danger px-3 text-[12px] text-danger">{error}</div>;
  if (!review) return <div className="mt-3 text-[12px] text-ink-4">{t('pages.activation.ownerDecisionLoading')}</div>;
  const summary = review.readiness.evidenceSnapshot.shadowSummary;
  const value = (number: number | null) => number === null ? t('pages.activation.notCollected') : String(number);
  const affectedTools = Array.isArray(review.artifact.content?.affectedTools) ? review.artifact.content.affectedTools.filter((item): item is string => typeof item === 'string') : [];
  const renderWindow = (title: string, window: RuleCodeOwnerReviewData['liveMetrics']['last24Hours']) => <div className="rounded border border-line p-2"><div className="font-medium text-ink">{title}</div><div className="mt-1 grid grid-cols-2 gap-1 md:grid-cols-5"><span>{t('pages.activation.eligibleEvaluations')}: {value(window.eligible)}</span><span>{t('pages.activation.matched')}: {value(window.matched)}</span><span>{t('pages.activation.blocked')}: {value(window.blocked)}</span><span>{t('pages.activation.unhealthy')}: {value(window.unhealthy)}</span><span>{t('pages.activation.circuitTrips')}: {window.circuitTrips}</span></div><div className="mt-1 text-ink-4">{t('pages.activation.toolDistribution')}: {window.toolDistribution === null ? t('pages.activation.notCollected') : Object.entries(window.toolDistribution).map(([tool, count]) => `${tool} ${count}`).join(', ') || '—'}</div></div>;
  return <div className="mt-4 rounded-[5px] border border-gov/25 bg-surface/70 p-4" data-testid={`owner-review-${record.activationId}`}>
    <div className="flex flex-wrap items-center gap-2"><strong className="text-[13px] text-ink">{t('pages.activation.ownerDecisionTitle')}</strong><span className="font-mono text-[11px] text-gov">{review.readiness.status}</span>{review.controlState?.enforcement === 'safety_isolated' && <span className="text-danger text-[11px]">{t('pages.activation.safetyIsolation')}</span>}</div>
    <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-ink-3 md:grid-cols-4">
      <span>{t('pages.activation.eligibleEvaluations')}: {value(summary.observed)}</span>
      <span>{t('pages.activation.matched')}: {value(summary.matched)}</span>
      <span>{t('pages.activation.wouldBlock')}: {value(summary.wouldBlock)}</span>
      <span>{t('pages.activation.wouldAllow')}: {value(summary.wouldAllow)}</span>
      <span>{t('pages.activation.requireApproval')}: {value(summary.requireApproval)}</span>
      <span>{t('pages.activation.autoCorrect')}: {value(summary.autoCorrect)}</span>
      <span>{t('pages.activation.neutralControl')}: {value(summary.neutralControl)}</span>
      <span>{t('pages.activation.evaluationErrors')}: {value(summary.errors)}</span>
    </div>
    <div className="mt-2 text-[11px] text-ink-4">{t('pages.activation.shadowWindow', { first: summary.firstObservedAt ?? t('pages.activation.notCollected'), last: summary.lastObservedAt ?? t('pages.activation.notCollected') })}</div>
    <div className="mt-2 text-[12px] text-ink-3">{t('pages.activation.runtimeCapability', { version: review.runtimeCapability.hostRuntimeVersion, supported: t(review.runtimeCapability.shadowEvidence ? 'pages.activation.supported' : 'pages.activation.unsupported') })}</div>
    <div className="mt-2 text-[12px] text-amber">{t('pages.activation.worstImpact', { tools: affectedTools.join(', ') || t('pages.activation.notCollected') })}</div>
    <div className="mt-3 text-[12px] text-ink-3"><div className="mb-1 font-medium text-ink">{t('pages.activation.hardSafetyChecks')}</div>{review.readiness.evidenceSnapshot.safetyGateResults.map(check => <div key={check.checkId} className={check.status === 'passed' ? 'text-green' : 'text-danger'}>{t(`pages.activation.checks.${check.checkId}`, { defaultValue: check.checkId })}: {t(`pages.activation.checkStatus.${check.status}`, { defaultValue: check.status })}{check.reasonCode ? ` · ${t(`pages.activation.reasonCodes.${check.reasonCode}`, { defaultValue: check.reasonCode })}` : ''}</div>)}</div>
    {review.readiness.failedChecks.length > 0 && <ul className="mt-2 text-[12px] text-danger">{review.readiness.failedChecks.map(check => <li key={check.checkId}>{t(`pages.activation.checks.${check.checkId}`, { defaultValue: check.checkId })}: {t(`pages.activation.reasonCodes.${check.reasonCode}`, { defaultValue: check.reasonCode })}</li>)}</ul>}
    <details className="mt-2 text-[12px]"><summary className="cursor-pointer text-gov">{t('pages.activation.scopeArtifactCode')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-ink-3">{JSON.stringify(review.artifact.content, null, 2)}</pre></details>
    <div className="mt-3 grid gap-2 text-[11px] text-ink-3 md:grid-cols-2">{renderWindow(t('pages.activation.live24Hours'), review.liveMetrics.last24Hours)}{renderWindow(t('pages.activation.live7Days'), review.liveMetrics.last7Days)}</div>
    <div className="mt-2 text-[11px] text-ink-3">{t('pages.activation.behaviorDrift', { approved: value(review.behaviorDrift.approvedBlockRate), live: value(review.behaviorDrift.liveBlockRate), delta: value(review.behaviorDrift.delta) })}</div>
    {review.liveMetrics.representativeSamples.length > 0 && <details className="mt-2 text-[12px]"><summary className="cursor-pointer text-gov">{t('pages.activation.representativeSamples')}</summary>{review.liveMetrics.representativeSamples.map((sample, index) => <div key={`${sample.toolName}-${index}`} className="font-mono text-ink-3">{sample.toolName} · {sample.decision} · {sample.pathCategory}</div>)}</details>}
    {review.decisions.length > 0 && <details className="mt-2 text-[12px]"><summary className="cursor-pointer text-gov">{t('pages.activation.ownerDecisionHistory')}</summary>{review.decisions.map(decision => <div key={decision.decisionId} className="mt-1 border-l border-line pl-2 text-ink-3"><span className="font-mono">{decision.decidedAt}</span> · {decision.decision} · {decision.principalKind}:{decision.actorId} · {decision.authenticationMethod} · {decision.reasonCode}{decision.note ? ` · ${decision.note}` : ''}</div>)}</details>}
    <div className="mt-2 text-[11px] text-ink-4">{t('pages.activation.circuitConditions')}</div>
    {review.readiness.status === 'evidence_insufficient' && <label className="mt-3 block text-[12px] text-ink-3">{t('pages.activation.overrideReason')}<select value={overrideReason} onChange={event => setOverrideReason(event.target.value)} className="mt-1 w-full rounded border border-line bg-panel px-3 py-2 text-ink"><option value="rare_behavior">{t('pages.activation.overrideRareBehavior')}</option><option value="controlled_rollout">{t('pages.activation.overrideControlledRollout')}</option><option value="owner_accepts_limited_evidence">{t('pages.activation.overrideOwnerAccepts')}</option></select></label>}
    <input value={note} onChange={event => setNote(event.target.value)} placeholder={t('pages.activation.ownerReviewNote')} className="mt-3 w-full rounded border border-line bg-panel px-3 py-2 text-[12px] text-ink" />
    <div className="mt-3 flex flex-wrap gap-2">
      {review.globalPause?.status === 'paused' && <Button disabled={busy || !review.ownerDecisionEnabled} variant="outline" onClick={() => void releasePause()}>{t('pages.activation.releaseGlobalPause')}</Button>}
      {record.action === 'code_tool_hook_shadow_activate' && <><Button disabled={busy || !review.ownerDecisionEnabled} onClick={() => void decide('continue-observing')}>{t('pages.activation.continueObserving')}</Button><Button disabled={busy || !review.ownerDecisionEnabled} variant="outline" onClick={() => void decide('reject-after-shadow')}>{t('pages.activation.rejectAfterShadow')}</Button><Button disabled={busy || !review.ownerDecisionEnabled || (review.readiness.status !== 'ready' && review.readiness.status !== 'evidence_insufficient') || (review.readiness.status === 'evidence_insufficient' && note.trim().length === 0)} onClick={() => void decide('promote')}>{t('pages.activation.confirmLive')}</Button></>}
      {(record.action === 'code_tool_hook_live_activate' || review.controlState?.enforcement === 'safety_isolated') && <Button disabled={busy} variant="destructive" onClick={() => void decide('emergency-deactivate')}>{t('pages.activation.emergencyDeactivate')}</Button>}
      {review.controlState?.enforcement === 'safety_isolated' && <Button disabled={busy || !review.ownerDecisionEnabled} variant="outline" onClick={() => void decide('recover-to-shadow')}>{t('pages.activation.recoverToShadow')}</Button>}
    </div>
    {!review.ownerDecisionEnabled && <div className="mt-2 text-[11px] text-amber">{t('pages.activation.rolloutDisabled')}</div>}
  </div>;
}

function ActivationFactCard({
  record,
  lifecycleData,
  receiptCount,
  onDisable,
  disabling,
  onChanged,
}: {
  record: ActivationRecord;
  lifecycleData: LifecycleMetricsData | null | undefined;
  /** PRI-533: per-principle receipt counts. undefined = counts unavailable
   * (row omitted, page-level degraded note shown); null = no records (honest zero). */
  receiptCount?: ReceiptCountEntryData | null;
  onDisable: (record: ActivationRecord) => void;
  disabling: boolean;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [showConfirm, setShowConfirm] = useState(false);
  const neverActivated = record.activatedAt === null;
  const channelLabel = getChannelLabel(record.channel, t);
  const reversible = isReversibleChannel(record.channel);

  return (
    <article
      className={`relative pl-[22px] py-[18px] pr-[18px] bg-panel border rounded-[6px] transition-colors hover:border-line-2 ${
        neverActivated ? "border-amber/30 border-l-[3px] border-l-amber" : "border-line"
      }`}
      data-testid={`activation-card-${record.activationId}`}
    >
      {/* Tags row */}
      <div className="flex items-center gap-2 flex-wrap pr-24">
        {/* Status label */}
        <span
          className={`inline-flex items-center border rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
            record.status === "active"
              ? "border-green/35 text-green bg-green/5"
              : "border-line text-ink-4 bg-surface/80"
          }`}
          role="status"
        >
          {record.status === "active" ? t("pages.activation.statusActive") : t("pages.activation.statusInactive")}
        </span>
        {/* Channel badge */}
        <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
          {channelLabel}
        </span>
        {/* Reversibility indicator */}
        {reversible && (
          <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {t("pages.activation.tagReversible")}
          </span>
        )}
        {!reversible && record.channel === "code_tool_hook" && (
          <span className="inline-flex items-center border border-danger/35 text-danger rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {t("pages.activation.tagHighRisk")}
          </span>
        )}
        {/* Never activated warning */}
        {neverActivated && (
          <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {t("pages.activation.tagNeverActivated")}
          </span>
        )}
      </div>

      {/* Feedback entry — pre-fills activationId + principleId into the draft */}
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-[14px] right-[14px]"
        data-testid={`activation-feedback-${record.activationId}`}
        onClick={() => {
          const params = new URLSearchParams({
            source: "activation_page",
            activationId: record.activationId,
          });
          if (record.principleId) {
            params.set("principleId", record.principleId);
          }
          navigate(`/report-problem?${params.toString()}`);
        }}
      >
        {t("pages.reportProblem.entryFeedback")}
      </Button>

      {/* Principle info — action is the human-readable anchor; principleId
          is demoted to a secondary mono identifier (also available via hover) */}
      <div className="mt-[14px] mb-2">
        <span className="text-ink-2 text-[13px]">{t("pages.activation.principleLabel")}</span>{" "}
        <Link
          to={`/principles/${record.principleId}`}
          className="text-gov text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          data-testid={`principle-link-${record.principleId}`}
          title={record.principleId}
        >
          {record.action}
        </Link>
        <span className="ml-2 font-mono text-[11px] text-ink-4">{record.principleId}</span>
      </div>

      {/* Action / target / time */}
      {record.legacyDecisionUnknown && <div className="mt-3 border-l-2 border-amber px-3 text-[12px] text-amber">{t('pages.activation.legacyUnknown', { due: record.ownerReviewDueAt ? formatDate(record.ownerReviewDueAt, i18n.language, DATETIME_OPTS) : t('pages.activation.sevenDays') })}</div>}
      <div className="text-ink-3 text-[13px] leading-relaxed space-y-1">
        <div>
          <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.actionLabel")}</span>{" "}
          <span className="text-ink-2">{record.action}</span>
        </div>
        <div>
          <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.targetLabel")}</span>{" "}
          <span className="text-ink-2 font-mono text-[12px]">{record.targetRef}</span>
        </div>
        <div>
          <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.activatedAtLabel")}</span>{" "}
          {neverActivated ? (
            <span className="text-amber">{t("pages.activation.neverActivated")}</span>
          ) : (
            <span className="text-ink-2 font-mono text-[12px] tabular-nums">
              {formatDate(record.activatedAt!, i18n.language, DATETIME_OPTS)}
            </span>
          )}
        </div>
        {/* PRI-533: receipt counts row — rendered only when the counts API is
            reachable (undefined = unavailable → page-level degraded note). */}
        {receiptCount !== undefined && (
          <div data-testid={`activation-receipts-${record.activationId}`}>
            <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.receiptsLabel")}</span>{" "}
            <span className="text-ink-2 font-mono text-[12px] tabular-nums">
              {t("pages.activation.receiptsValue", {
                effect: receiptCount?.effectCount ?? 0,
                presence: receiptCount?.presenceCount ?? 0,
              })}
            </span>
          </div>
        )}
      </div>

      {/* Layer 3: Lifecycle metrics (expandable, only when principle has rules) */}
      {lifecycleData !== undefined && (
        <details className="mt-4 group">
          <summary className="text-gov text-[13px] cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2">
            {t("pages.activation.lifecycleToggle")}
          </summary>
          <div className="mt-2 pl-4 border-l-2 border-line">
            {lifecycleData === null ? (
              <div className="text-ink-4 text-[13px] py-2">
                {t("pages.activation.lifecycleUnavailable")}
              </div>
            ) : lifecycleData.adherence.insufficientData ? (
              <div className="text-ink-4 text-[13px] py-2">
                {t("pages.activation.insufficientData")}
              </div>
            ) : (
              <div className="py-2 space-y-2">
                {/* Adherence rate with honest label */}
                <div className="text-ink-2 text-[13px]">
                  <span className="font-mono font-semibold text-ink tabular-nums">
                    {lifecycleData.adherence.rate !== null
                      ? `${(lifecycleData.adherence.rate * 100).toFixed(0)}%`
                      : "—"}
                  </span>{" "}
                  <span className="text-ink-3">{t("pages.activation.adherenceLabel")}</span>
                  <div className="text-ink-4 text-[11px] mt-1 font-mono">
                    {t("pages.activation.lifecycleNote")}
                  </div>
                </div>
                {/* Rule metrics */}
                {lifecycleData.ruleMetrics.length > 0 && (
                  <div className="space-y-1">
                    {lifecycleData.ruleMetrics.map((rm) => (
                      <div key={rm.ruleId} className="text-ink-3 text-[12px] font-mono">
                        <span className="text-ink-2">{rm.ruleId}</span>:{" "}
                        {rm.triggered} {t("pages.activation.triggered")}{" "}
                        {rm.lastTriggeredAt && (
                          <span className="text-ink-4">
                            ({formatDate(rm.lastTriggeredAt, i18n.language, DATETIME_OPTS)})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      {/* Disable / Rollback action (only for active, reversible channels) */}
      {record.status === "active" && reversible && (
        <div className="mt-4">
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={disabling}
              className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              data-testid={`disable-btn-${record.activationId}`}
            >
              {t("pages.activation.disableAction")}
            </button>
          ) : (
            <div
              className="flex items-center gap-3 px-[14px] py-[10px] bg-surface border border-amber/25 rounded-[4px]"
              role="alert"
              data-testid={`confirm-bar-${record.activationId}`}
            >
              <span className="text-ink-2 text-[13px] flex-1">
                {t("pages.activation.confirmDisable")}
              </span>
              <button
                onClick={() => {
                  onDisable(record);
                  setShowConfirm(false);
                }}
                disabled={disabling}
                className="inline-flex items-center border border-danger/40 text-danger bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-danger/5 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                data-testid={`confirm-disable-${record.activationId}`}
              >
                {disabling ? t("pages.activation.disabling") : t("common.confirm")}
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      )}
      {record.channel === 'code_tool_hook' && record.status === 'active' && <RuleCodeOwnerPanel record={record} onChanged={onChanged} />}
    </article>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function ActivationPage() {
  const { t } = useTranslation();
  const [activationsData, setActivationsData] = useState<ActivationsData | null>(null);
  const [lifecycleCache, setLifecycleCache] = useState<Record<string, LifecycleMetricsData | null>>({});
  const [receiptCounts, setReceiptCounts] = useState<Record<string, ReceiptCountEntryData> | null>(null);
  const [receiptDegraded, setReceiptDegraded] = useState<{ reason: string; nextAction?: string } | null>(null);
  // PRI-590: page-level coverage disclosure for the receipt counts.
  const [receiptCoverage, setReceiptCoverage] = useState<ReceiptEvidenceCoverageData | null>(null);
  // PRI-594: unknown is never presented as a trustworthy zero — when the ledger
  // is malformed the per-card count rows are omitted and the page-level
  // coverage block carries the "requires recovery" verdict instead.
  const receiptCountsUntrustworthy = receiptCoverage !== null && receiptCoverage.validationStatus === "malformed";
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [disablingIds, setDisablingIds] = useState<Set<string>>(new Set());
  const [degradedNote, setDegradedNote] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setDegradedNote(null);
    setReceiptCounts(null);
    setReceiptDegraded(null);
    setReceiptCoverage(null);

    const result = await fetchAllActivations();

    if (!result.success) {
      setLoadingState("error");
      setErrorMessage(result.error);
      return;
    }

    const validated = validateActivationsData(result.data);
    if (validated === null) {
      setLoadingState("error");
      setErrorMessage("Activation data has unexpected shape");
      return;
    }

    setActivationsData(validated);
    if (validated.reason) {
      setDegradedNote(validated.reason);
    }

    // PRI-533: per-principle receipt counts for the activation cards.
    // Counts are supplementary evidence — a degraded/failed counts API never
    // blocks the page; the cards omit the row and the page surfaces the
    // degraded reason once (ERR-002: no silent fallback).
    try {
      const rResult = await fetchReceiptCounts();
      if (!rResult.success) {
        setReceiptDegraded({
          reason: rResult.error,
          ...(rResult.nextAction === undefined ? {} : { nextAction: rResult.nextAction }),
        });
      } else if (rResult.data.status === "ok") {
        const byId: Record<string, ReceiptCountEntryData> = {};
        for (const entry of rResult.data.counts) {
          byId[entry.principleId] = entry;
        }
        setReceiptCounts(byId);
        setReceiptCoverage(rResult.data.coverage);
      } else {
        setReceiptDegraded({
          reason: rResult.data.reason ?? "unknown",
          ...(rResult.data.nextAction === undefined ? {} : { nextAction: rResult.data.nextAction }),
        });
        // Degraded responses still carry coverage — it names the state
        // (disabled vs unavailable) for the localized headline.
        setReceiptCoverage(rResult.data.coverage);
      }
    } catch (err) {
      // EP-03: counts are optional — degrade with reason, never block the page.
      setReceiptDegraded({ reason: err instanceof Error ? err.message : String(err) });
    }

    // Pre-fetch lifecycle metrics for active principles with rules
    // (only for principles that are active, to populate the expandable section)
    const activePrinciples = new Set(
      validated.activations
        .filter((a) => a.status === "active")
        .map((a) => a.principleId)
    );
    const newCache: Record<string, LifecycleMetricsData | null> = {};
    await Promise.all(
      Array.from(activePrinciples).map(async (principleId) => {
        try {
          const lifecycleResult = await fetchLifecycleMetrics(principleId);
          if (lifecycleResult.success) {
            const validatedMetrics = validateLifecycleMetricsData(lifecycleResult.data);
            newCache[principleId] = validatedMetrics;
          } else {
            newCache[principleId] = null;
          }
        } catch {
          // EP-03: graceful degradation — lifecycle metrics are optional
          // Individual principle failure must not block the entire page
          newCache[principleId] = null;
        }
      })
    );
    setLifecycleCache(newCache);

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDisable = useCallback(async (record: ActivationRecord) => {
    setDisablingIds((prev) => new Set(prev).add(record.activationId));

    const result = await disableActivation(record.activationId);

    if (result.success) {
      toast.success(t("pages.activation.disableSuccess"), {
        description: t("pages.activation.disableSuccessDescription", { id: record.principleId }),
        duration: 5000,
      });

      // Update local state only on real backend success
      setActivationsData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          activations: prev.activations.map((a) =>
            a.activationId === record.activationId ? { ...a, status: "inactive" as const } : a
          ),
        };
      });
    } else {
      // EP-03: failure surfaces reason + nextAction
      toast.error(t("pages.activation.disableFailed"), {
        description: result.error,
        duration: 8000,
      });
      if (result.nextAction) {
        toast.info(result.nextAction, { duration: 8000 });
      }
    }

    setDisablingIds((prev) => {
      const next = new Set(prev);
      next.delete(record.activationId);
      return next;
    });
  }, [t]);

  const handleEmergencyPause = useCallback(async () => {
    const result = await pauseAllRuleCode({ idempotencyKey: `pause-${crypto.randomUUID()}`, reasonCode: 'owner_emergency_pause' });
    if (result.success) { toast.success(t('pages.activation.pauseAllSucceeded')); await loadData(); }
    else { toast.error(result.error); if (result.nextAction) toast.info(result.nextAction); }
  }, [loadData, t]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={4} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
          {t("pages.activation.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.activation.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.activation.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const activations = activationsData?.activations ?? [];
  const activeActivations = activations.filter((a) => a.status === "active");
  const pendingRuleCode = activeActivations.filter(record => record.action === 'code_tool_hook_shadow_activate' && record.enforcement !== 'safety_isolated');
  const safetyAlerts = activeActivations.filter(record => record.channel === 'code_tool_hook' && record.enforcement === 'safety_isolated');
  const ordinaryActive = activeActivations.filter(record => !pendingRuleCode.includes(record) && !safetyAlerts.includes(record));
  const inactiveActivations = activations.filter((a) => a.status === "inactive");
  const neverActivatedCount = activations.filter((a) => a.activatedAt === null).length;

  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.activation.eyebrow")}
      </div>
      <ShinyText
        as="h1"
        className="text-[29px] font-semibold tracking-tight text-ink mb-2"
        duration={4.5}
        brightness={0.5}
        disabled={activeActivations.length === 0}
      >
        {t("pages.activation.title")}
      </ShinyText>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.activation.subtitle")}
      </p>

      {/* Summary line */}
      <div
        className="text-sm leading-relaxed text-ink-2 mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]"
        role="status"
        aria-live="polite"
      >
        <span className="font-mono font-semibold text-ink tabular-nums">{activeActivations.length}</span>{" "}
        <span className="text-ink-3">{t("pages.activation.summaryActive")}</span>{" "}
        /{" "}
        <span className="font-mono font-semibold text-ink tabular-nums">{inactiveActivations.length}</span>{" "}
        <span className="text-ink-3">{t("pages.activation.summaryInactive")}</span>
        {neverActivatedCount > 0 && (
          <>
            {" "}/{" "}
            <span className="font-mono font-semibold text-amber tabular-nums">{neverActivatedCount}</span>{" "}
            <span className="text-amber">{t("pages.activation.summaryNeverActivated")}</span>
          </>
        )}
      </div>

      {/* Capability boundary declaration (F.5) — always visible */}
      <CapabilityBoundaryDeclaration />
      {activeActivations.some(record => record.action === 'code_tool_hook_live_activate') && <div className="mt-4 flex justify-end"><Button variant="destructive" onClick={() => void handleEmergencyPause()}>{t('pages.activation.pauseAll')}</Button></div>}

      {/* Degraded note (ERR-002) */}
      {degradedNote && (
        <div className="mt-4 text-ink-4 text-[13px] bg-surface/60 border-l-2 border-amber px-3 py-2">
          {degradedNote}
        </div>
      )}

      {/* PRI-533: receipt counts degraded note (ERR-002 — reason, never silent) */}
      {receiptDegraded && (
        <div
          className="mt-4 text-ink-4 text-[13px] bg-surface/60 border-l-2 border-amber px-3 py-2"
          data-testid="receipt-counts-degraded"
        >
          {/* PRI-590: localized zero-state headline (disabled vs unavailable) when coverage is known.
              Own line — locale-neutral, no inline separator. */}
          {receiptCoverage !== null && (
            <span className="block font-medium text-ink-3">{t(getReceiptSourceStatusLabelKey(receiptCoverage.sourceStatus))}</span>
          )}
          {t("pages.activation.receiptsUnavailable", { reason: receiptDegraded.reason })}
          {receiptDegraded.nextAction && (
            <span className="mt-1 block font-mono text-[12px]">{receiptDegraded.nextAction}</span>
          )}
        </div>
      )}

      {/* PRI-590: page-level receipt evidence coverage disclosure (ok counts only —
          the degraded note above already covers the unavailable/disabled states). */}
      {receiptCounts !== null && receiptCoverage !== null && (
        <div
          className="mt-4 bg-surface/60 border-l-2 border-line px-3 py-2"
          data-testid="receipt-counts-coverage"
        >
          <ReceiptCoverageDisclosure coverage={receiptCoverage} />
        </div>
      )}

      {pendingRuleCode.length > 0 && <section className="mt-8" aria-labelledby="section-pending-rulecode"><SectionTitle id="section-pending-rulecode">{t('pages.activation.pendingRules')}</SectionTitle><p className="mb-3 text-[12px] text-ink-3">{t('pages.activation.pendingRulesDescription')}</p><div className="space-y-[14px]">{pendingRuleCode.map(record => <ActivationFactCard key={record.activationId} record={record} lifecycleData={lifecycleCache[record.principleId]} receiptCount={undefined} onDisable={handleDisable} disabling={disablingIds.has(record.activationId)} onChanged={() => void loadData()} />)}</div></section>}
      {safetyAlerts.length > 0 && <section className="mt-8" aria-labelledby="section-safety-alerts"><SectionTitle id="section-safety-alerts">{t('pages.activation.safetyAlerts')}</SectionTitle><p className="mb-3 text-[12px] text-danger">{t('pages.activation.safetyAlertsDescription')}</p><div className="space-y-[14px]">{safetyAlerts.map(record => <ActivationFactCard key={record.activationId} record={record} lifecycleData={lifecycleCache[record.principleId]} receiptCount={undefined} onDisable={handleDisable} disabling={disablingIds.has(record.activationId)} onChanged={() => void loadData()} />)}</div></section>}

      {/* Section: Active activations */}
      <section className="mt-8" aria-labelledby="section-active">
        <SectionTitle id="section-active">
          {t("pages.activation.sectionActive")}
        </SectionTitle>

        {ordinaryActive.length > 0 ? (
          <div className="space-y-[14px]">
            {ordinaryActive.map((record) => (
              <ActivationFactCard
                key={record.activationId}
                record={record}
                lifecycleData={lifecycleCache[record.principleId]}
                receiptCount={receiptCounts !== null && !receiptCountsUntrustworthy ? (Object.hasOwn(receiptCounts, record.principleId) ? receiptCounts[record.principleId] : null) : undefined}
                onDisable={handleDisable}
                disabling={disablingIds.has(record.activationId)}
                onChanged={() => void loadData()}
              />
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.activation.emptyActive")}
          </div>
        )}
      </section>

      {/* Section: Inactive activations */}
      {inactiveActivations.length > 0 && (
        <section className="mt-8" aria-labelledby="section-inactive">
          <SectionTitle id="section-inactive">
            {t("pages.activation.sectionInactive")}
          </SectionTitle>
          <div className="space-y-[14px]">
            {inactiveActivations.map((record) => (
              <ActivationFactCard
                key={record.activationId}
                record={record}
                lifecycleData={lifecycleCache[record.principleId]}
                receiptCount={receiptCounts !== null && !receiptCountsUntrustworthy ? (Object.hasOwn(receiptCounts, record.principleId) ? receiptCounts[record.principleId] : null) : undefined}
                onDisable={handleDisable}
                disabling={disablingIds.has(record.activationId)}
                onChanged={() => void loadData()}
              />
            ))}
          </div>
        </section>
      )}

      {/* Section: Never activated (highlighted, links to debt page) */}
      {neverActivatedCount > 0 && (
        <section className="mt-8" aria-labelledby="section-never-activated">
          <SectionTitle id="section-never-activated">
            {t("pages.activation.sectionNeverActivated")}
          </SectionTitle>
          <div className="space-y-[10px]">
            {activations
              .filter((a) => a.activatedAt === null)
              .map((record) => (
                <article
                  key={record.activationId}
                  className="relative pl-[22px] py-[14px] pr-[18px] bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px]"
                >
                  <div className="text-ink-2 text-sm leading-relaxed">
                    <span className="font-medium text-ink">{t("pages.activation.neverActivatedCard")}</span>{" "}
                    — {record.action} · {getChannelLabel(record.channel, t)}
                    <span className="ml-2 font-mono text-[11px] text-ink-4">{record.principleId}</span>
                  </div>
                  <Link
                    to="/debt"
                    className="inline-flex items-center mt-2 text-gov text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                  >
                    {t("pages.activation.viewDebt")} →
                  </Link>
                </article>
              ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.activation.footer")}
      </footer>
      </div>
    </PageShell>
  );
}
