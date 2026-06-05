import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  fetchPrinciples,
  fetchAllActivations,
} from "../../api.js";
import type {
  ActivationRecord,
} from "../../api.js";
import {
  validatePrinciplesListData,
  validateActivationsData,
  deriveDebtCandidates,
  isActionAvailable,
} from "./DebtValidators.js";
import type {
  DebtCandidate,
  DebtReason,
  SuggestedAction,
} from "./DebtValidators.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getDebtReasonKey(reason: DebtReason): string {
  switch (reason) {
    case "approvedNeverActivated":
      return "pages.debt.reasonApprovedNeverActivated";
    case "longTermInactive":
      return "pages.debt.reasonLongTermInactive";
    case "noActivationRecord":
      return "pages.debt.reasonNoActivationRecord";
  }
}

function getSuggestedActionKey(action: SuggestedAction): string {
  switch (action) {
    case "archive":
      return "pages.debt.actionArchive";
    case "downgrade":
      return "pages.debt.actionDowngrade";
    case "keepObserving":
      return "pages.debt.actionKeepObserving";
  }
}

function getActionDisabledReasonKey(action: SuggestedAction): string {
  switch (action) {
    case "archive":
      return "pages.debt.archiveDisabledReason";
    case "downgrade":
      return "pages.debt.downgradeDisabledReason";
    case "keepObserving":
      return "pages.debt.keepObservingDisabledReason";
  }
}

// ── Sub-components ──────────────────────────────────────────────────────────

function DebtCandidateCard({
  candidate,
}: {
  candidate: DebtCandidate;
}) {
  const { t } = useTranslation();
  const available = isActionAvailable(candidate.suggestedAction);

  return (
    <article
      className="relative pl-[22px] py-[18px] pr-[18px] bg-panel border border-line rounded-[6px] transition-colors hover:border-line-2"
      data-testid={`debt-card-${candidate.principleId}`}
    >
      {/* Tags row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase bg-amber/5"
          role="status"
        >
          {t(`pages.debt.reasonTag.${candidate.debtReason}`)}
        </span>
        {candidate.channel && (
          <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
            {candidate.channel}
          </span>
        )}
      </div>

      {/* Principle info */}
      <div className="mt-[14px] mb-2">
        <Link
          to={`/principles/${candidate.principleId}`}
          className="text-gov text-[15px] font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          data-testid={`principle-link-${candidate.principleId}`}
        >
          {candidate.principleTitle}
        </Link>
        <div className="text-ink-4 font-mono text-[11px] mt-1">
          {candidate.principleId}
        </div>
      </div>

      {/* Debt reason (natural language) */}
      <div className="text-ink-2 text-[14px] leading-relaxed mt-3">
        {t(getDebtReasonKey(candidate.debtReason), {
          days: candidate.daysSinceActivation ?? 0,
        })}
      </div>

      {/* Suggested action + disabled button with honest note */}
      <div className="mt-4 flex items-start gap-3 flex-wrap">
        <button
          disabled
          className="inline-flex items-center border border-line bg-surface/60 text-ink-4 rounded-[3px] px-[14px] py-[6px] text-[12.5px] cursor-not-allowed opacity-60"
          data-testid={`action-btn-${candidate.principleId}`}
          aria-disabled="true"
          title={t(getActionDisabledReasonKey(candidate.suggestedAction))}
        >
          {t(getSuggestedActionKey(candidate.suggestedAction))}
        </button>
        {!available && (
          <span className="text-ink-4 text-[13px] leading-relaxed mt-[2px]">
            {t(getActionDisabledReasonKey(candidate.suggestedAction))}
          </span>
        )}
      </div>
    </article>
  );
}

