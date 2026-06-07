import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  fetchGovernanceQueue,
  fetchApprovalsGrouped,
} from "../../api.js";
import type {
  GovernanceQueueData,
  ApprovalsGroupedData,
  ApprovalGroup,
  StagnationSignal,
  DegradedSignal,
} from "../../api.js";

// ── Approval group validator (not in validators.ts, page-specific) ─────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateApprovalGroup(raw: unknown): ApprovalGroup | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "principleId") ||
    !Object.hasOwn(raw, "principleTitle") ||
    !Object.hasOwn(raw, "status") ||
    !Object.hasOwn(raw, "records")
  ) {
    return null;
  }
  const principleId = raw.principleId;
  const principleTitle = raw.principleTitle;
  const status = raw.status;
  const records = raw.records;
  if (
    typeof principleId !== "string" ||
    typeof principleTitle !== "string" ||
    typeof status !== "string" ||
    !["pending", "approved", "rejected"].includes(status) ||
    !Array.isArray(records)
  ) {
    return null;
  }
  const validRecords: ApprovalGroup["records"] = [];
  for (const r of records) {
    if (!isRecord(r)) return null;
    if (
      !Object.hasOwn(r, "id") ||
      !Object.hasOwn(r, "artifactId") ||
      !Object.hasOwn(r, "channel") ||
      !Object.hasOwn(r, "createdAt") ||
      typeof r.id !== "string" ||
      typeof r.artifactId !== "string" ||
      typeof r.channel !== "string" ||
      typeof r.createdAt !== "string"
    ) {
      return null;
    }
    validRecords.push({
      id: r.id,
      artifactId: r.artifactId,
      channel: r.channel,
      createdAt: r.createdAt,
    });
  }
  return {
    principleId,
    principleTitle,
    status: status as "pending" | "approved" | "rejected",
    records: validRecords,
  };
}

function validateApprovalsGroupedData(raw: unknown): ApprovalsGroupedData | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "groups") ||
    !Object.hasOwn(raw, "generatedAt")
  ) {
    return null;
  }
  const groups = raw.groups;
  const generatedAt = raw.generatedAt;
  if (!Array.isArray(groups) || typeof generatedAt !== "string") {
    return null;
  }
  const validatedGroups: ApprovalGroup[] = [];
  for (const g of groups) {
    const validated = validateApprovalGroup(g);
    if (validated === null) return null;
    validatedGroups.push(validated);
  }
  return {
    groups: validatedGroups,
    generatedAt,
    note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined,
  };
}

// ── i18n code mapping helpers ─────────────────────────────────────────────

/** Map a stateReasonCode to an i18n key, with optional interpolation params. */
function getStateReasonText(
  code: string,
  t: (key: string, params?: Record<string, unknown>) => string,
  pendingReviewCount: number,
): string {
  const i18nKey = `pages.focus.stateReason.${code}`;
  const text = t(i18nKey, { count: pendingReviewCount });
  // If i18n key is not found, t() returns the key itself — fall back to code
  return text === i18nKey ? code : text;
}

/** Map a nextActionCode to an i18n key. */
function getNextActionText(
  code: string,
  t: (key: string) => string,
): string {
  const i18nKey = `pages.focus.nextAction.${code}`;
  const text = t(i18nKey);
  return text === i18nKey ? code : text;
}

/** Map a degraded signal reasonCode to an i18n key. */
function getDegradedReasonText(
  code: string,
  t: (key: string) => string,
): string {
  const i18nKey = `pages.focus.degradedReason.${code}`;
  const text = t(i18nKey);
  return text === i18nKey ? code : text;
}

/** Map a degraded signal nextActionCode to an i18n key. */
function getDegradedNextActionText(
  code: string,
  t: (key: string) => string,
): string {
  const i18nKey = `pages.focus.degradedNextAction.${code}`;
  const text = t(i18nKey);
  return text === i18nKey ? code : text;
}

// ── Channel label helper ─────────────────────────────────────────────────────

