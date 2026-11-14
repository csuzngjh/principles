import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "../../../lib/utils.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { fetchAdaptiveActivation, updateAdaptiveActivation } from "../../api.js";
import type { AdaptiveActivationViewData, AdaptiveInjectionRecordData } from "../../utils/validators.js";

/**
 * Adaptive Activation entry — Codex desktop normal chat, append-only v1.
 *
 * Deliberately workspace-scoped and read-through: every value on this card is
 * either the persisted config of THIS workspace, the SAME candidate read the
 * runtime assembly uses, or a recorded injection fact. Nothing here simulates
 * a host budget, and saving never sends a scoring request.
 */

type LastResultKind =
  | "appended"
  | "skipped"
  | "abstain"
  | "failed"
  | "selected_not_applied"
  | "setup";

function classifyLastResult(record: AdaptiveInjectionRecordData): LastResultKind {
  if (record.appendedActivationId !== null) return "appended";
  if (record.resultCode.startsWith("needs_setup:")) return "setup";
  if (record.resultCode.startsWith("skipped:")) return "skipped";
  if (record.resultCode.startsWith("selected:")) return "selected_not_applied";
  if (record.scored) return "abstain";
  return "failed";
}

export function AdaptiveActivationSection() {
  const { t } = useTranslation();
  const [view, setView] = useState<AdaptiveActivationViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchAdaptiveActivation();
    if (result.success && result.data) {
      setView(result.data);
    } else {
      setView(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (payload: { enabled?: boolean; service?: "decisions-openrouter-respan" }) => {
      setPending(true);
      const result = await updateAdaptiveActivation(payload);
      setPending(false);
      if (!result.success) {
        toast.error(result.error ?? t("pages.settings.adaptiveActivation.errorSave"), {
          description: result.nextAction,
        });
        return;
      }
      if (result.data) setView(result.data);
      toast.success(t("pages.settings.adaptiveActivation.saveOk"));
    },
    [t],
  );

  const a11y = (key: string) => t(`pages.settings.adaptiveActivation.${key}`);

  if (loading) {
    return (
      <section className="mb-8" aria-labelledby="section-adaptive-activation">
        <SectionTitle id="section-adaptive-activation">{a11y("title")}</SectionTitle>
        <div className="bg-panel border border-line rounded-[6px] p-5 text-ink-4 text-[12px]">
          {a11y("loading")}
        </div>
      </section>
    );
  }

  if (view === null) {
    return (
      <section className="mb-8" aria-labelledby="section-adaptive-activation">
        <SectionTitle id="section-adaptive-activation">{a11y("title")}</SectionTitle>
        <div className="bg-panel border border-line rounded-[6px] p-5">
          <p className="text-ink-3 text-body mb-3">{a11y("loadFailed")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="text-[12px] text-gov underline underline-offset-2"
          >
            {a11y("retry")}
          </button>
        </div>
      </section>
    );
  }

  const { codex, service, candidates, lastRecord, evidence } = view;
  const replacementMode = view.replaceableActivationIds.length > 0;
  const blocked = candidates.blockingWarnings.length > 0;
  // Only a PROVEN absence of evidence may be described as "no host call yet".
  // `unknown` must never fall into this branch.
  const noOpportunity = codex.saved
    && !replacementMode
    && !blocked
    && candidates.validCount > 0
    && evidence.status === "not_observed";
  const evidenceUnknown = evidence.status === "unknown";

  const emptyReasonKey =
    candidates.emptyState === "prompt_disabled"
      ? "reasonPromptDisabled"
      : candidates.emptyState === "db_missing"
        ? "reasonDbMissing"
        : candidates.emptyState === "read_failed"
          ? "reasonReadFailed"
          : "reasonZero";

  const lastKind = lastRecord === null ? null : classifyLastResult(lastRecord);

  return (
    <section className="mb-8" aria-labelledby="section-adaptive-activation" data-testid="adaptive-activation-section">
      <SectionTitle id="section-adaptive-activation">{a11y("title")}</SectionTitle>
      <div className="bg-panel border border-line rounded-[6px] p-5">
        <p className="text-ink-3 text-body leading-relaxed mb-4">{a11y("intro")}</p>

        {/* Workspace of record — the whole card is scoped to this path. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
          <span className="font-mono text-[11px] tracking-[0.14em] text-ink-4 uppercase">
            {a11y("workspaceLabel")}
          </span>
          <span className="font-mono text-[12px] text-ink-2 break-all" data-testid="adaptive-workspace">
            {view.workspaceDir}
          </span>
        </div>

        {/* Layer 1: the one thing that needs attention now. */}
        <div className="border border-line rounded-[4px] p-4 mb-4" data-testid="adaptive-priority">
          <div className="font-mono text-[11px] tracking-[0.14em] text-ink-4 uppercase mb-2">
            {a11y("priorityLabel")}
          </div>
          {replacementMode ? (
            <>
              <div className="text-ink text-sm font-medium mb-1">{a11y("statusReplacement")}</div>
              <p className="text-ink-3 text-body leading-relaxed">{a11y("replacementBody")}</p>
              <p className="font-mono text-[11px] text-ink-4 mt-2 break-all">
                {view.replaceableActivationIds.join(", ")}
              </p>
            </>
          ) : blocked ? (
            <>
              <div className="text-ink text-sm font-medium mb-1">{a11y("statusBlocked")}</div>
              <p className="text-ink-3 text-body leading-relaxed">{a11y("blockedBody")}</p>
              <ul className="mt-2 space-y-1">
                {candidates.blockingWarnings.slice(0, 3).map((warning) => (
                  <li key={warning} className="font-mono text-[11px] text-ink-4 break-all">
                    {warning}
                  </li>
                ))}
              </ul>
              <Link to="/activation" className="inline-block mt-2 text-[12px] text-gov underline underline-offset-2">
                {a11y("goActivation")}
              </Link>
            </>
          ) : candidates.validCount === 0 ? (
            <>
              <div className="text-ink text-sm font-medium mb-1">{a11y("statusNoPrinciples")}</div>
              <p className="text-ink-3 text-body leading-relaxed">{a11y(emptyReasonKey)}</p>
              <Link to="/principles" className="inline-block mt-2 text-[12px] text-gov underline underline-offset-2">
                {a11y("goPrinciples")}
              </Link>
            </>
          ) : evidenceUnknown ? (
            <>
              <div className="text-ink text-sm font-medium mb-1" data-testid="adaptive-status-unknown">
                {a11y("statusEvidenceUnknown")}
              </div>
              <p className="text-ink-3 text-body leading-relaxed">{a11y("evidenceUnknownBody")}</p>
              <ul className="mt-2 space-y-1 text-[12px] text-ink-3">
                <li>{a11y("evidenceUnknownCheckLogs")}</li>
                <li>{a11y("evidenceUnknownRerun")}</li>
              </ul>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 text-[12px] text-gov underline underline-offset-2"
              >
                {a11y("retry")}
              </button>
            </>
          ) : noOpportunity ? (
            <>
              <div className="text-ink text-sm font-medium mb-1">{a11y("statusNoOpportunity")}</div>
              <p className="text-ink-3 text-body leading-relaxed">{a11y("noOpportunityBody")}</p>
            </>
          ) : (
            <>
              <div className="text-ink text-sm font-medium mb-1">{a11y("statusHealthy")}</div>
              <p className="text-ink-3 text-body leading-relaxed">
                {t("pages.settings.adaptiveActivation.countAvailable", { count: candidates.validCount })}
              </p>
            </>
          )}
        </div>

        {/* Switch — the SAME existing Codex AA flag. */}
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="min-w-0">
            <label htmlFor="adaptive-activation-toggle" className="block text-sm font-medium text-ink">
              {a11y("switchLabel")}
            </label>
            <p className="text-ink-3 text-body leading-relaxed mt-1">{a11y("switchHint")}</p>
          </div>
          <button
            id="adaptive-activation-toggle"
            type="button"
            role="switch"
            aria-checked={codex.enabled}
            aria-label={a11y("switchLabel")}
            disabled={pending || (replacementMode && !codex.enabled)}
            onClick={() => void mutate({ enabled: !codex.enabled })}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
              codex.enabled ? "bg-gov" : "bg-line",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-paper transition-transform",
                codex.enabled ? "translate-x-6" : "translate-x-1",
              )}
            />
          </button>
        </div>

        {/* Saved ≠ observed: two separate facts, never conflated. */}
        <div className="grid gap-2 mb-4 text-[12px]" data-testid="adaptive-evidence-split">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase",
                codex.saved ? "bg-green text-ink" : "bg-line text-ink-3",
              )}
              data-testid="adaptive-saved"
            >
              {a11y("savedLabel")}
            </span>
            <span className="text-ink-3">{codex.saved ? a11y("savedYes") : a11y("savedNo")}</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase",
                evidence.status === "observed"
                  ? "bg-green text-ink"
                  : evidence.status === "not_observed"
                    ? "bg-amber text-ink"
                    : "bg-danger text-paper",
              )}
              data-testid="adaptive-observed"
              data-evidence-status={evidence.status}
            >
              {a11y("observedLabel")}
            </span>
            <span className="text-ink-3" data-testid="adaptive-observed-text">
              {evidence.status === "observed"
                ? a11y("observedYes")
                : evidence.status === "not_observed"
                  ? a11y("observedNo")
                  : a11y("observedUnknown")}
            </span>
          </div>
          <p className="text-ink-4 text-[11px] leading-relaxed">{a11y("observedNote")}</p>
          {evidence.reason === "observed_partial" && (
            <p className="text-ink-3 text-[11px] leading-relaxed" data-testid="adaptive-evidence-partial">
              {t("pages.settings.adaptiveActivation.evidencePartial", { count: evidence.parseFailures })}
            </p>
          )}
        </div>

        {/* Decision service — fixed preset, workspace-scoped, credentials by env name. */}
        <div className="border border-line rounded-[4px] p-4 mb-4" data-testid="adaptive-service">
          <div className="font-mono text-[11px] tracking-[0.14em] text-ink-4 uppercase mb-2">
            {a11y("serviceTitle")}
          </div>
          <p className="text-ink-3 text-body leading-relaxed mb-3">{a11y("serviceBody")}</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px] mb-3">
            <dt className="text-ink-4">{a11y("serviceEndpoint")}</dt>
            <dd className="font-mono text-ink-2 break-all">{service.endpoint}</dd>
            <dt className="text-ink-4">{a11y("serviceModel")}</dt>
            <dd className="font-mono text-ink-2 break-all">{service.model}</dd>
            <dt className="text-ink-4">{a11y("serviceProvider")}</dt>
            <dd className="font-mono text-ink-2">{service.provider ?? "—"}</dd>
            <dt className="text-ink-4">{a11y("serviceKeyEnv")}</dt>
            <dd className="font-mono text-ink-2">{service.apiKeyEnv}</dd>
          </dl>
          {view.otherHostAaEnabled.length > 0 && (
            <p className="text-ink-3 text-[12px] leading-relaxed mb-3" data-testid="adaptive-shared-lock">
              {a11y("serviceSharedLock")}
            </p>
          )}
          {codex.serviceConfigured ? (
            <div className="text-[12px] text-ink-3">{a11y("serviceSaved")}</div>
          ) : (
            <button
              type="button"
              disabled={pending || replacementMode || view.otherHostAaEnabled.length > 0}
              onClick={() => void mutate({ service: "decisions-openrouter-respan" })}
              className="inline-flex items-center rounded-[4px] border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-line/40 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {a11y("serviceSave")}
            </button>
          )}
          <p className="text-ink-4 text-[11px] mt-2">
            {service.credentialSeenInConsoleProcess
              ? a11y("credentialSeen")
              : a11y("credentialNotSeen")}
          </p>
        </div>

        {/* What actually leaves the process — and when. */}
        <div className="border border-line rounded-[4px] p-4 mb-4" data-testid="adaptive-outbound">
          <div className="font-mono text-[11px] tracking-[0.14em] text-ink-4 uppercase mb-2">
            {a11y("dataTitle")}
          </div>
          <p className="text-ink-3 text-body leading-relaxed">{a11y("dataBody")}</p>
        </div>

        {/* Last recorded turn. */}
        <div className="border border-line rounded-[4px] p-4 mb-4" data-testid="adaptive-last">
          <div className="font-mono text-[11px] tracking-[0.14em] text-ink-4 uppercase mb-2">
            {a11y("lastTitle")}
          </div>
          {lastRecord === null || lastKind === null ? (
            <div className="text-ink-3 text-[12px]" data-testid="adaptive-last-empty">
              {a11y("lastEmpty")}
            </div>
          ) : (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-ink-4">{a11y("lastTime")}</dt>
              <dd className="font-mono text-ink-2">{lastRecord.ts ?? "—"}</dd>
              <dt className="text-ink-4">{a11y("lastResult")}</dt>
              <dd className="text-ink-2">
                {lastKind === "appended"
                  ? a11y("lastAppended")
                  : a11y(`last_${lastKind}`)}
              </dd>
              <dt className="text-ink-4">{a11y("lastReason")}</dt>
              <dd className="font-mono text-ink-3 break-all">{lastRecord.resultCode}</dd>
            </dl>
          )}
        </div>

        {/* Static example — explains the semantics without pretending to be data. */}
        <div className="border border-line rounded-[4px] p-4">
          <div className="font-mono text-[11px] tracking-[0.14em] text-ink-4 uppercase mb-2">
            {a11y("exampleTitle")}
          </div>
          <p className="text-ink-3 text-[12px] leading-relaxed mb-1">{a11y("exampleBefore")}</p>
          <p className="text-ink-3 text-[12px] leading-relaxed">{a11y("exampleAfter")}</p>
        </div>
      </div>
    </section>
  );
}
