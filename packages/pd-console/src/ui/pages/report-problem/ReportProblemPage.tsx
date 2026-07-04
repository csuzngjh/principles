import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  createFeedbackReport,
  listFeedbackReports,
  getFeedbackReport,
  deleteFeedbackReport,
  fetchConfigSummary,
  request,
} from "../../api.js";
import { enumLabel } from "../../utils/enum-labels.js";
import {
  parseDraftRecord,
  parseDraftSummary,
  parseEnvelopeReport,
  getErrorMessage,
  buildFeedbackContextFromSearchParams,
  buildFeedbackDiagnostics,
} from "../ReportProblemValidators.js";
import type { FeedbackDraftSummary, DraftRecord, FeedbackType, UserSeverity } from "../ReportProblemValidators.js";

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  type: FeedbackType;
  severity: UserSeverity | undefined;
  title: string;
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  submitting: boolean;
}

const INITIAL_FORM: FormState = {
  type: "bug",
  severity: undefined,
  title: "",
  description: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
  submitting: false,
};

const FEEDBACK_TYPES: FeedbackType[] = ["bug", "confusing", "privacy_concern", "feature_request", "other"];
const SEVERITY_OPTIONS: UserSeverity[] = ["low", "medium", "high"];
const VALID_FEEDBACK_TYPES = new Set<string>(FEEDBACK_TYPES);
const VALID_SEVERITY_OPTIONS = new Set<string>(SEVERITY_OPTIONS);

// ── Runtime validator for drafts list envelope (H section / ERR-001/005/009) ─

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DraftsListResult =
  | { ok: true; drafts: FeedbackDraftSummary[] }
  | { ok: false; reason: string };

function validateDraftsList(raw: unknown): DraftsListResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "Drafts list response is not an object" };
  }
  if (!Object.hasOwn(raw, "drafts")) {
    return { ok: false, reason: "Drafts list response missing 'drafts' field" };
  }
  if (!Array.isArray(raw.drafts)) {
    return { ok: false, reason: "Drafts list 'drafts' field is not an array" };
  }
  const result: FeedbackDraftSummary[] = [];
  for (const item of raw.drafts) {
    const parsed = parseDraftSummary(item);
    if (parsed !== null) {
      result.push(parsed);
    }
  }
  return { ok: true, drafts: result };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NoAutoUploadBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 px-4 py-3 bg-gov/8 border border-gov/20 rounded-[6px] mb-6">
      <svg
        className="shrink-0 w-4 h-4 text-gov"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
      <span className="text-ink text-sm font-medium">{t("pages.reportProblem.noAutoUpload")}</span>
    </div>
  );
}

