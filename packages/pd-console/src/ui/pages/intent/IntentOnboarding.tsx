/**
 * PRI-477: Intent Engineering Onboarding components.
 *
 * Three components:
 * 1. OnboardingModal — first-time intro (4 sections + skip option)
 * 2. IntentEditor — inline markdown editor (Save / Cancel)
 * 3. CreateIntentButton — creates INTENT.md template, optionally shows onboarding
 *
 * SPEC §22.1.1 update (PRI-477): Intent Page now supports inline editing.
 * This breaks the original "read-only governance view" constraint, but
 * preserves the Owner-owned boundary: all edits are triggered by Owner
 * clicking buttons, never by Agent auto-modification (SPEC §3.9 preserved).
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createIntentTemplate, saveIntentContent } from "../../api.js";

// ── localStorage key for onboarding dismissal ─────────────────────────────────

const ONBOARDING_DISMISSED_KEY = "pd_intent_onboarding_dismissed";

/** Check if the user has dismissed the onboarding modal before. */
function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true";
  } catch {
    // localStorage may be unavailable (private mode, etc.) — default to not dismissed
    return false;
  }
}

/** Mark onboarding as dismissed so it doesn't show again. */
function setOnboardingDismissed(): void {
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
  } catch {
    // ignore localStorage errors
  }
}

// ── OnboardingModal ───────────────────────────────────────────────────────────

interface OnboardingModalProps {
  /** Called when user clicks "Start filling" — creates template and opens editor */
  onStartFilling: () => void;
  /** Called when user clicks "Skip" — creates empty template without opening editor */
  onSkip: () => void;
  /** Called when user closes the modal without creating anything */
  onClose: () => void;
}

