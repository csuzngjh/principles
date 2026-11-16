import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { fetchIntentSummary, fetchIntentDecisionSummary, patchFeatureFlag, fetchIntentContent, fetchIntentVersions } from "../../api.js";
import type { IntentSummaryData, IntentDocWarningData, IntentDecisionSummaryData, IntentVersionEntry } from "../../api.js";
import { IntentEditor, CreateIntentButton, EditButton } from "./IntentOnboarding.js";
import { computeVersionDiff } from "@principles/core/runtime/intent-browser";
import { formatDate } from "../../utils/format-date.js";

// ── Page state ────────────────────────────────────────────────────────────────

type PageState = "loading" | "loaded" | "error";

// ── Sub-components ────────────────────────────────────────────────────────────

function FlagStatusBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  // SPEC §22.1.1: Intent Page must show intent_engineering flag status.
  // Badge has a text label, not color-only (SPEC §23.14.10).
  const label = enabled
    ? t("pages.intent.flagStatus.enabled")
    : t("pages.intent.flagStatus.disabled");
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[3px] text-caption font-mono border ${
        enabled
          ? "border-emerald/40 text-emerald bg-emerald/5"
          : "border-line text-ink-3 bg-surface"
      }`}
      role="status"
      aria-label={t("pages.intent.flagStatus.ariaLabel")}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-emerald" : "bg-ink-4"}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function EditEntry({ filePath }: { filePath: string }) {
  const { t } = useTranslation();
  // SPEC §22.1.1 line 1402: Intent Page must show "edit INTENT.md 入口".
  // INTENT.md is Owner-owned; PD never auto-modifies it. This entry only
  // surfaces the file path so the Owner can edit it in their own editor.
  return (
    <div className="bg-panel border border-line rounded-[6px] p-4">
      <h3 className="font-mono text-eyebrow uppercase tracking-[0.08em] text-ink-3 mb-2">
        {t("pages.intent.editEntry.title")}
      </h3>
      <p className="text-ink-3 text-body leading-relaxed mb-2">
        {t("pages.intent.editEntry.description")}
      </p>
      <div className="flex items-center gap-2">
        <code className="text-[12px] text-ink-2 bg-surface border border-line rounded-[3px] px-2 py-1 break-all">
          {filePath}
        </code>
        <button
          type="button"
          onClick={() => {
            // Copy to clipboard — Owner pastes into their editor.
            void navigator.clipboard?.writeText(filePath);
          }}
          className="shrink-0 border border-line bg-surface text-ink-2 rounded-[3px] px-2 py-1 text-caption hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          aria-label={t("pages.intent.editEntry.copyAriaLabel")}
        >
          {t("pages.intent.editEntry.copy")}
        </button>
      </div>
    </div>
  );
}

/**
 * FlagControlCard — SPEC-PD-INTENT-UNIFICATION-001 §10.4 (PRI-1236)
 *
 * The single intent_engineering switch, both directions, through the existing
 * PATCH /api/config/features/intent_engineering + patchFeatureFlag() — no
 * second API, no second flag.
 *
 * - Enable (flag off): one click, same as before.
 * - Disable (flag on): explicit confirmation dialog listing exactly what
 *   stops and what is preserved (eight effects, SPEC §10.3). Cancel changes
 *   nothing; confirm calls the same PATCH API. After ANY change the parent
 *   re-fetches the summary so the UI shows the PERSISTED configuration, and
 *   a failed call surfaces an error — never a fake success.
 */
interface FlagControlCardProps {
  flagEnabled: boolean;
  onAfterChange?: () => void;
  /**
   * CodeRabbit PR #2684 review: while the editor holds UNSAVED draft changes,
   * the flag switch must be inert — applyFlag's re-fetch would unmount the
   * editor and silently destroy the draft, bypassing the editor's own
   * discard-confirmation protection. Same rationale as the disabled language
   * selector during editing.
   */
  disabled?: boolean;
}

function FlagControlCard({ flagEnabled, onAfterChange, disabled = false }: FlagControlCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  async function applyFlag(enabled: boolean): Promise<boolean> {
    const res = await patchFeatureFlag("intent_engineering", enabled);
    if (!res.success) {
      toast.error(res.error ?? t(enabled ? "pages.intent.flagStatus.enableFailed" : "pages.intent.flagControl.disableFailed"));
      return false;
    }
    setAcknowledged(true);
    // Re-read the summary: the persisted config is the authority. If the flag
    // did not actually flip, the refreshed page state exposes it (no fake OK).
    onAfterChange?.();
    return true;
  }

  // Enable-side card (disabled state): keep the explanatory banner shape.
  if (!flagEnabled) {
    if (acknowledged) return null;
    return (
      <div className="bg-panel border border-amber/20 border-l-2 border-l-amber rounded-[6px] p-4 mb-5">
        <h2 className="text-ink text-reading font-semibold mb-2">
          {t("pages.intent.flagDisabled.title")}
        </h2>
        <p className="text-ink-3 text-body leading-relaxed mb-3">
          {t("pages.intent.flagDisabled.description")}
        </p>
        <button
          type="button"
          disabled={busy || disabled}
          data-testid="intent-flag-enable"
          onClick={async () => {
            setBusy(true);
            try {
              await applyFlag(true);
            } finally {
              setBusy(false);
            }
          }}
          className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-caption font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          aria-label={t("pages.intent.flagControl.enable")}
        >
          {busy ? t("pages.intent.flagControl.enabling") : t("pages.intent.flagControl.enable")}
        </button>
      </div>
    );
  }

  // Flag on: a quiet disable control (no banner — the feature is working).
  if (acknowledged) return null;
  return (
    <>
      <button
        type="button"
        disabled={busy || disabled}
        data-testid="intent-flag-disable"
        onClick={() => setShowDisableConfirm(true)}
        className="border border-line bg-surface text-ink-2 rounded-[3px] px-3 py-1.5 text-[12px] hover:border-line-2 transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        aria-label={t("pages.intent.flagControl.disable")}
      >
        {busy ? t("pages.intent.flagControl.disabling") : t("pages.intent.flagControl.disable")}
      </button>

      {showDisableConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="intent-disable-title"
          onClick={() => setShowDisableConfirm(false)}
          // CodeRabbit PR #2684 review (a11y): Escape closes the dialog; the
          // cancel button takes initial focus so keyboard users land inside
          // the dialog instead of behind the overlay.
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowDisableConfirm(false);
          }}
        >
          <div
            className="bg-surface border border-line rounded-[8px] p-5 max-w-[480px] w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p id="intent-disable-title" className="text-ink text-[14px] font-semibold mb-3">
              {t("pages.intent.flagControl.disableConfirmTitle")}
            </p>
            <ul className="space-y-1.5 mb-4">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <li key={n} className="text-ink-2 text-body leading-relaxed flex items-start gap-2">
                  <span className="text-ink-4 mt-1" aria-hidden="true">•</span>
                  {t(`pages.intent.flagControl.disableEffect${n}`)}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                autoFocus
                data-testid="intent-disable-cancel"
                onClick={() => setShowDisableConfirm(false)}
                className="border border-line bg-surface text-ink-2 rounded-[4px] px-3 py-1.5 text-[12px] hover:border-line-2 transition-colors"
              >
                {t("pages.intent.flagControl.disableConfirmCancel")}
              </button>
              <button
                type="button"
                data-testid="intent-disable-confirm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const ok = await applyFlag(false);
                    if (ok) setShowDisableConfirm(false);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="bg-red-600 text-white rounded-[4px] px-3 py-1.5 text-[12px] hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {busy ? t("pages.intent.flagControl.disabling") : t("pages.intent.flagControl.disableConfirmConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * IntentStatusHero — SPEC §11.3 (PRI-1235).
 *
 * One line answering: is Intent on? Is there valid content? How many sections
 * are filled? Six states with STRICT priority:
 *   1. Disabled  (!flagEnabled)
 *   2. Error     (flag on, !ok, reason read_error/parse_error/oversized)
 *   3. Missing   (flag on, !found / reason not_found)
 *   4. Template Only / Incomplete / Configured (ok, by contentReadiness)
 *
 * Missing/Error can NEVER be displayed as Template Only — they are keyed off
 * flagEnabled/found/ok/reason, not off contentReadiness.
 */
type IntentUiState = 'disabled' | 'error' | 'missing' | 'templateOnly' | 'incomplete' | 'configured';

function deriveIntentUiState(summary: IntentSummaryData): IntentUiState {
  if (!summary.flagEnabled) return 'disabled';
  if (!summary.ok) {
    if (summary.reason === 'not_found') return 'missing';
    return 'error';
  }
  if (summary.contentReadiness === 'configured') return 'configured';
  if (summary.contentReadiness === 'incomplete') return 'incomplete';
  return 'templateOnly';
}

const INTENT_STATE_STYLE: Record<IntentUiState, string> = {
  disabled: 'border-line text-ink-3 bg-surface',
  error: 'border-red-200 text-red-700 bg-red-50',
  missing: 'border-line text-ink-3 bg-surface',
  templateOnly: 'border-amber/40 text-amber bg-amber/5',
  incomplete: 'border-gov/40 text-gov bg-gov/5',
  configured: 'border-emerald/40 text-emerald bg-emerald/5',
};

function IntentStatusHero({ summary }: { summary: IntentSummaryData }) {
  const { t } = useTranslation();
  const state = deriveIntentUiState(summary);
  const labelKey = `pages.intent.status.${
    state === 'templateOnly' ? 'templateOnly' : state
  }`;
  return (
    <div className="flex flex-wrap items-center gap-3 mb-5" data-intent-state={state}>
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[3px] text-caption font-mono border ${INTENT_STATE_STYLE[state]}`}
        role="status"
        aria-label={t("pages.intent.status.ariaLabel")}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            state === 'configured' || state === 'incomplete' ? 'bg-emerald' : state === 'error' ? 'bg-red-500' : 'bg-ink-4'
          }`}
          aria-hidden="true"
        />
        {t(labelKey)}
      </span>
      {summary.ok && (
        <span className="text-ink-2 text-body font-mono" data-testid="intent-section-count">
          {t("pages.intent.status.sectionCount", { count: summary.usableSectionCount })}
        </span>
      )}
    </div>
  );
}

/**
 * SectionStateChip — SPEC §11.4: each section shows whether it is filled,
 * template placeholder, or missing. States come from the SERVER projection
 * (Core classification); the UI never re-implements template matching.
 */
function SectionStateChip({ state }: { state: 'authored' | 'placeholder' | 'missing' | undefined }) {
  const { t } = useTranslation();
  if (state === undefined) return null;
  const resolved = state as 'authored' | 'placeholder' | 'missing';
  const style =
    resolved === 'authored'
      ? 'border-emerald/40 text-emerald bg-emerald/5'
      : resolved === 'placeholder'
        ? 'border-amber/40 text-amber bg-amber/5'
        : 'border-line text-ink-4 bg-surface';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-[2px] text-[11px] font-mono border shrink-0 ${style}`}>
      {t(`pages.intent.sectionStates.${resolved}`)}
    </span>
  );
}