function getChannelLabel(channel: string, t: (key: string) => string): string {
  switch (channel) {
    case "prompt":
      return t("pages.focus.channelPrompt");
    case "defer_archive":
      return t("pages.focus.channelDeferArchive");
    case "code_tool_hook":
      return t("pages.focus.channelCodeToolHook");
    default:
      return channel;
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ProseSummary({
  pendingCount,
  deviationCount,
  stagnationCount,
}: {
  pendingCount: number;
  deviationCount: number;
  stagnationCount: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="text-sm leading-relaxed text-ink-2 mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]"
      role="status"
      aria-live="polite"
    >
      <span className="text-ink-3">{t("pages.focus.summaryLabel")}</span>{" "}
      <span className="font-mono font-semibold text-ink">{pendingCount}</span>{" "}
      <span className="text-ink-3">{t("pages.focus.summaryPending")}</span>{" "}
      /{" "}
      <span className="font-mono font-semibold text-ink">{deviationCount}</span>{" "}
      <span className="text-ink-3">{t("pages.focus.summaryDeviation")}</span>{" "}
      /{" "}
      <span className="font-mono font-semibold text-ink">{stagnationCount}</span>{" "}
      <span className="text-ink-3">{t("pages.focus.summaryStagnation")}</span>
    </div>
  );
}

function PendingReviewCard({
  group,
}: {
  group: ApprovalGroup;
}) {
  const { t } = useTranslation();
  const primaryChannel = group.records[0]?.channel ?? "prompt";
  const channelLabel = getChannelLabel(primaryChannel, t);
  const isReversible = primaryChannel === "prompt" || primaryChannel === "defer_archive";

  return (
    <article className="relative pl-[22px] py-[18px] pr-[18px] bg-panel border border-line rounded-[6px] cursor-pointer transition-colors hover:border-line-2">
      {/* Left border indicator */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[6px] bg-gov" />

      {/* Tags row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
          {channelLabel}
        </span>
        {isReversible && (
          <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {primaryChannel === "prompt" ? t("pages.focus.tagReversible") : t("pages.focus.tagLowRisk")}
          </span>
        )}
      </div>

      {/* Title */}
      <div className="mt-[14px] mb-2 font-semibold text-ink">
        {group.principleTitle}
      </div>

      {/* Evidence summary (inset well) */}
      <div className="mt-2 px-3 py-2 bg-surface/60 border-l-2 border-gov text-ink-3 text-[13px] leading-snug">
        {t("pages.focus.evidenceSummary", { count: group.records.length })}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-4">
        <Link
          to={`/principles/${group.principleId}`}
          className="inline-flex items-center border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          data-testid={`review-principle-${group.principleId}`}
        >
          {t("pages.focus.reviewAction")}
        </Link>
        <Link
          to={`/principles/${group.principleId}`}
          className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.focus.viewFullChain")}
        </Link>
      </div>
    </article>
  );
}

function StagnationSignalCard({ signal }: { signal: StagnationSignal }) {
  const { t } = useTranslation();
  const label =
    signal.type === "never_activated"
      ? t("pages.focus.stagnationNeverActivated")
      : t("pages.focus.stagnationNoPain");

  return (
    <article className="relative pl-[22px] py-[14px] pr-[18px] bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px]">
      <div className="text-ink-2 text-sm leading-relaxed">
        <span className="font-medium text-ink">{label}</span>{" "}
        — {signal.principleId} · {signal.daysSince}{" "}
        {t("pages.focus.stagnationDaysSince")}
      </div>
      <Link
        to={`/activation`}
        className="inline-flex items-center mt-2 text-gov text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
      >
        {t("pages.focus.viewFullChain")} →
      </Link>
    </article>
  );
}

function DegradedSignalCard({ signal }: { signal: DegradedSignal }) {
  const { t } = useTranslation();
  const sourceLabel = signal.source === "internalization_task"
    ? t("pages.focus.degradedSourceInternalization")
    : signal.source === "chain_integrity"
      ? t("pages.focus.degradedSourceChainIntegrity")
      : signal.source === "source_unavailable"
        ? t("pages.focus.degradedSourceUnavailable")
        : signal.source;

  // Use i18n-mapped text from reasonCode/nextActionCode
  const reasonText = getDegradedReasonText(signal.reasonCode, t);
  const nextActionText = getDegradedNextActionText(signal.nextActionCode, t);

  return (
    <article className="relative pl-[22px] py-[14px] pr-[18px] bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px]">
      {/* Source label */}
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
          {sourceLabel}
        </span>
      </div>
      {/* Reason (i18n) */}
      <div className="text-ink-2 text-sm leading-relaxed">
        {reasonText}
      </div>
      {/* Raw debug detail — collapsed by default to avoid unsanitized last_error in main view */}
      {signal.reason && (
        <details className="mt-1">
          <summary className="text-ink-4 text-[11px] font-mono cursor-pointer hover:underline">
            {t("pages.focus.advancedDiagnostics")}
          </summary>
          <div className="text-ink-4 text-[12px] leading-snug mt-1 font-mono bg-surface/40 px-2 py-1 rounded-[3px] break-all">
            {signal.reason}
          </div>
        </details>
      )}
      {/* Next action (i18n) */}
      <div className="mt-2 text-ink-4 text-[13px] leading-snug">
        <span className="font-medium">{t("pages.focus.degradedNextActionLabel")}</span>{" "}
        {nextActionText}
      </div>
    </article>
  );
}

function OnboardingGuide() {
  const { t } = useTranslation();
  const steps = [
    t("pages.focus.onboardingStep1"),
    t("pages.focus.onboardingStep2"),
    t("pages.focus.onboardingStep3"),
    t("pages.focus.onboardingStep4"),
    t("pages.focus.onboardingStep5"),
  ];

  return (
    <div className="bg-panel border border-line rounded-[6px] p-6">
      <SectionTitle>{t("pages.focus.onboardingTitle")}</SectionTitle>
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3 text-ink-2 text-sm leading-relaxed">
            <span className="font-mono text-ink-4 text-[11px] mt-0.5 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function InProgressGuide({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-6">
      <SectionTitle>{t("pages.focus.inProgressTitle")}</SectionTitle>
      <p className="text-ink-2 text-sm leading-relaxed mt-2">
        {summary}
      </p>
      <p className="text-ink-4 text-[13px] leading-relaxed mt-3">
        {t("pages.focus.inProgressDetail")}
      </p>
    </div>
  );
}

function DegradedSummary({ signals }: { signals: DegradedSignal[] }) {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px] p-5">
      <SectionTitle>{t("pages.focus.degradedTitle")}</SectionTitle>
      <p className="text-ink-2 text-sm leading-relaxed mt-2">
        {t("pages.focus.degradedStateReason")}
      </p>
      <div className="mt-4 space-y-[10px]">
        {signals.map((signal, i) => (
          <DegradedSignalCard key={`${signal.source}-${i}`} signal={signal} />
        ))}
      </div>
    </div>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function FocusPage() {
  const { t } = useTranslation();
  const [queueData, setQueueData] = useState<GovernanceQueueData | null>(null);
  const [groupedData, setGroupedData] = useState<ApprovalsGroupedData | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [groupedErrorReason, setGroupedErrorReason] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setGroupedErrorReason(null);

    const [queueResult, groupedResult] = await Promise.all([
      fetchGovernanceQueue(),
      fetchApprovalsGrouped(),
    ]);

    // Queue data is already validated by the API layer (validateGovernanceQueue)
    if (!queueResult.success) {
      setLoadingState("error");
      setErrorMessage(queueResult.error);
      return;
    }
    setQueueData(queueResult.data);

    // Validate grouped data (ERR-002: degradation with reason)
    if (!groupedResult.success) {
      setGroupedData(null);
      setGroupedErrorReason(groupedResult.error ?? "Approvals data unavailable");
    } else {
      const validatedGrouped = validateApprovalsGroupedData(groupedResult.data);
      setGroupedData(validatedGrouped);
      if (validatedGrouped === null) {
        setGroupedErrorReason("Approvals data has unexpected shape");
      }
    }

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <div className="text-ink-3 text-sm" role="status" aria-live="polite">
          {t("common.loading")}…
        </div>
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
          {t("pages.focus.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.focus.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.focus.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const pendingGroups = groupedData?.groups.filter((g) => g.status === "pending") ?? [];
  const pendingCount = queueData?.pendingReviewCount ?? 0;
  const deviationCount = queueData?.behaviorDeviationCount ?? 0;
  const stagnationSignals = queueData?.stagnationSignals ?? [];
  const stagnationCount = stagnationSignals.length;
  const governanceState = queueData?.governanceState ?? "none";
  const stateReasonCode = queueData?.stateReasonCode ?? "no_pipeline_activity";
  const nextActionCode = queueData?.nextActionCode ?? "wait_for_pipeline";
  const inProgressSummary = queueData?.inProgressSummary;
  const degradedSignals = queueData?.degradedSignals;
  const approvalDataUnavailable = (groupedData === null || groupedData.groups.length === 0) && pendingCount > 0;

  // Map codes to i18n text
  const stateReason = getStateReasonText(stateReasonCode, t, pendingCount);
  const nextAction = getNextActionText(nextActionCode, t);

  return (
    <PageShell>
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.focus.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.focus.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.focus.subtitle")}
      </p>

      {/* Governance State Summary */}
      <div className="mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]">
        <div className="flex items-center gap-2 mb-1">
          {/* State badge */}
          <span
            className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
              governanceState === "owner_review_ready"
                ? "bg-gov/10 text-gov border border-gov/20"
                : governanceState === "degraded"
                  ? "bg-amber/10 text-amber border border-amber/20"
                  : governanceState === "in_progress"
                    ? "bg-green/10 text-green border border-green/20"
                    : "text-ink-4 border border-line bg-surface/80"
            }`}
            role="status"
          >
            {t(`pages.focus.stateLabel.${governanceState}`)}
          </span>
        </div>
        <div className="text-ink-2 text-[13px] leading-relaxed mt-1">
          {stateReason}
        </div>
        <div className="text-ink-4 text-[13px] leading-relaxed mt-1">
          <span className="font-medium">{t("pages.focus.nextActionLabel")}</span>{" "}
          {nextAction}
        </div>
      </div>

      {/* Prose summary — one line, tabular nums */}
      <ProseSummary
        pendingCount={pendingCount}
        deviationCount={deviationCount}
        stagnationCount={stagnationCount}
      />

      {/* State-specific guides */}
      {governanceState === "none" && pendingCount === 0 && deviationCount === 0 && stagnationCount === 0 && (
        <OnboardingGuide />
      )}

      {governanceState === "in_progress" && inProgressSummary && (
        <InProgressGuide summary={inProgressSummary} />
      )}

      {governanceState === "degraded" && degradedSignals && degradedSignals.length > 0 && (
        <DegradedSummary signals={degradedSignals} />
      )}

      {/* Layer 2: Why — three sections with evidence summaries */}

      {/* Section 1: Pending Review */}
      <section className="mt-8" aria-labelledby="section-pending">
        <SectionTitle id="section-pending">
          {t("pages.focus.sectionPending")}
        </SectionTitle>

        {pendingGroups.length > 0 ? (
          <div className="space-y-[14px]">
            {pendingGroups.map((group) => (
              <PendingReviewCard key={group.principleId} group={group} />
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {approvalDataUnavailable
              ? (groupedErrorReason
                ? `${t("pages.focus.loadError")} (${groupedErrorReason})`
                : t("pages.focus.loadError"))
              : t("pages.focus.emptyPending")}
          </div>
        )}
      </section>

      {/* Section 2: Behavior Deviations */}
      <section className="mt-8" aria-labelledby="section-deviation">
        <SectionTitle id="section-deviation">
          {t("pages.focus.sectionDeviation")}
        </SectionTitle>

        {deviationCount > 0 ? (
          <>
            <div className="text-ink-2 text-sm mb-3">
              <span className="font-mono font-semibold text-ink">{deviationCount}</span>{" "}
              {t("pages.focus.deviationCount", { count: deviationCount })}
            </div>
            {/* Deviation disclaimer (F.2: no fake aggregation) */}
            <div className="text-ink-4 text-[13px] bg-surface/60 border-l-2 border-amber px-3 py-2 mb-4">
              {t("pages.focus.deviationDisclaimer")}
            </div>
            {/* Layer 3: Full trajectory — collapsed by default */}
            <details className="group">
              <summary className="text-gov text-[13px] cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2">
                {t("pages.focus.viewFullChain")}
              </summary>
              <div className="mt-2 pl-4 border-l-2 border-line text-ink-3 text-[13px]">
                {t("pages.focus.deviationDetailPending")}
              </div>
            </details>
          </>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.focus.emptyDeviation")}
          </div>
        )}
      </section>

      {/* Section 3: System Signals (stagnation) */}
      <section className="mt-8" aria-labelledby="section-signals">
        <SectionTitle id="section-signals">
          {t("pages.focus.sectionSignals")}
        </SectionTitle>

        {stagnationSignals.length > 0 ? (
          <div className="space-y-[10px]">
            {stagnationSignals.map((signal) => (
              <StagnationSignalCard key={signal.principleId} signal={signal} />
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.focus.emptySignals")}
          </div>
        )}
      </section>

      {/* Footer — one line (US-1.7) */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.focus.footer")}
      </footer>
    </PageShell>
  );
}
