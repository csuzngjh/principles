/**
 * Ingestion status — Owner-facing presentation layer.
 *
 * The CLI report is the data authority (`IngestionHealthModel` passes the
 * `.ingestion` section through VERBATIM; the Console must not copy per-host
 * judgment). This module is the UI's single place that turns the report's
 * stable reason codes and operator-pitched English prose into the Owner's
 * language. Raw values are never dropped: they ride back as `technical` and
 * render inside a TechnicalDetails disclosure (UI/UX plan §4.1/§4.3 — the
 * data layer is untouched, engineering strings never set the tone of the
 * reading path, and a degraded fact stays observable = rc-9).
 *
 * Fallback ladder (never blank, never silently swallowed):
 * 1. known exact code → localized phrase (technical = null, it IS the code)
 * 2. known code family (`code:<detail>`) → localized phrase, raw in technical
 * 3. English prose → neutral sentence, raw in technical
 * 4. anything else (short unknown code) → raw, fail-visible (same contract as
 *    ReceiptCoverageDisclosure's unknown reasonCode fallback)
 *
 * Pure functions, no I/O, no DOM (directly unit-testable).
 */
import { looksLikeEnglishSentence } from "../../utils/technical-detail.js";

export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

export interface PresentedText {
  /** What the reading surface shows (UI language). */
  readonly text: string;
  /** Raw CLI text, only for the technical-details disclosure; null when the text IS the value. */
  readonly technical: string | null;
}

/**
 * Stable reason codes emitted by `pd health` (health-ingestion.ts) and the
 * console collector (IngestionHealthModel.ts). A Map, not a plain object —
 * the lookup key comes from the API payload (EP-01/ERR-013: no prototype
 * exposure).
 */
const REASON_CODE_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ["consent_not_granted", "pages.ingestionStatus.reasonCodes.consentNotGranted"],
  ["transcript_path_validator_unavailable", "pages.ingestionStatus.reasonCodes.transcriptPathValidatorUnavailable"],
  ["transcript_shrank_below_offset", "pages.ingestionStatus.reasonCodes.transcriptShrankBelowOffset"],
  ["lag_lookup_budget_exceeded", "pages.ingestionStatus.reasonCodes.lagLookupBudgetExceeded"],
  ["transcript_unavailable_or_stat_failed", "pages.ingestionStatus.reasonCodes.transcriptUnavailableOrStatFailed"],
  ["lag_undeterminable", "pages.ingestionStatus.reasonCodes.lagUndeterminable"],
  ["transcript_record_too_large", "pages.ingestionStatus.reasonCodes.transcriptRecordTooLarge"],
  ["transcript_record_malformed", "pages.ingestionStatus.reasonCodes.transcriptRecordMalformed"],
  ["transcript_read_failed", "pages.ingestionStatus.reasonCodes.transcriptReadFailed"],
  ["checkpoint_inconsistent", "pages.ingestionStatus.reasonCodes.checkpointInconsistent"],
  ["ingestion_assessment_failed", "pages.ingestionStatus.reasonCodes.ingestionAssessmentFailed"],
  ["health_collection_failed", "pages.ingestionStatus.reasonCodes.healthCollectionFailed"],
  ["health_report_unparseable", "pages.ingestionStatus.reasonCodes.healthReportUnparseable"],
]);

/**
 * Code families that carry a `:<detail>` suffix (bounded error text, possibly
 * with paths). The localized label describes the family; the raw value —
 * detail included — stays available in the technical disclosure.
 */
const REASON_CODE_PREFIX_KEYS: readonly { prefix: string; labelKey: string; actionKey: string }[] = [
  { prefix: "host_adapter_unavailable:", labelKey: "pages.ingestionStatus.reasonCodes.hostAdapterUnavailable", actionKey: "pages.ingestionStatus.nextActions.hostAdapterUnavailable" },
  { prefix: "transcript_read_failed:", labelKey: "pages.ingestionStatus.reasonCodes.transcriptReadFailed", actionKey: "pages.ingestionStatus.nextActions.transcriptReadFailed" },
  { prefix: "ingestion_assessment_failed:", labelKey: "pages.ingestionStatus.reasonCodes.ingestionAssessmentFailed", actionKey: "pages.ingestionStatus.nextActions.ingestionAssessmentFailed" },
];

function matchReasonCode(raw: string): { labelKey: string; technical: string | null } | null {
  const value = raw.trim();
  if (value === "") return null;
  const exact = REASON_CODE_LABEL_KEYS.get(value);
  if (exact !== undefined) return { labelKey: exact, technical: null };
  for (const family of REASON_CODE_PREFIX_KEYS) {
    if (value.startsWith(family.prefix)) return { labelKey: family.labelKey, technical: value };
  }
  return null;
}

/** The known exact codes, exported for the parity unit test (single source). */
export const INGESTION_REASON_CODES: readonly string[] = [...REASON_CODE_LABEL_KEYS.keys()];

/** Anything that reads as "a sentence in English" rather than a code/label. */
function looksLikeProse(value: string): boolean {
  // Delegate to the shared heuristic (3+ English words after path stripping)
  // so every page agrees on what "untranslated prose" means.
  return looksLikeEnglishSentence(value);
}