/**
 * UsageCard — SPEC §11.7: a short, honest explanation of what Intent does
 * and what it is NOT (not a RuleCode, not host execution permission).
 */
function UsageCard() {
  const { t } = useTranslation();
  return (
    <section className="mt-8" aria-labelledby="section-usage">
      <SectionTitle id="section-usage">
        {t("pages.intent.usage.title")}
      </SectionTitle>
      <div className="bg-panel border border-line rounded-[6px] p-4">
        <ul className="space-y-1.5 mb-3">
          {[1, 2, 3, 4, 5].map((n) => (
            <li key={n} className="text-ink-2 text-body leading-relaxed flex items-start gap-2">
              <span className="text-gov mt-0.5" aria-hidden="true">•</span>
              {t(`pages.intent.usage.line${n}`)}
            </li>
          ))}
        </ul>
        <p className="text-ink-3 text-body leading-relaxed border-t border-line pt-3">
          {t("pages.intent.usage.note")}
        </p>
      </div>
    </section>
  );
}

function NotFoundBanner({ onCreated, lang }: { onCreated: (openEditor: boolean) => void; lang: 'zh-CN' | 'en' }) {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-5">
      <h2 className="text-ink text-reading font-semibold mb-2">
        {t("pages.intent.notFound.title")}
      </h2>
      <p className="text-ink-3 text-body leading-relaxed mb-3">
        {t("pages.intent.notFound.description")}
      </p>
      <div className="flex items-center gap-3">
        <CreateIntentButton onCreated={onCreated} showOnboarding={true} lang={lang} />
        <span className="text-ink-4 text-[12px] font-mono">
          {t("pages.intent.notFound.nextAction")}
        </span>
      </div>
    </div>
  );
}

