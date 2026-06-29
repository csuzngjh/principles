/**
 * PRI-477 + spec 2026-06-27: Intent Engineering onboarding components.
 *
 * Three components:
 * 1. OnboardingModal — 5-step wizard (intro → Why → Desired Outcome →
 *    Non-negotiables → Stop/Escalation → Current Strategic Focus → finish)
 * 2. IntentEditor — section editor with 5 independent textareas (one per
 *    section), replacing the single monolithic textarea
 * 3. CreateIntentButton — creates INTENT.md template, optionally shows wizard
 *
 * SPEC §22.1.1 update: Intent Page supports inline editing. This breaks the
 * original "read-only governance view" constraint, but preserves the
 * Owner-owned boundary: all edits are triggered by Owner clicking buttons,
 * never by Agent auto-modification (SPEC §3.9 preserved).
 *
 * Architecture note: parseIntentDocSections / assembleIntentDoc are imported
 * from @principles/core/runtime-v2. These are pure functions (no I/O, no
 * node:crypto) and safe for the browser bundle. The crypto-dependent
 * computeIntentContentHash lives in intent-hash.ts to keep intent-doc.ts
 * browser-bundleable.
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createIntentTemplate, saveIntentContent } from "../../api.js";
import {
  parseIntentDocSections,
  assembleIntentDoc,
  type IntentDocSections,
} from "@principles/core/runtime-v2/intent-browser";

// ── Section step helpers ─────────────────────────────────────────────────────

const SECTION_STEPS = [1, 2, 3, 4, 5] as const;
type SectionStep = (typeof SECTION_STEPS)[number];
type WizardStep = "intro" | SectionStep | "finish";

const STEP_TO_KEY: Record<SectionStep, keyof IntentDocSections> = {
  1: "why",
  2: "desiredOutcome",
  3: "nonNegotiables",
  4: "stopEscalation",
  5: "currentStrategicFocus",
};

// ── localStorage key for onboarding dismissal ─────────────────────────────────

const ONBOARDING_DISMISSED_KEY = "pd_intent_onboarding_dismissed";

function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function setOnboardingDismissed(): void {
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
  } catch {
    // ignore localStorage errors
  }
}

// ── OnboardingModal (5-step wizard) ──────────────────────────────────────────

interface OnboardingModalProps {
  /** Called when user completes all 5 steps with the assembled sections */
  onComplete: (sections: IntentDocSections) => void;
  /** Called when user clicks "Skip" — creates empty template without wizard */
  onSkip: () => void;
  /** Called when user closes the modal without completing */
  onClose: () => void;
}

