/**
 * Receipt evidence coverage disclosure — PRI-590.
 *
 * Shared block that explains what receipt numbers MEAN: source status,
 * observed range, retention policy, and the "observed evidence, not full
 * history" limitation. Used by the PrincipleDetail receipt section and the
 * Activation page counts context.
 *
 * Never displays file paths, digests, raw payloads, or tool arguments.
 *
 * Keys use full paths ("pages.principles.…") because this component binds
 * useTranslation() to the default `common` namespace, which carries the
 * whole locale tree — usable from pages that pick other namespaces.
 */
import { useTranslation } from "react-i18next";
import type { ReceiptEvidenceCoverageData, ReceiptSourceStatusData, ReceiptValidationStatusData } from "../../api.js";
import { formatDate } from "../../utils/format-date.js";

// ERR-106: exhaustive Records over the status unions — a binary ternary would
// fold one member into a default and misrepresent its state.
const SOURCE_STATUS_LABEL_KEYS: Record<ReceiptSourceStatusData, string> = {
  available: "pages.principles.detail.receipts.coverage.statusAvailable",
  disabled: "pages.principles.detail.receipts.coverage.statusDisabled",
  unavailable: "pages.principles.detail.receipts.coverage.statusUnavailable",
};

const SOURCE_STATUS_PILL_CLASS: Record<ReceiptSourceStatusData, string> = {
  available: "border-green/35 text-green bg-green/5",
  disabled: "border-amber/35 text-amber bg-amber/5",
  unavailable: "border-line text-ink-4 bg-surface/80",
};

const VALIDATION_NOTE_KEYS: Record<ReceiptValidationStatusData, string | null> = {
  valid: null,
  partial: "pages.principles.detail.receipts.coverage.validationPartial",
  malformed: "pages.principles.detail.receipts.coverage.validationMalformed",
};

/** Localized label key for a source status — shared by the degraded notes. */
export function getReceiptSourceStatusLabelKey(status: ReceiptSourceStatusData): string {
  return SOURCE_STATUS_LABEL_KEYS[status];
}

export function ReceiptCoverageDisclosure({ coverage }: { coverage: ReceiptEvidenceCoverageData }) {
  const { t, i18n } = useTranslation();
  const validationNoteKey = VALIDATION_NOTE_KEYS[coverage.validationStatus];
  return (
    <div data-testid="receipt-coverage">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
          {t("pages.principles.detail.receipts.coverage.label")}
        </span>
        <span
          className={`inline-flex items-center border rounded-[2px] px-[7px] py-0.5 font-mono text-[11px] uppercase ${SOURCE_STATUS_PILL_CLASS[coverage.sourceStatus]}`}
        >
          {t(SOURCE_STATUS_LABEL_KEYS[coverage.sourceStatus])}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-4">
        {coverage.observedFrom !== null
          ? t("pages.principles.detail.receipts.coverage.observedSince", {
              date: formatDate(coverage.observedFrom, i18n.language),
            })
          : t("pages.principles.detail.receipts.coverage.observedSinceEmpty")}
        {" · "}
        {t("pages.principles.detail.receipts.coverage.asOf", { date: formatDate(coverage.asOf, i18n.language) })}
        {" · "}
        {t("pages.principles.detail.receipts.coverage.retention", { days: coverage.retentionPolicyDays })}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-4">
        {t("pages.principles.detail.receipts.coverage.limitation")}
      </p>
      {validationNoteKey !== null && (
        <p data-testid="receipt-coverage-validation" className="mt-1 text-[11px] leading-relaxed text-amber">
          {t(validationNoteKey, { reasonCode: coverage.reasonCode ?? "" })}
        </p>
      )}
    </div>
  );
}