function OversizedBanner() {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-amber/30 rounded-[6px] p-5">
      <h2 className="text-ink text-reading font-semibold mb-2">
        {t("pages.intent.oversized.title")}
      </h2>
      <p className="text-ink-3 text-body leading-relaxed mb-3">
        {t("pages.intent.oversized.description")}
      </p>
      <div className="font-mono text-[12px] text-ink-2 bg-surface border border-line rounded-[3px] px-3 py-2">
        {t("pages.intent.oversized.nextAction")}
      </div>
    </div>
  );
}

function WarningItem({ warning }: { warning: IntentDocWarningData }) {
  const { t } = useTranslation();
  // SPEC: warnings are rendered as governance hints via i18n code key,
  // not raw server-side English message text (P2 i18n fix).
  const labelKey = `pages.intent.warnings.${warning.code}`;
  return (
    <li className="flex items-start gap-2 text-ink-2 text-body">
      <span className="text-amber shrink-0 mt-0.5" aria-hidden="true">!</span>
      <span>
        <span className="font-medium">{t(labelKey)}</span>
        {warning.section && (
          <span className="text-ink-3 font-mono ml-2">[{warning.section}]</span>
        )}
      </span>
    </li>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-eyebrow uppercase tracking-[0.08em] text-ink-3 w-32 shrink-0">
        {label}
      </span>
      <span className="text-ink-2 text-[12px] font-mono break-all">{value}</span>
    </div>
  );
}