function PrivacySection({ draft }: { draft: DraftRecord | null }) {
  const { t } = useTranslation();

  if (draft === null) {
    return (
      <section className="mt-8" aria-labelledby="section-privacy">
        <SectionTitle id="section-privacy">{t("pages.reportProblem.privacy.title")}</SectionTitle>
        <p className="text-ink-3 text-[13px] leading-relaxed">
          {t("pages.reportProblem.privacy.submitFirst")}
        </p>
        <NoAutoUploadBanner />
      </section>
    );
  }

  return (
    <section className="mt-8" aria-labelledby="section-privacy">
      <SectionTitle id="section-privacy">{t("pages.reportProblem.privacy.title")}</SectionTitle>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-4">
        {t("pages.reportProblem.privacy.description")}
      </p>

      <div className="bg-panel border border-line rounded-[6px] p-4 space-y-4">
        {/* Included */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
            {t("pages.reportProblem.privacy.included")}
          </h3>
          {draft.privacy.includedSections.length > 0 ? (
            <ul className="space-y-1">
              {draft.privacy.includedSections.map((section, i) => (
                <li key={i} className="flex items-center gap-2 text-ink-2 text-[13px]">
                  <span className="text-green-600" aria-hidden="true">✓</span>
                  {section}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-4 text-[13px]">—</p>
          )}
        </div>

        {/* Excluded */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
            {t("pages.reportProblem.privacy.excluded")}
          </h3>
          {draft.privacy.excludedByDefault.length > 0 ? (
            <ul className="space-y-1">
              {draft.privacy.excludedByDefault.map((section, i) => (
                <li key={i} className="flex items-center gap-2 text-ink-2 text-[13px]">
                  <span className="text-red-500" aria-hidden="true">✗</span>
                  {section}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-4 text-[13px]">—</p>
          )}
        </div>

        {/* Redaction notes */}
        {draft.privacy.redactionNotes.length > 0 && (
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
              {t("pages.reportProblem.privacy.notes")}
            </h3>
            <ul className="space-y-1">
              {draft.privacy.redactionNotes.map((note, i) => (
                <li key={i} className="text-ink-2 text-[13px]">• {note}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <NoAutoUploadBanner />
    </section>
  );
}

function DraftCard({ draft, onCopyMarkdown, onCopyEmail, onOpenGithub, onOpenEmail, onDelete }: {
  draft: DraftRecord;
  onCopyMarkdown: () => void;
  onCopyEmail: () => void;
  onOpenGithub: () => void;
  onOpenEmail: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <article className="bg-panel border border-line rounded-[6px] p-4">
      <div className="font-mono text-[11px] text-ink-3 mb-2">
        {t("pages.reportProblem.draft.savedAt", { id: draft.id, at: draft.createdAt })}
      </div>
      <div className="font-semibold text-ink mb-3">{draft.title}</div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCopyMarkdown}
          className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.reportProblem.draft.copyMarkdown")}
        </button>
        <button
          type="button"
          onClick={onCopyEmail}
          className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.reportProblem.draft.copyEmail")}
        </button>
        {draft.outputs.githubIssueUrl && (
          <button
            type="button"
            onClick={onOpenGithub}
            className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.draft.openGithub")}
          </button>
        )}
        {draft.outputs.mailtoUrl && (
          <button
            type="button"
            onClick={onOpenEmail}
            className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.draft.openEmail")}
          </button>
        )}
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="border border-red-200 text-red-600 rounded-[3px] px-[12px] py-[5px] text-[12px] hover:bg-red-50 transition-colors focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.draft.delete")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onDelete}
              className="border border-red-400 bg-red-600 text-white rounded-[3px] px-[12px] py-[5px] text-[12px] hover:bg-red-700 transition-colors focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
            >
              {t("pages.reportProblem.draft.delete")}?
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors"
            >
              ×
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function SavedDraftsSection({ drafts, onLoad, onDelete }: {
  drafts: FeedbackDraftSummary[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="mt-8" aria-labelledby="section-saved">
      <SectionTitle id="section-saved">{t("pages.reportProblem.saved.title")}</SectionTitle>
      {drafts.length === 0 ? (
        <p className="text-ink-3 text-[13px] leading-relaxed py-2">
          —
        </p>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => (
            <article key={draft.id} className="bg-panel border border-line rounded-[6px] px-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-ink-3 mb-1">
                  {enumLabel('feedbackType', draft.type, t)} · {draft.createdAt}
                </div>
                <div className="text-ink text-sm truncate">{draft.title}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onLoad(draft.id)}
                  className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                >
                  {t("pages.reportProblem.saved.load")}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(draft.id)}
                  className="border border-red-200 text-red-600 rounded-[3px] px-[10px] py-[6px] text-[12px] hover:bg-red-50 transition-colors focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
                >
                  {t("pages.reportProblem.draft.delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function ReportProblemPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [drafts, setDrafts] = useState<FeedbackDraftSummary[]>([]);
  const [currentDraft, setCurrentDraft] = useState<DraftRecord | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Task 6: read context identifiers (painId, principleId, approvalId,
  // activationId, taskId, source, page) from URL query params so the feedback
  // report can be associated with the originating entity.
  const contextFromUrl = useMemo(
    () => buildFeedbackContextFromSearchParams(searchParams),
    [searchParams],
  );

  // ── Load drafts on mount ─────────────────────────────────────────────────
  const loadDrafts = useCallback(async () => {
    const result = await listFeedbackReports();
    if (!result.success) {
      // ERR-002: graceful degradation with reason
      setLoadError(result.error ?? "Failed to load drafts");
      setLoadingState("loaded");
      return;
    }
    const validated = validateDraftsList(result.data);
    if (!validated.ok) {
      setLoadError(validated.reason);
      setDrafts([]);
      setLoadingState("loaded");
      return;
    }
    setDrafts(validated.drafts);
    setLoadError(null);
    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  // ── Form handlers ────────────────────────────────────────────────────────
  const handleFieldChange = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.title.trim() || !form.description.trim()) {
      toast.error(t("pages.reportProblem.errors.missingRequired"));
      return;
    }

    setForm((prev) => ({ ...prev, submitting: true }));

    try {
      const input = {
        type: form.type,
        title: form.title.trim(),
        description: form.description.trim(),
        stepsToReproduce: form.stepsToReproduce.trim() || undefined,
        expectedBehavior: form.expectedBehavior.trim() || undefined,
        actualBehavior: form.actualBehavior.trim() || undefined,
        severity: form.severity,
        // P0-1: 传递顶层 taskId 触发 agentDraft 合并（Task 13）
        // contextFromUrl.taskId 来自 URL query（FailedTasksPage 跳转时传入）
        // createFeedbackReport 检查 draft.taskId（顶层）决定是否从 pending_agent_drafts 表读取
        ...(contextFromUrl?.taskId ? { taskId: contextFromUrl.taskId } : {}),
        ...(contextFromUrl ? { context: contextFromUrl } : {}),
      };

      // ── Collect diagnostics concurrently (Task 5) ───────────────────────
      // Fetch three APIs in parallel; Promise.allSettled ensures a single
      // failure doesn't block the others. buildFeedbackDiagnostics then
      // assembles a diagnostics object with unavailableReason for each failed
      // field (rc-9-no-silent-fallback).
      const [configSettled, lifecycleSettled, healthSettled] = await Promise.allSettled([
        fetchConfigSummary(),
        request('/api/v1/lifecycle/state'),
        request('/api/health'),
      ]);
      const diagnostics = buildFeedbackDiagnostics(
        configSettled,
        lifecycleSettled,
        healthSettled,
      );

      const result = await createFeedbackReport(input, diagnostics);

      if (!result.success) {
        toast.error(getErrorMessage(result, t("pages.reportProblem.errors.createFailed")));
        setForm((prev) => ({ ...prev, submitting: false }));
        return;
      }

      // Validate response with parseEnvelopeReport (ERR-001/005/009)
      const parsed = parseEnvelopeReport(result.data);
      if (parsed === null) {
        // Try parseDraftRecord directly as fallback — no `as` cast (ERR-001/005)
        let directParsed: DraftRecord | null = null;
        if (isRecord(result.data) && Object.hasOwn(result.data, "report")) {
          const reportValue = result.data["report"];
          directParsed = parseDraftRecord(reportValue);
        } else {
          directParsed = parseDraftRecord(result.data);
        }

        if (directParsed === null) {
          toast.error(t("pages.reportProblem.errors.createFailed"));
          setForm((prev) => ({ ...prev, submitting: false }));
          return;
        }
        setCurrentDraft(directParsed);
      } else {
        setCurrentDraft(parsed);
      }

      toast.success(t("pages.reportProblem.toast.draftCreated"));

      // Reset form
      setForm(INITIAL_FORM);
      setShowPreview(false);

      // Reload drafts list
      await loadDrafts();
    } catch {
      toast.error(t("pages.reportProblem.errors.createFailed"));
    } finally {
      setForm((prev) => ({ ...prev, submitting: false }));
    }
  }, [form, t, loadDrafts, contextFromUrl]);

  // ── Draft actions ────────────────────────────────────────────────────────
  const handleLoadDraft = useCallback(async (id: string) => {
    const result = await getFeedbackReport(id);
    if (!result.success) {
      toast.error(t("pages.reportProblem.toast.loadFailed"));
      return;
    }
    const parsed = parseEnvelopeReport(result.data);
    if (parsed === null) {
      toast.error(t("pages.reportProblem.toast.loadFailed"));
      return;
    }
    setCurrentDraft(parsed);
    setForm({
      type: parsed.type,
      severity: parsed.userText.userSeverity,
      title: parsed.title,
      description: parsed.userText.description,
      stepsToReproduce: parsed.userText.stepsToReproduce ?? "",
      expectedBehavior: parsed.userText.expectedBehavior ?? "",
      actualBehavior: parsed.userText.actualBehavior ?? "",
      submitting: false,
    });
  }, [t]);

  const handleCopyMarkdown = useCallback(async (draft: DraftRecord) => {
    try {
      await navigator.clipboard.writeText(draft.outputs.markdown);
      toast.success(t("pages.reportProblem.toast.markdownCopied"));
    } catch {
      toast.error(t("pages.reportProblem.toast.copyFailed"));
    }
  }, [t]);

  const handleCopyEmail = useCallback(async (draft: DraftRecord) => {
    try {
      await navigator.clipboard.writeText(draft.outputs.emailText);
      toast.success(t("pages.reportProblem.toast.emailCopied"));
    } catch {
      toast.error(t("pages.reportProblem.toast.copyFailed"));
    }
  }, [t]);

  const handleOpenGithub = useCallback((draft: DraftRecord) => {
    if (draft.outputs.githubIssueUrl) {
      window.open(draft.outputs.githubIssueUrl, "_blank");
    }
  }, []);

  const handleOpenEmail = useCallback((draft: DraftRecord) => {
    if (draft.outputs.mailtoUrl) {
      window.open(draft.outputs.mailtoUrl, "_blank");
    }
  }, []);

  const handleDeleteDraft = useCallback(async (id: string) => {
    const result = await deleteFeedbackReport(id);
    if (!result.success) {
      toast.error(t("pages.reportProblem.toast.deleteFailed"));
      return;
    }
    toast.success(t("pages.reportProblem.toast.draftDeleted"));
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    if (currentDraft?.id === id) {
      setCurrentDraft(null);
    }
  }, [t, currentDraft]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.reportProblem.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.reportProblem.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.reportProblem.loadError")}</p>
          {loadError && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{loadError}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.reportProblem.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.reportProblem.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.reportProblem.subtitle")}
      </p>

      <NoAutoUploadBanner />

      {/* Section 1: Feedback Form */}
      <section aria-labelledby="section-form">
        <SectionTitle id="section-form">{t("pages.reportProblem.form.title")}</SectionTitle>
        <p className="text-ink-3 text-[13px] leading-relaxed mb-4">
          {t("pages.reportProblem.form.description")}
        </p>

        <form onSubmit={handleSubmit} className="bg-panel border border-line rounded-[6px] p-5 space-y-4">
          {/* Type selector */}
          <div>
            <label htmlFor="feedback-type" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.type")}
            </label>
            <select
              id="feedback-type"
              value={form.type}
              onChange={(e) => {
                const val = e.target.value;
                if (VALID_FEEDBACK_TYPES.has(val)) {
                  handleFieldChange("type", val as FeedbackType);
                }
              }}
              className="border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov"
            >
              {FEEDBACK_TYPES.map((ft) => (
                <option key={ft} value={ft}>
                  {t(`pages.reportProblem.form.types.${ft}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Severity */}
          <div>
            <label htmlFor="feedback-severity" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.severity")}
            </label>
            <select
              id="feedback-severity"
              value={form.severity ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "") {
                  handleFieldChange("severity", undefined);
                } else if (VALID_SEVERITY_OPTIONS.has(val)) {
                  handleFieldChange("severity", val as UserSeverity);
                }
              }}
              className="border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov"
            >
              <option value="">{t("pages.reportProblem.form.severityNotSet")}</option>
              {SEVERITY_OPTIONS.map((sev) => (
                <option key={sev} value={sev}>
                  {t(`pages.reportProblem.form.severity${sev.charAt(0).toUpperCase() + sev.slice(1)}` as `pages.reportProblem.form.severity${string}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label htmlFor="feedback-title" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.titleLabel")}
            </label>
            <input
              id="feedback-title"
              type="text"
              value={form.title}
              onChange={(e) => handleFieldChange("title", e.target.value)}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov"
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="feedback-description" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.descriptionLabel")}
            </label>
            <textarea
              id="feedback-description"
              value={form.description}
              onChange={(e) => handleFieldChange("description", e.target.value)}
              rows={4}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov resize-y"
            />
          </div>

          {/* Steps to reproduce */}
          <div>
            <label htmlFor="feedback-steps" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.stepsLabel")}
            </label>
            <textarea
              id="feedback-steps"
              value={form.stepsToReproduce}
              onChange={(e) => handleFieldChange("stepsToReproduce", e.target.value)}
              rows={3}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov resize-y"
            />
          </div>

          {/* Expected behavior */}
          <div>
            <label htmlFor="feedback-expected" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.expectedLabel")}
            </label>
            <textarea
              id="feedback-expected"
              value={form.expectedBehavior}
              onChange={(e) => handleFieldChange("expectedBehavior", e.target.value)}
              rows={2}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov resize-y"
            />
          </div>

          {/* Actual behavior */}
          <div>
            <label htmlFor="feedback-actual" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.actualLabel")}
            </label>
            <textarea
              id="feedback-actual"
              value={form.actualBehavior}
              onChange={(e) => handleFieldChange("actualBehavior", e.target.value)}
              rows={2}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov resize-y"
            />
          </div>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={form.submitting}
              className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {form.submitting ? t("pages.reportProblem.form.submitting") : t("pages.reportProblem.form.submit")}
            </button>
            {currentDraft && (
              <button
                type="button"
                onClick={() => setShowPreview((prev) => !prev)}
                className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {showPreview
                  ? t("pages.reportProblem.form.hidePreview")
                  : t("pages.reportProblem.form.showPreview")}
              </button>
            )}
          </div>
        </form>

        {/* Markdown preview */}
        {showPreview && currentDraft && (
          <div className="mt-4 bg-panel border border-line rounded-[6px] p-4">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-3">
              Markdown
            </h3>
            <pre className="whitespace-pre-wrap text-ink-2 text-[13px] leading-relaxed bg-surface border border-line rounded-[3px] p-3 max-h-[400px] overflow-auto">
              {currentDraft.outputs.markdown}
            </pre>
          </div>
        )}
      </section>

      {/* Section 2: Privacy Boundary */}
      <PrivacySection draft={currentDraft} />

      {/* Current draft card (after submission) */}
      {currentDraft && (
        <section className="mt-8" aria-labelledby="section-current-draft">
          <SectionTitle id="section-current-draft">{t("pages.reportProblem.draft.title")}</SectionTitle>
          <DraftCard
            draft={currentDraft}
            onCopyMarkdown={() => handleCopyMarkdown(currentDraft)}
            onCopyEmail={() => handleCopyEmail(currentDraft)}
            onOpenGithub={() => handleOpenGithub(currentDraft)}
            onOpenEmail={() => handleOpenEmail(currentDraft)}
            onDelete={() => handleDeleteDraft(currentDraft.id)}
          />
        </section>
      )}

      {/* Section 3: Saved Drafts */}
      {loadError && (
        <div className="mt-4 p-3 bg-panel border border-amber/20 rounded-[6px] text-ink-2 text-[13px]">
          <p>{t("pages.reportProblem.loadError")}</p>
          <p className="mt-1 text-ink-4 text-[12px] font-mono">{loadError}</p>
        </div>
      )}
      <SavedDraftsSection
        drafts={drafts}
        onLoad={handleLoadDraft}
        onDelete={handleDeleteDraft}
      />

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.reportProblem.privacy.guarantee")}
      </footer>
      </div>
    </PageShell>
  );
}