// ── Main page component ─────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function DebtPage() {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<DebtCandidate[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [degradedNote, setDegradedNote] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setDegradedNote(null);

    // Fetch both principles and activations in parallel
    const [principlesResult, activationsResult] = await Promise.all([
      fetchPrinciples(),
      fetchAllActivations(),
    ]);

    // Handle principles fetch failure
    if (!principlesResult.success) {
      setLoadingState("error");
      setErrorMessage(principlesResult.error);
      return;
    }

    // Validate principles data (Runtime Contract H)
    const validatedPrinciples = validatePrinciplesListData(
      principlesResult.data,
    );
    if (validatedPrinciples === null) {
      setLoadingState("error");
      setErrorMessage("Principles data has unexpected shape");
      return;
    }

    // Handle activations fetch failure (graceful degradation — ERR-002)
    let validatedActivations: ActivationRecord[] = [];
    if (activationsResult.success) {
      const validated = validateActivationsData(activationsResult.data);
      if (validated !== null) {
        validatedActivations = validated.activations;
        if (validated.note) {
          setDegradedNote(validated.note);
        }
      } else {
        // Activations data is malformed — degrade gracefully
        setDegradedNote(
          t("pages.debt.activationsDegraded"),
        );
      }
    } else {
      // Activations API failed — we can still show principles-based debt
      setDegradedNote(
        t("pages.debt.activationsUnavailable"),
      );
    }

    // Derive debt candidates from cross-referenced data
    const debtCandidates = deriveDebtCandidates(
      validatedPrinciples.principles,
      validatedActivations,
    );

    setCandidates(debtCandidates);
    setLoadingState("loaded");
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Loading state ──────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <div className="text-ink-3 text-sm" role="status" aria-live="polite">
          {t("common.loading")}…
        </div>
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
          {t("pages.debt.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.debt.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.debt.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">
              {errorMessage}
            </p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ───────────────────────────────────────────────────────
  const neverActivatedCount = candidates.filter(
    (c) => c.debtReason === "approvedNeverActivated",
  ).length;
  const inactiveCount = candidates.filter(
    (c) => c.debtReason === "longTermInactive",
  ).length;
  const noRecordCount = candidates.filter(
    (c) => c.debtReason === "noActivationRecord",
  ).length;

  return (
    <PageShell>
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.debt.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.debt.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.debt.subtitle")}
      </p>

      {/* Summary line */}
      <div
        className="text-sm leading-relaxed text-ink-2 mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]"
        role="status"
        aria-live="polite"
      >
        <span className="font-mono font-semibold text-ink tabular-nums">
          {candidates.length}
        </span>{" "}
        <span className="text-ink-3">{t("pages.debt.summaryTotal")}</span>
        {neverActivatedCount > 0 && (
          <>
            {" · "}
            <span className="font-mono font-semibold text-amber tabular-nums">
              {neverActivatedCount}
            </span>{" "}
            <span className="text-amber">
              {t("pages.debt.summaryNeverActivated")}
            </span>
          </>
        )}
        {inactiveCount > 0 && (
          <>
            {" · "}
            <span className="font-mono font-semibold text-ink-3 tabular-nums">
              {inactiveCount}
            </span>{" "}
            <span className="text-ink-3">
              {t("pages.debt.summaryInactive")}
            </span>
          </>
        )}
        {noRecordCount > 0 && (
          <>
            {" · "}
            <span className="font-mono font-semibold text-ink-3 tabular-nums">
              {noRecordCount}
            </span>{" "}
            <span className="text-ink-3">
              {t("pages.debt.summaryNoRecord")}
            </span>
          </>
        )}
      </div>

      {/* Capability boundary (F.5) — always visible */}
      <div
        className="px-[18px] py-[14px] bg-panel border border-line rounded-[6px] text-ink-3 text-[13px] leading-relaxed mb-6"
        role="note"
        aria-label={t("pages.debt.boundaryLabel")}
      >
        {t("pages.debt.boundaryText")}
      </div>

      {/* Degraded note (ERR-002) */}
      {degradedNote && (
        <div className="mb-6 text-ink-4 text-[13px] bg-surface/60 border-l-2 border-amber px-3 py-2">
          {degradedNote}
        </div>
      )}

      {/* Debt candidates */}
      {candidates.length > 0 ? (
        <section className="mt-2" aria-labelledby="section-debt-candidates">
          <SectionTitle id="section-debt-candidates">
            {t("pages.debt.sectionCandidates")}
          </SectionTitle>
          <div className="space-y-[14px]">
            {candidates.map((candidate) => (
              <DebtCandidateCard
                key={candidate.principleId}
                candidate={candidate}
              />
            ))}
          </div>
        </section>
      ) : (
        /* Empty state — guided, not "no data" (E) */
        <section className="mt-6" aria-labelledby="section-empty">
          <div
            className="p-6 bg-panel border border-line rounded-[6px] text-center"
            data-testid="debt-empty-state"
          >
            <p className="text-ink-2 text-[15px] leading-relaxed">
              {t("pages.debt.emptyTitle")}
            </p>
            <p className="text-ink-3 text-[13px] leading-relaxed mt-2">
              {t("pages.debt.emptyDescription")}
            </p>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.debt.footer")}
      </footer>
    </PageShell>
  );
}