export function OnboardingModal({ onStartFilling, onSkip, onClose }: OnboardingModalProps) {
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm animate-[pdFadeIn_200ms_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-line rounded-[8px] p-6 max-w-[560px] w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 id="onboarding-title" className="text-[20px] font-semibold tracking-tight text-ink mb-1">
              {t("pages.intent.onboarding.title")}
            </h2>
            <p className="text-ink-3 text-[13px] leading-relaxed">
              {t("pages.intent.onboarding.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 ml-3 text-ink-3 hover:text-ink transition-colors"
            aria-label={t("pages.intent.onboarding.close")}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Section 1: What is Intent Engineering */}
        <div className="mb-5">
          <h3 className="text-[14px] font-semibold text-ink mb-1.5">
            {t("pages.intent.onboarding.whatIsIt.title")}
          </h3>
          <p className="text-ink-2 text-[13px] leading-relaxed">
            {t("pages.intent.onboarding.whatIsIt.description")}
          </p>
        </div>

        {/* Section 2: Why you fill */}
        <div className="mb-5">
          <h3 className="text-[14px] font-semibold text-ink mb-1.5">
            {t("pages.intent.onboarding.whyYouFill.title")}
          </h3>
          <p className="text-ink-2 text-[13px] leading-relaxed">
            {t("pages.intent.onboarding.whyYouFill.description")}
          </p>
        </div>

        {/* Section 3: 5-section guide */}
        <div className="mb-5">
          <h3 className="text-[14px] font-semibold text-ink mb-1.5">
            {t("pages.intent.onboarding.sectionGuide.title")}
          </h3>
          <p className="text-ink-3 text-[12px] leading-relaxed mb-2">
            {t("pages.intent.onboarding.sectionGuide.description")}
          </p>
          <ul className="space-y-1.5">
            <li className="text-ink-2 text-[13px] leading-relaxed">
              <span className="font-mono text-gov">•</span>{" "}
              {t("pages.intent.onboarding.sectionGuide.sections.why")}
            </li>
            <li className="text-ink-2 text-[13px] leading-relaxed">
              <span className="font-mono text-gov">•</span>{" "}
              {t("pages.intent.onboarding.sectionGuide.sections.desiredOutcome")}
            </li>
            <li className="text-ink-2 text-[13px] leading-relaxed">
              <span className="font-mono text-gov">•</span>{" "}
              {t("pages.intent.onboarding.sectionGuide.sections.nonNegotiables")}
            </li>
            <li className="text-ink-2 text-[13px] leading-relaxed">
              <span className="font-mono text-gov">•</span>{" "}
              {t("pages.intent.onboarding.sectionGuide.sections.stopEscalation")}
            </li>
            <li className="text-ink-2 text-[13px] leading-relaxed">
              <span className="font-mono text-gov">•</span>{" "}
              {t("pages.intent.onboarding.sectionGuide.sections.currentStrategicFocus")}
            </li>
          </ul>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-2 border-t border-line">
          <button
            type="button"
            onClick={onStartFilling}
            className="w-full bg-gov text-paper rounded-[4px] px-4 py-2.5 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.intent.onboarding.startFilling")}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-full border border-line bg-surface text-ink-2 rounded-[4px] px-4 py-2.5 text-[13px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.intent.onboarding.skipOption")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── IntentEditor ──────────────────────────────────────────────────────────────

interface IntentEditorProps {
  /** Initial content to populate the editor (current INTENT.md content) */
  initialContent: string;
  /** Called after successful save — parent should refresh the summary */
  onSaved: () => void;
  /** Called when user cancels editing — parent should hide the editor */
  onCancel: () => void;
}

export function IntentEditor({ initialContent, onSaved, onCancel }: IntentEditorProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const hasChanges = content !== initialContent;

  async function handleSave() {
    if (!hasChanges || saving) return;

    // Client-side validation (server also validates, but this gives instant feedback)
    if (content.trim().length === 0) {
      toast.error(t("pages.intent.editor.emptyContent"));
      return;
    }

    setSaving(true);
    const result = await saveIntentContent(content);
    setSaving(false);

    if (!result.success) {
      // N4 (PR-1083 review): branch on the structured machine-readable
      // `reason` field surfaced from the server, NOT on substring matching
      // against nextAction text. The previous `nextAction.includes("32KB")`
      // check silently regressed to "saveFailed" the moment the backend
      // rephrased the cap or returned localized text.
      if (result.reason === "oversized") {
        toast.error(t("pages.intent.editor.oversized"));
      } else {
        toast.error(t("pages.intent.editor.saveFailed"));
      }
      return;
    }

    toast.success(t("pages.intent.editor.saveSuccess"));
    onSaved();
  }

  function handleCancel() {
    if (hasChanges) {
      setShowDiscardConfirm(true);
    } else {
      onCancel();
    }
  }

  return (
    <div className="bg-panel border border-line rounded-[6px] p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          {/* N2 (PR-1083 review): hardcoded id matches the parent IntentPage
              `<section aria-labelledby="section-editor">`. IntentEditor owns the
              visible title now — IntentPage no longer renders a duplicate
              SectionTitle wrapping this component. */}
          <h3 id="section-editor" className="text-[15px] font-semibold text-ink mb-0.5">
            {t("pages.intent.editor.title")}
          </h3>
          <p className="text-ink-3 text-[12px] leading-relaxed">
            {t("pages.intent.editor.description")}
          </p>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t("pages.intent.editor.placeholder")}
        className="w-full h-[420px] bg-surface border border-line rounded-[4px] p-3 text-[13px] font-mono text-ink leading-relaxed resize-y focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov/30"
        spellCheck={false}
        aria-label={t("pages.intent.editor.title")}
      />

      <div className="flex items-center justify-end gap-2 mt-3">
        <button
          type="button"
          onClick={handleCancel}
          disabled={saving}
          className="border border-line bg-surface text-ink-2 rounded-[4px] px-4 py-2 text-[13px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("pages.intent.editor.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="bg-gov text-paper rounded-[4px] px-4 py-2 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? t("pages.intent.editor.saving") : t("pages.intent.editor.save")}
        </button>
      </div>

      {/* Discard confirmation modal */}
      {showDiscardConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="discard-title"
          onClick={() => setShowDiscardConfirm(false)}
        >
          <div
            className="bg-surface border border-line rounded-[8px] p-5 max-w-[400px] w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p id="discard-title" className="text-ink text-[14px] mb-4">
              {t("pages.intent.editor.confirmDiscard")}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                className="border border-line bg-surface text-ink-2 rounded-[4px] px-3 py-1.5 text-[12px] hover:border-line-2 transition-colors"
              >
                {t("pages.intent.editor.no")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDiscardConfirm(false);
                  onCancel();
                }}
                className="bg-red-600 text-white rounded-[4px] px-3 py-1.5 text-[12px] hover:bg-red-700 transition-colors"
              >
                {t("pages.intent.editor.yes")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CreateIntentButton ────────────────────────────────────────────────────────

interface CreateIntentButtonProps {
  /**
   * Called after INTENT.md is successfully created (or already existed).
   * Receives `openEditor` so the parent (IntentPage) can split the two
   * concerns of the create flow:
   *   - always: refresh the summary so NotFoundBanner updates to sections
   *   - optionally: open the inline editor immediately afterwards
   *
   * PR-1083 review (CodeRabbit A5): previously this was `() => void` and only
   * invoked when openEditor was true — so the Skip path left NotFoundBanner
   * showing stale "file not found" state after a successful create.
   */
  onCreated: (openEditor: boolean) => void;
  /** If true, show onboarding modal before creating. If false, create directly. */
  showOnboarding?: boolean;
}

export function CreateIntentButton({ onCreated, showOnboarding = false }: CreateIntentButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [showOnboardingModal, setShowOnboardingModal] = useState(
    showOnboarding && !isOnboardingDismissed(),
  );

  async function createTemplate(openEditor: boolean) {
    setBusy(true);
    const result = await createIntentTemplate(false);
    setBusy(false);

    if (!result.success) {
      toast.error(t("pages.intent.notFound.createFailed"));
      return;
    }

    // PR-1083 review (CodeRabbit comment N3): both branches used to call the
    // identical toast.success — collapse to a single call. `result.data.created`
    // (true=create, false=already-existed) is still surfaced via onCreated(openEditor)
    // below so the parent IntentPage can refresh the summary either way; the
    // distinction no longer needs a separate banner here.
    toast.success(t("pages.intent.notFound.createSuccess"));

    // PR-1083 review (CodeRabbit comment A5): the OLD code only invoked
    // onCreated() when openEditor was true, so the "Skip" path created the
    // file but never told the parent to refresh — leaving NotFoundBanner
    // showing stale state even though the file now existed. ALL successful
    // creation paths MUST trigger onCreated(openEditor) so the summary is
    // reloaded; openEditor only controls whether the editor mounts afterwards.
    onCreated(openEditor);
  }

  function handleStartFilling() {
    setShowOnboardingModal(false);
    setOnboardingDismissed();
    void createTemplate(true);
  }

  function handleSkip() {
    setShowOnboardingModal(false);
    setOnboardingDismissed();
    void createTemplate(false);
  }

  function handleClose() {
    setShowOnboardingModal(false);
  }

  function handleClick() {
    if (showOnboarding && !isOnboardingDismissed()) {
      setShowOnboardingModal(true);
    } else {
      void createTemplate(true);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="bg-gov text-paper rounded-[4px] px-4 py-2 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? t("pages.intent.notFound.creating") : t("pages.intent.notFound.createButton")}
      </button>

      {showOnboardingModal && (
        <OnboardingModal
          onStartFilling={handleStartFilling}
          onSkip={handleSkip}
          onClose={handleClose}
        />
      )}
    </>
  );
}

// ── EditButton ─────────────────────────────────────────────────────────────────

interface EditButtonProps {
  /** Called when user clicks "Edit" — parent should show the editor */
  onClick: () => void;
  /**
   * Optional loading state — disables the button and switches the label /
   * aria-busy so the user gets immediate feedback while fetchIntentContent()
   * is in flight. PR-1083 review (CodeRabbit "outside diff" comment ~318-353):
   * `editorLoading` was set in handleStartEdit/handleCreated but never read by
   * the render path, so the EditButton could be clicked repeatedly with no
   * signal that something was happening.
   */
  loading?: boolean;
}

export function EditButton({ onClick, loading = false }: EditButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      aria-busy={loading}
      className="border border-line bg-surface text-ink-2 rounded-[4px] px-3 py-1.5 text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-line"
    >
      {loading ? t("common.loading") : t("pages.intent.editor.edit")}
    </button>
  );
}