export function OnboardingModal({ onComplete, onSkip, onClose }: OnboardingModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>("intro");
  const [sections, setSections] = useState<IntentDocSections>({});
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when entering a section step
  useEffect(() => {
    if (typeof step === "number") {
      textareaRef.current?.focus();
    }
  }, [step]);

  const hasContent = useMemo(
    () => Object.values(sections).some((v) => typeof v === "string" && v.trim().length > 0),
    [sections],
  );

  function handleRequestClose() {
    if (hasContent) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  }

  function handleNext() {
    if (step === "intro") {
      setStep(1);
      return;
    }
    if (typeof step === "number" && step < 5) {
      setStep((step + 1) as SectionStep);
      return;
    }
    if (step === 5) {
      setStep("finish");
    }
  }

  function handlePrev() {
    if (typeof step === "number" && step > 1) {
      setStep((step - 1) as SectionStep);
      return;
    }
    if (step === 1) {
      setStep("intro");
    }
  }

  function handleSectionChange(value: string) {
    if (typeof step !== "number") return;
    const key = STEP_TO_KEY[step];
    setSections((prev) => ({ ...prev, [key]: value }));
  }

  const currentSectionValue =
    typeof step === "number" ? (sections[STEP_TO_KEY[step]] ?? "") : "";
  const isCurrentSectionEmpty = typeof step === "number" && currentSectionValue.trim().length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm animate-[pdFadeIn_200ms_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      onClick={handleRequestClose}
    >
      <div
        className="bg-surface border border-line rounded-[8px] p-6 max-w-[620px] w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 id="onboarding-title" className="text-[20px] font-semibold tracking-tight text-ink mb-1">
              {t("pages.intent.onboarding.title")}
            </h2>
            {step === "intro" && (
              <p className="text-ink-3 text-[13px] leading-relaxed">
                {t("pages.intent.onboarding.subtitle")}
              </p>
            )}
            {typeof step === "number" && (
              <p className="text-ink-3 text-[12px] font-mono">
                {t("pages.intent.wizard.progressLabel", { current: step })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            className="shrink-0 ml-3 text-ink-3 hover:text-ink transition-colors"
            aria-label={t("pages.intent.onboarding.close")}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Intro step */}
        {step === "intro" && (
          <div className="mb-5">
            <div className="mb-5">
              <h3 className="text-[14px] font-semibold text-ink mb-1.5">
                {t("pages.intent.onboarding.whatIsIt.title")}
              </h3>
              <p className="text-ink-2 text-[13px] leading-relaxed">
                {t("pages.intent.onboarding.whatIsIt.description")}
              </p>
            </div>
            <div className="mb-5">
              <h3 className="text-[14px] font-semibold text-ink mb-1.5">
                {t("pages.intent.onboarding.whyYouFill.title")}
              </h3>
              <p className="text-ink-2 text-[13px] leading-relaxed">
                {t("pages.intent.onboarding.whyYouFill.description")}
              </p>
            </div>
            <div className="mb-5">
              <h3 className="text-[14px] font-semibold text-ink mb-1.5">
                {t("pages.intent.onboarding.sectionGuide.title")}
              </h3>
              <p className="text-ink-3 text-[12px] leading-relaxed mb-2">
                {t("pages.intent.onboarding.sectionGuide.description")}
              </p>
              <ul className="space-y-1.5">
                {SECTION_STEPS.map((s) => {
                  const key = STEP_TO_KEY[s];
                  return (
                    <li key={s} className="text-ink-2 text-[13px] leading-relaxed">
                      <span className="font-mono text-gov">•</span>{" "}
                      {t(`pages.intent.wizard.stepLabels.${key}`)}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {/* Section steps 1-5 */}
        {typeof step === "number" && (
          <div className="mb-5">
            <h3 className="text-[15px] font-semibold text-ink mb-1.5">
              {t(`pages.intent.wizard.stepLabels.${STEP_TO_KEY[step]}`)}
            </h3>
            <p className="text-ink-3 text-[12px] leading-relaxed mb-3">
              {t(`pages.intent.wizard.guidance.${STEP_TO_KEY[step]}`)}
            </p>
            <textarea
              ref={textareaRef}
              value={currentSectionValue}
              onChange={(e) => handleSectionChange(e.target.value)}
              placeholder={t(`pages.intent.wizard.guidance.${STEP_TO_KEY[step]}`)}
              className="w-full h-[180px] bg-surface border border-line rounded-[4px] p-3 text-[13px] text-ink leading-relaxed resize-y focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov/30"
              spellCheck={false}
              aria-label={t(`pages.intent.wizard.stepLabels.${STEP_TO_KEY[step]}`)}
            />
            {/* rc-9: visible warning when section is empty, not silent disable */}
            {isCurrentSectionEmpty && (
              <p className="text-amber text-[12px] mt-1.5" role="alert">
                {t("pages.intent.wizard.emptyWarning")}
              </p>
            )}
          </div>
        )}

        {/* Finish step — summary */}
        {step === "finish" && (
          <div className="mb-5">
            <h3 className="text-[15px] font-semibold text-ink mb-3">
              {t("pages.intent.wizard.finish")}
            </h3>
            <div className="space-y-3">
              {SECTION_STEPS.map((s) => {
                const key = STEP_TO_KEY[s];
                const value = sections[key] ?? "";
                return (
                  <div key={s} className="border-l-2 border-gov/40 pl-3">
                    <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-0.5">
                      {t(`pages.intent.wizard.stepLabels.${key}`)}
                    </p>
                    <p className="text-ink-2 text-[13px] leading-relaxed whitespace-pre-wrap">
                      {value || t("pages.intent.wizard.emptyWarning")}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 pt-3 border-t border-line">
          {/* Left: Prev / Cancel */}
          <div>
            {step === "intro" && (
              <button
                type="button"
                onClick={onSkip}
                className="border border-line bg-surface text-ink-2 rounded-[4px] px-4 py-2 text-[13px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {t("pages.intent.onboarding.skipOption")}
              </button>
            )}
            {typeof step === "number" && (
              <button
                type="button"
                onClick={handlePrev}
                className="border border-line bg-surface text-ink-2 rounded-[4px] px-4 py-2 text-[13px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {t("pages.intent.wizard.prev")}
              </button>
            )}
          </div>

          {/* Right: Next / Finish / Complete */}
          <div>
            {step === "intro" && (
              <button
                type="button"
                onClick={handleNext}
                className="bg-gov text-paper rounded-[4px] px-4 py-2 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {t("pages.intent.onboarding.startFilling")}
              </button>
            )}
            {typeof step === "number" && step < 5 && (
              <button
                type="button"
                onClick={handleNext}
                disabled={isCurrentSectionEmpty}
                className="bg-gov text-paper rounded-[4px] px-4 py-2 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("pages.intent.wizard.next")}
              </button>
            )}
            {step === 5 && (
              <button
                type="button"
                onClick={handleNext}
                disabled={isCurrentSectionEmpty}
                className="bg-gov text-paper rounded-[4px] px-4 py-2 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("pages.intent.wizard.review")}
              </button>
            )}
            {step === "finish" && (
              <button
                type="button"
                onClick={() => onComplete(sections)}
                className="bg-gov text-paper rounded-[4px] px-4 py-2 text-[13px] font-medium hover:bg-gov-dark transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {t("pages.intent.wizard.complete")}
              </button>
            )}
          </div>
        </div>

        {/* Discard confirmation */}
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
              <p id="discard-title" className="text-ink text-[14px] font-semibold mb-2">
                {t("pages.intent.wizard.discardConfirmTitle")}
              </p>
              <p className="text-ink-3 text-[13px] leading-relaxed mb-4">
                {t("pages.intent.wizard.discardConfirmBody")}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowDiscardConfirm(false)}
                  className="border border-line bg-surface text-ink-2 rounded-[4px] px-3 py-1.5 text-[12px] hover:border-line-2 transition-colors"
                >
                  {t("pages.intent.wizard.discardConfirmCancel")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDiscardConfirm(false);
                    onClose();
                  }}
                  className="bg-red-600 text-white rounded-[4px] px-3 py-1.5 text-[12px] hover:bg-red-700 transition-colors"
                >
                  {t("pages.intent.wizard.discardConfirmConfirm")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── IntentEditor (5 section textareas) ───────────────────────────────────────

interface IntentEditorProps {
  /** Initial content to populate the editor (current INTENT.md content) */
  initialContent: string;
  /** Called after successful save — parent should refresh the summary */
  onSaved: () => void;
  /** Called when user cancels editing — parent should hide the editor */
  onCancel: () => void;
  /** Language for bilingual INTENT.md */
  lang: 'zh-CN' | 'en';
}

export function IntentEditor({ initialContent, onSaved, onCancel, lang }: IntentEditorProps) {
  const { t } = useTranslation();
  // Parse initial content into 5 sections on mount. parseIntentDocSections
  // returns undefined for missing sections; we normalize to empty string for
  // textarea value binding (controlled input requires a string value).
  const [sections, setSections] = useState<IntentDocSections>(() => {
    const parsed = parseIntentDocSections(initialContent);
    return {
      why: parsed.why ?? "",
      desiredOutcome: parsed.desiredOutcome ?? "",
      nonNegotiables: parsed.nonNegotiables ?? "",
      stopEscalation: parsed.stopEscalation ?? "",
      currentStrategicFocus: parsed.currentStrategicFocus ?? "",
    };
  });
  const [saving, setSaving] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const firstTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the first textarea on mount
  useEffect(() => {
    firstTextareaRef.current?.focus();
  }, []);

  // Detect changes by comparing current sections to initial parsed sections.
  // We re-parse initialContent on each render (cheap, pure function) rather
  // than storing a second state variable — avoids stale closure issues.
  const initialSections = useMemo(() => parseIntentDocSections(initialContent), [initialContent]);
  const hasChanges = useMemo(() => {
    for (const step of SECTION_STEPS) {
      const key = STEP_TO_KEY[step];
      const current = sections[key] ?? "";
      const initial = initialSections[key] ?? "";
      if (current !== initial) return true;
    }
    return false;
  }, [sections, initialSections]);

  function handleSectionChange(key: keyof IntentDocSections, value: string) {
    setSections((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!hasChanges || saving) return;

    // Client-side validation: require at least one non-empty section.
    // Empty individual sections are allowed (user may clear a section
    // intentionally); the server emits warnings, not errors, for empty
    // sections.
    const allEmpty = SECTION_STEPS.every((s) => {
      const key = STEP_TO_KEY[s];
      return (sections[key] ?? "").trim().length === 0;
    });
    if (allEmpty) {
      toast.error(t("pages.intent.editor.emptyContent"));
      return;
    }

    const assembled = assembleIntentDoc(sections);
    setSaving(true);
    const result = await saveIntentContent(assembled, lang);
    setSaving(false);

    if (!result.success) {
      // Branch on structured reason field, NOT substring matching (PR-1083 N4).
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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 id="section-editor" className="text-[15px] font-semibold text-ink mb-0.5">
            {t("pages.intent.editor.title")}
          </h3>
          <p className="text-ink-3 text-[12px] leading-relaxed">
            {t("pages.intent.editor.description")}
          </p>
        </div>
      </div>

      {/* 5 independent section textareas */}
      <div className="space-y-4">
        {SECTION_STEPS.map((step, idx) => {
          const key = STEP_TO_KEY[step];
          const value = sections[key] ?? "";
          return (
            <div key={step}>
              <label
                htmlFor={`intent-section-${key}`}
                className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1"
              >
                {t(`pages.intent.wizard.stepLabels.${key}`)}
              </label>
              <p className="text-ink-3 text-[12px] leading-relaxed mb-1.5">
                {t(`pages.intent.wizard.guidance.${key}`)}
              </p>
              <textarea
                ref={idx === 0 ? firstTextareaRef : undefined}
                id={`intent-section-${key}`}
                value={value}
                onChange={(e) => handleSectionChange(key, e.target.value)}
                className="w-full h-[120px] bg-surface border border-line rounded-[4px] p-3 text-[13px] text-ink leading-relaxed resize-y focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov/30"
                spellCheck={false}
                aria-label={t(`pages.intent.wizard.stepLabels.${key}`)}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 mt-4">
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
  /** If true, show onboarding wizard before creating. If false, create directly. */
  showOnboarding?: boolean;
  /** Language for bilingual INTENT.md */
  lang: 'zh-CN' | 'en';
}

export function CreateIntentButton({ onCreated, showOnboarding = false, lang }: CreateIntentButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [showOnboardingModal, setShowOnboardingModal] = useState(
    showOnboarding && !isOnboardingDismissed(),
  );

  // Create template + save assembled content from wizard.
  // Called when user completes all 5 wizard steps.
  async function createFromWizard(sections: IntentDocSections) {
    setBusy(true);
    // Step 1: create template (idempotent — ensures file exists)
    const createResult = await createIntentTemplate(false, lang);
    if (!createResult.success) {
      setBusy(false);
      toast.error(t("pages.intent.notFound.createFailed"));
      return;
    }
    // Step 2: save the assembled content (overwrites template defaults)
    const assembled = assembleIntentDoc(sections);
    const saveResult = await saveIntentContent(assembled, lang);
    setBusy(false);

    if (!saveResult.success) {
      // Template was created but wizard content failed to save.
      // The file exists (template), so refresh summary; show error so the
      // user knows to edit manually. This is NOT a silent fallback (rc-9).
      if (saveResult.reason === "oversized") {
        toast.error(t("pages.intent.editor.oversized"));
      } else {
        toast.error(t("pages.intent.editor.saveFailed"));
      }
      onCreated(true); // open editor so user can retry / inspect
      return;
    }

    toast.success(t("pages.intent.notFound.createSuccess"));
    onCreated(false); // wizard already filled content — no need to open editor
  }

  // Create empty template. Returns true on success so the caller can decide
  // whether to open the editor (legacy path) or just refresh (skip path).
  // Does NOT call onCreated itself — avoids double-callback bug.
  async function createEmptyTemplate(): Promise<boolean> {
    setBusy(true);
    const result = await createIntentTemplate(false, lang);
    setBusy(false);

    if (!result.success) {
      toast.error(t("pages.intent.notFound.createFailed"));
      return false;
    }

    toast.success(t("pages.intent.notFound.createSuccess"));
    return true;
  }

  function handleComplete(sections: IntentDocSections) {
    setShowOnboardingModal(false);
    setOnboardingDismissed();
    void createFromWizard(sections);
  }

  function handleSkip() {
    setShowOnboardingModal(false);
    setOnboardingDismissed();
    void createEmptyTemplate().then((ok) => {
      if (ok) onCreated(false);
    });
  }

  function handleClose() {
    setShowOnboardingModal(false);
  }

  function handleClick() {
    if (showOnboarding && !isOnboardingDismissed()) {
      setShowOnboardingModal(true);
    } else {
      // Legacy direct-create path (onboarding already dismissed or not enabled):
      // create template then open editor so user can fill content manually.
      void createEmptyTemplate().then((ok) => {
        if (ok) onCreated(true);
      });
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
          onComplete={handleComplete}
          onSkip={handleSkip}
          onClose={handleClose}
        />
      )}
    </>
  );
}

// ── EditButton ─────────────────────────────────────────────────────────────────

interface EditButtonProps {
  onClick: () => void;
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