// ── Version history entry with section-level diff ────────────────────────────

interface VersionEntryProps {
  version: IntentVersionEntry;
  /** Content of the previous version (for diff). Empty string for the oldest version. */
  previousContent: string;
  /** Localized reason label */
  reasonLabel: string;
  /** Whether this entry should be expanded by default (e.g. newest version) */
  defaultExpanded?: boolean;
}

function VersionEntry({ version, previousContent, reasonLabel, defaultExpanded = false }: VersionEntryProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Compute section-level diff between previous and this version.
  // For the oldest version (no previous), diff against "" so all non-empty
  // sections show as "changed" — gives the user a visual of what was filled.
  const diff = computeVersionDiff(previousContent, version.contentSnapshot);

  // Localize the timestamp for display (avoid showing raw UTC to end users).
  const localizedTime = formatDate(version.createdAt, i18n.language, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-3 py-1.5 text-[12px] font-mono text-ink-2 hover:bg-surface-2/50 transition-colors text-left"
        aria-expanded={expanded}
        aria-label={expanded ? t("pages.intent.versionDiff.collapseHint") : t("pages.intent.versionDiff.expandHint")}
        title={version.contentHash}
      >
        <span className="text-ink-3 shrink-0 w-4 inline-block">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="text-ink-3 shrink-0">{localizedTime}</span>
        <span className="px-1.5 py-0.5 rounded-[2px] bg-surface-2 text-ink-3 shrink-0">
          {reasonLabel}
        </span>
        <span className="text-ink-4 text-caption ml-auto shrink-0 hidden sm:inline">
          {expanded ? t("pages.intent.versionDiff.collapseHint") : t("pages.intent.versionDiff.expandHint")}
        </span>
      </button>
      {expanded && (
        <div className="pb-2.5 pl-7 pr-2">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {diff.map((d) => {
              // d.section is one of the 5 section keys from computeVersionDiff's
              // SECTION_KEYS — safe to construct the i18n key dynamically.
              const labelKey = `pages.intent.wizard.stepLabels.${d.section}`;
              return (
                <span
                  key={d.section}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] text-caption font-mono border ${
                    d.changed
                      ? "border-amber/40 text-amber bg-amber/5"
                      : "border-line text-ink-3 bg-surface"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${d.changed ? "bg-amber" : "bg-ink-4"}`}
                    aria-hidden="true"
                  />
                  {t(labelKey)}
                  <span className="text-ink-4 ml-0.5">
                    {d.changed ? t("pages.intent.versionDiff.changed") : t("pages.intent.versionDiff.unchanged")}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Decision Summary Section (SPEC §22.1.1) ──────────────────────────────────
// Lightweight audit summary derived from IntentDecisionRecord. NOT a dashboard.
// Only aggregate counts per ownerAction + lastDecisionAt are shown.
// SPEC forbids displaying metrics that cannot be traced back to IntentDecisionRecord.

type DecisionSummaryState = "loading" | "loaded" | "error";

// Static mapping from ownerAction enum value to its i18n label key.
// Avoids dynamic string construction so i18n extraction tools can find keys.
const DECISION_COUNT_LABEL_KEYS: ReadonlyArray<{
  action: keyof IntentDecisionSummaryData["counts"];
  labelKey: string;
}> = [
  { action: "confirm_drift", labelKey: "pages.intent.decisions.countConfirmDrift" },
  { action: "revise_intent", labelKey: "pages.intent.decisions.countReviseIntent" },
  { action: "observe", labelKey: "pages.intent.decisions.countObserve" },
  { action: "dismiss", labelKey: "pages.intent.decisions.countDismiss" },
  { action: "promote_to_principle", labelKey: "pages.intent.decisions.countPromoteToPrinciple" },
  { action: "promote_to_rulehost", labelKey: "pages.intent.decisions.countPromoteToRulehost" },
];

function DecisionSummarySection() {
  const { t } = useTranslation();
  const [state, setState] = useState<DecisionSummaryState>("loading");
  const [summary, setSummary] = useState<IntentDecisionSummaryData | null>(null);

  const loadSummary = useCallback(async () => {
    setState("loading");
    const result = await fetchIntentDecisionSummary();
    if (!result.success) {
      // ERR-002: graceful degradation with reason; section collapses to a single line.
      setState("error");
      return;
    }
    setSummary(result.data);
    setState("loaded");
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  return (
    <section className="mt-8" aria-labelledby="section-decisions">
      <SectionTitle id="section-decisions">
        {t("pages.intent.decisions.sectionTitle")}
      </SectionTitle>
      <p className="text-ink-3 text-body leading-relaxed mb-3">
        {t("pages.intent.decisions.sectionSubtitle")}
      </p>
      {state === "loading" && (
        <div className="bg-panel border border-line rounded-[6px] p-4 text-ink-3 text-body">
          {t("common.loading")}
        </div>
      )}
      {state === "error" && (
        <div className="bg-panel border border-line rounded-[6px] p-4 text-ink-3 text-body">
          {t("pages.intent.decisions.loadError")}
        </div>
      )}
      {state === "loaded" && summary && (
        <div className="bg-panel border border-line rounded-[6px] p-4">
          {/* Counts per ownerAction — SPEC §22.1.1: zero counts are still rendered (audit clarity). */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {DECISION_COUNT_LABEL_KEYS.map(({ action, labelKey }) => {
              const count = summary.counts[action];
              return (
                <div key={action} className="flex items-baseline gap-2">
                  <dt className="text-ink-3 text-[12px]">{t(labelKey)}</dt>
                  <dd className="text-ink font-mono text-body">{count}</dd>
                </div>
              );
            })}
          </dl>
          {/* lastDecisionAt — null means "no decisions recorded yet" */}
          <div className="mt-4 pt-3 border-t border-line">
            {summary.lastDecisionAt === null ? (
              <p className="text-ink-4 text-[12px]">{t("pages.intent.decisions.noDecisions")}</p>
            ) : (
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-eyebrow uppercase tracking-[0.08em] text-ink-3">
                  {t("pages.intent.decisions.lastDecisionAtLabel")}
                </span>
                <span className="text-ink-2 text-[12px] font-mono break-all">{summary.lastDecisionAt}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

export function IntentPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<IntentSummaryData | null>(null);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // PRI-477: inline editor state
  const [isEditing, setIsEditing] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  // Bilingual: language selector state
  const [lang, setLang] = useState<'zh-CN' | 'en'>('zh-CN');
  // Version history
  const [versions, setVersions] = useState<IntentVersionEntry[]>([]);

  // Map raw backend reason codes to localized labels for the version history panel.
  // Unknown reasons fall back to the raw string (observability over silent masking).
  const versionReasonLabel = useCallback((reason: string): string => {
    if (reason === 'init') return t("pages.intent.versionHistory.reasonInit");
    if (reason === 'save') return t("pages.intent.versionHistory.reasonSave");
    return reason;
  }, [t]);

  const loadData = useCallback(async () => {
    setPageState("loading");
    setErrorMsg(null);
    const result = await fetchIntentSummary(lang);
    if (!result.success) {
      // ERR-002: graceful degradation with reason
      setErrorMsg(result.error ?? t("pages.intent.loadError"));
      setPageState("error");
      return;
    }
    // result.data is already validated by validateIntentSummary in the API layer
    setData(result.data);
    setPageState("loaded");
    // Load version history in parallel (best-effort, never blocks page)
    fetchIntentVersions(lang).then(v => {
      if (v.success && v.data?.versions) {
        setVersions(v.data.versions);
      }
    }).catch(() => { /* best-effort */ });
  }, [t, lang]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // P0 fix: when language changes, reset editor state and stale versions.
  // Without this, switching language while editing would keep the editor open
  // with the old language's content — and saving would write that content
  // into the NEW language's file (data corruption).
  // Also clears stale versions so the panel doesn't show the old language's
  // history while the new language's fetch is in flight or has failed.
  useEffect(() => {
    setIsEditing(false);
    setEditorContent("");
    setVersions([]);
  }, [lang]);

  // PRI-477: Called when user clicks "Edit" — fetch raw content and open editor
  const handleStartEdit = useCallback(async () => {
    setEditorLoading(true);
    const result = await fetchIntentContent(lang);
    setEditorLoading(false);
    if (!result.success) {
      toast.error(t("pages.intent.loadError"));
      return;
    }
    setEditorContent(result.data.content);
    setIsEditing(true);
  }, [t, lang]);

  // PRI-477: Called when template is created — refresh summary; optionally
  // open the editor immediately so the user can start filling.
  //
  // PR-1083 review (CodeRabbit A5): `openEditor` lets CreateIntentButton
  // distinguish "Start filling" (open editor) from "Skip" (just refresh the
  // summary so NotFoundBanner re-renders to the sections view — otherwise the
  // user would see a stale "file not found" banner even though INTENT.md now
  // exists on disk).
  const handleCreated = useCallback(async (openEditor: boolean) => {
    await loadData();
    if (!openEditor) return;
    setEditorLoading(true);
    const result = await fetchIntentContent(lang);
    setEditorLoading(false);
    if (result.success) {
      setEditorContent(result.data.content);
      setIsEditing(true);
    }
  }, [loadData, lang]);

  // PRI-477: Called after successful save — close editor and refresh summary
  const handleSaved = useCallback(() => {
    setIsEditing(false);
    void loadData();
  }, [loadData]);

  // PRI-477: Called when user cancels editing
  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  // ── Loading state ────────────────────────────────────────────────────────
  if (pageState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (pageState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.intent.eyebrow")}
        </div>
        <h1 className="text-display font-semibold tracking-tight text-ink mb-2">
          {t("pages.intent.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.intent.loadError")}</p>
          {errorMsg && (
            <p className="mt-2 text-ink-4 text-body font-mono">{errorMsg}</p>
          )}
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={loadData}
            className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-caption hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("common.refresh")}
          </button>
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const summary = data;

  return (
    <PageShell>
      <div>
        {/* Layer 1: Conclusion — eyebrow + title + subtitle + flag badge */}
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.intent.eyebrow")}
        </div>
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-display font-semibold tracking-tight text-ink">
            {t("pages.intent.title")}
          </h1>
          {summary && (
            <FlagStatusBadge enabled={summary.flagEnabled} />
          )}
          {/* PRI-1236: the single flag switch. Flag-on shows the compact
              disable control here; the flag-off banner renders below.
              CodeRabbit review: inert while the editor holds an unsaved
              draft — applyFlag's re-fetch would destroy it. */}
          {summary && summary.flagEnabled && (
            <FlagControlCard
              flagEnabled={summary.flagEnabled}
              onAfterChange={() => void loadData()}
              disabled={isEditing || editorLoading}
            />
          )}
          {/* Bilingual language selector
              Disabled while editing to prevent silent loss of unsaved changes.
              The P0 useEffect on [lang] resets editor state on lang change —
              without disabling, switching lang mid-edit would discard the
              user's draft with no confirmation. */}
          <select
            value={lang}
            data-testid="intent-lang-select"
            onChange={(e) => setLang(e.target.value as 'zh-CN' | 'en')}
            disabled={isEditing || editorLoading}
            className="ml-auto border border-line bg-surface text-ink-2 rounded-[3px] px-2 py-1 text-[12px] font-mono focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={t("pages.intent.langSelector.ariaLabel")}
            title={isEditing || editorLoading ? t("pages.intent.langSelector.disabledWhileEditing") : undefined}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
          {t("pages.intent.subtitle")}
        </p>

        {/* PRI-1235 / SPEC §11.3: six-state status hero — strict priority
            Disabled → Error → Missing → TemplateOnly/Incomplete/Configured. */}
        {summary && <IntentStatusHero summary={summary} />}

        {/* Flag-disabled short-circuit — spec §13.5: interactive toggle */}
        {summary && !summary.flagEnabled && (
          <FlagControlCard
            flagEnabled={summary.flagEnabled}
            onAfterChange={() => void loadData()}
            disabled={isEditing || editorLoading}
          />
        )}

        {/* Flag-on but file not found — PRI-477: add Create button + onboarding */}
        {summary && summary.flagEnabled && !summary.found && summary.reason === "not_found" && (
          <NotFoundBanner onCreated={handleCreated} lang={lang} />
        )}

        {/* Flag-on but oversized */}
        {summary && summary.flagEnabled && summary.found && summary.reason === "oversized" && (
          <OversizedBanner />
        )}

        {/* Flag-on and valid — show sections OR inline editor (PRI-477) */}
        {summary && summary.flagEnabled && summary.ok && summary.sections && (
          <>
            {/* PRI-477: Inline editor — shown when user clicks "Edit" */}
            {isEditing && (
              <section aria-labelledby="section-editor" className="mb-8">
                {/* N2 (PR-1083 review): outer SectionTitle removed — IntentEditor
                    already renders its own `<h3 id="section-editor">` carrying the
                    title. Having two visible "Edit INTENT.md" titles was confusing. */}
                <IntentEditor
                  initialContent={editorContent}
                  onSaved={handleSaved}
                  onCancel={handleCancelEdit}
                  lang={lang}
                />
              </section>
            )}

            {/* Read-only sections — shown when NOT editing */}
            {!isEditing && (
              <>
                <section aria-labelledby="section-content">
                  <div className="flex items-center justify-between mb-3">
                    <SectionTitle id="section-content">
                      {t("pages.intent.title")}
                    </SectionTitle>
                    {/* PRI-477 + A7 review: pass editorLoading so the button
                        disables + switches its label while fetchIntentContent()
                        is in flight, preventing double-clicks and giving the
                        user immediate feedback. */}
                    <EditButton onClick={handleStartEdit} loading={editorLoading} />
                  </div>
                  <div className="bg-panel border border-line rounded-[6px] p-5 space-y-5">
                    {([
                      ['why', summary.sections.why],
                      ['desiredOutcome', summary.sections.desiredOutcome],
                      ['nonNegotiables', summary.sections.nonNegotiables],
                      ['stopEscalation', summary.sections.stopEscalation],
                      ['currentStrategicFocus', summary.sections.currentStrategicFocus],
                    ] as const).map(([key, content]) => (
                      <div key={key}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <SectionStateChip state={summary.sectionStates?.[key]} />
                          <span className="font-mono text-eyebrow uppercase tracking-[0.08em] text-ink-3">
                            {t(`pages.intent.sections.${key}`)}
                          </span>
                        </div>
                        {content !== undefined && content.trim() !== '' && (
                          <p className="text-ink-2 text-body leading-relaxed whitespace-pre-wrap">{content}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>

                {/* PRI-1235 / SPEC §11.7: usage explanation */}
                <UsageCard />

                {/* Health warnings */}
                <section className="mt-8" aria-labelledby="section-warnings">
                  <SectionTitle id="section-warnings">
                    {t("pages.intent.warnings.title")}
                  </SectionTitle>
                  {summary.warnings.length === 0 ? (
                    <p className="text-ink-3 text-body leading-relaxed">
                      {t("pages.intent.warnings.empty")}
                    </p>
                  ) : (
                    <ul className="bg-panel border border-line rounded-[6px] p-4 space-y-2">
                      {summary.warnings.map((w, i) => (
                        <WarningItem key={i} warning={w} />
                      ))}
                    </ul>
                  )}
                </section>

                {/* Meta */}
                <section className="mt-8" aria-labelledby="section-meta">
                  <SectionTitle id="section-meta">
                    {t("pages.intent.meta.title")}
                  </SectionTitle>
                  <div className="bg-panel border border-line rounded-[6px] p-4 space-y-2">
                    {summary.lastEditedAt && (
                      <MetaRow label={t("pages.intent.meta.lastEditedAt")} value={summary.lastEditedAt} />
                    )}
                    {summary.contentHash && (
                      <MetaRow label={t("pages.intent.meta.contentHash")} value={summary.contentHash} />
                    )}
                    {summary.path && (
                      <MetaRow label={t("pages.intent.meta.path")} value={summary.path} />
                    )}
                  </div>
                </section>

                {/* Edit entry — SPEC §22.1.1 line 1402 (legacy file-path entry, kept for CLI users) */}
                {summary.path && (
                  <section className="mt-8" aria-labelledby="section-edit">
                    <SectionTitle id="section-edit">
                      {t("pages.intent.editEntry.heading")}
                    </SectionTitle>
                    <EditEntry filePath={summary.path} />
                  </section>
                )}
              </>
            )}
          </>
        )}

        {/* Flag-on but other error (read_error / parse_error) */}
        {summary && summary.flagEnabled && !summary.ok && summary.reason && summary.reason !== "not_found" && summary.reason !== "oversized" && (
          <div className="bg-panel border border-red-200 rounded-[6px] p-5">
            <h2 className="text-ink text-reading font-semibold mb-2">
              {t("pages.intent.loadError")}
            </h2>
            <p className="text-ink-3 text-body leading-relaxed mb-3 font-mono">
              {summary.reason}
            </p>
            {summary.nextAction && (
              <p className="text-ink-2 text-body leading-relaxed">
                {summary.nextAction}
              </p>
            )}
          </div>
        )}

        {/* Decision Summary — SPEC §22.1.1: bottom section, shown when flag is on.
            Decisions are persisted independently of INTENT.md state, so this
            section appears regardless of whether INTENT.md was found/OK. */}
        {summary && summary.flagEnabled && (
          <DecisionSummarySection />
        )}

        {/* Version History — shows saved INTENT.md versions from SQLite.
            Each entry is expandable to show section-level diff (Task 5). */}
        {versions.length > 0 && (
          <details className="border border-line rounded-[3px] mt-6">
            <summary className="cursor-pointer px-4 py-2 text-body font-medium text-ink-2 select-none">
              {t("pages.intent.versionHistory.title")} ({versions.length})
            </summary>
            <div className="px-4 py-2 border-t border-line">
              {versions.map((v, idx) => {
                // versions are sorted newest-first; previous = idx + 1.
                // For the oldest version (no previous), diff against "" so
                // all filled sections show as "changed".
                const previousContent = versions[idx + 1]?.contentSnapshot ?? "";
                return (
                  <VersionEntry
                    key={v.id}
                    version={v}
                    previousContent={previousContent}
                    reasonLabel={versionReasonLabel(v.reason)}
                    defaultExpanded={idx === 0}
                  />
                );
              })}
            </div>
          </details>
        )}
      </div>
    </PageShell>
  );
}