/**
 * One entry point for rendering a CLI-produced REASON on this page.
 */
export function presentIngestionReason(raw: string, t: TranslateFn): PresentedText {
  const matched = matchReasonCode(raw);
  if (matched !== null) return { text: t(matched.labelKey), technical: matched.technical };
  if (looksLikeProse(raw)) return { text: t("pages.ingestionStatus.unknownReason"), technical: raw.trim() };
  return { text: raw, technical: null };
}

/**
 * One entry point for rendering an unpaired CLI-produced NEXT ACTION (flag
 * diagnostics, top-level collection failures). Specific next-action sentences
 * come from the code-keyed paths (presentDegradedSection /
 * presentConsentNextAction); this ladder only decides between the neutral
 * sentence and a fail-visible raw value. CLI command lines stay out of the
 * reading path — the raw text goes to the technical disclosure.
 */
export function presentIngestionNextAction(raw: string, t: TranslateFn): PresentedText {
  if (looksLikeProse(raw)) return { text: t("pages.ingestionStatus.unknownNextAction"), technical: raw.trim() };
  return { text: raw, technical: null };
}

/**
 * Next-action keys that exist per reason code. Kept as a set so a missing
 * translation degrades to the prose ladder instead of rendering the i18n key.
 */
const NEXT_ACTION_CODE_SUFFIXES: ReadonlySet<string> = new Set([
  "consentNotGranted",
  "transcriptPathValidatorUnavailable",
  "transcriptShrankBelowOffset",
  "lagLookupBudgetExceeded",
  "transcriptUnavailableOrStatFailed",
  "lagUndeterminable",
  "transcriptRecordTooLarge",
  "transcriptRecordMalformed",
  "transcriptReadFailed",
  "checkpointInconsistent",
  "ingestionAssessmentFailed",
  "healthCollectionFailed",
  "healthReportUnparseable",
]);

function hasNextActionKey(suffix: string): boolean {
  return NEXT_ACTION_CODE_SUFFIXES.has(suffix);
}

function actionKeyForLabel(labelKey: string): string | null {
  // reasonCodes.X ↔ nextActions.X is a 1:1 pairing by construction; derive it
  // instead of maintaining a second map (they must not drift).
  const suffix = labelKey.slice("pages.ingestionStatus.reasonCodes.".length);
  const key = `pages.ingestionStatus.nextActions.${suffix}`;
  return hasNextActionKey(suffix) ? key : null;
}

function actionKeyForPrefix(value: string): string | null {
  const family = REASON_CODE_PREFIX_KEYS.find((entry) => value.startsWith(entry.prefix));
  return family?.actionKey ?? null;
}

/**
 * A degraded section ({reason, nextAction}) — the next action is keyed by the
 * paired reason code when known, so the Owner gets the specific sentence
 * instead of the neutral fallback.
 */
export function presentDegradedSection(
  section: { reason: string; nextAction: string },
  t: TranslateFn,
): { reason: PresentedText; nextAction: PresentedText } {
  const reason = presentIngestionReason(section.reason, t);
  const byCode = matchReasonCode(section.reason);
  if (byCode !== null) {
    const actionKey = byCode.technical === null
      ? actionKeyForLabel(byCode.labelKey)
      : actionKeyForPrefix(section.reason.trim());
    if (actionKey !== null) {
      return { reason, nextAction: { text: t(actionKey), technical: section.nextAction.trim() } };
    }
  }
  return { reason, nextAction: presentIngestionNextAction(section.nextAction, t) };
}

/**
 * Consent next action — keyed by the consent STATE (the CLI prose for
 * `flag_on_without_grant` is operator-pitched English; the state is the
 * stable fact the UI already localizes).
 */
export function presentConsentNextAction(
  state: string,
  raw: string | undefined,
  t: TranslateFn,
): PresentedText | null {
  if (state === "flag_on_without_grant") {
    return { text: t("pages.ingestionStatus.nextActions.consentFlagOnWithoutGrant"), technical: raw?.trim() ?? null };
  }
  if (state === "unreadable") {
    return { text: t("pages.ingestionStatus.nextActions.consentUnreadable"), technical: raw?.trim() ?? null };
  }
  if (raw === undefined || raw.trim() === "") return null;
  return presentIngestionNextAction(raw, t);
}

/**
 * The not_wired row is a single hardcoded state on the CLI side today; its
 * explanation is fully localized here and the CLI prose moves to the
 * technical disclosure. No wire change, no speculative reasonCode.
 */
export function presentNotWired(
  t: TranslateFn,
  raw: { reason: string; nextAction: string },
): { reason: PresentedText; nextAction: PresentedText } {
  return {
    reason: { text: t("pages.ingestionStatus.notWiredReason"), technical: raw.reason.trim() },
    nextAction: { text: t("pages.ingestionStatus.notWiredNextAction"), technical: raw.nextAction.trim() },
  };
}

/**
 * Shorten a session identifier for the reading path. UUIDs are ASCII, so a
 * prefix slice cannot split a surrogate pair (EP-11); the full value stays in
 * the title attribute and the technical disclosure.
 */
export function shortIdentifier(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}
