import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import { fetchProviderCatalog } from "../../api.js";
import type { ProviderPreset, RedactedRuntimeProfileSummary } from "../../api.js";
import { ProviderPicker } from "./ProviderPicker.js";
import { ProviderProfileForm } from "./ProviderProfileForm.js";
import { CUSTOM_PROVIDER_ID, providerDisplayName } from "./provider-presets.js";

/**
 * RuntimeProfileManager — provider-first LLM configuration (PRI-1213).
 *
 * Main path: pick a provider card → pick a model → paste a key. Base URLs and
 * model lists are a read-only projection of the installed pi-ai catalog, so the
 * user never types them. Custom endpoints live under the advanced section.
 *
 * rc 合规:
 * - rc-1: `profiles` arrive validated from ControlCenterPage; the catalog is
 *   validated by `validateProviderCatalog` in api.ts.
 * - rc-2: no `as` bypasses — narrowing goes through type guards.
 * - rc-3: missing provider/model/key-env fail loud before any request.
 * - rc-9: every API failure is surfaced inline + toast, never swallowed.
 *
 * 品牌约束: no translateY/scale hover, no hardcoded colors (theme tokens only).
 */

interface RuntimeProfileManagerProps {
  profiles: RedactedRuntimeProfileSummary[];
  defaultRuntimeId: string;
  onMutated: () => void;
}

type View =
  | { kind: "pick" }
  | { kind: "create"; presetId: string }
  | { kind: "edit"; profileId: string; presetId?: string };

function readinessDotClasses(readiness: RedactedRuntimeProfileSummary["readiness"]): string {
  const base = "w-2 h-2 rounded-full border-2 shrink-0";
  switch (readiness) {
    case "ready":
      return cn(base, "border-green bg-green");
    case "needs_setup":
    case "not_ready":
    case "unknown":
      return cn(base, "border-amber bg-surface");
    case "disabled":
      return cn(base, "border-ink-4 bg-surface opacity-50");
    default:
      return cn(base, "border-ink-4 bg-surface");
  }
}

export function RuntimeProfileManager({
  profiles,
  defaultRuntimeId,
  onMutated,
}: RuntimeProfileManagerProps) {
  const { t } = useTranslation();

  const [catalog, setCatalog] = useState<ProviderPreset[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<View>({ kind: "pick" });
  // The bootstrap profile (provider="") is completed through the picker: choose
  // a provider, then PATCH this profile instead of creating a second one.
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalog(null);
    setCatalogError(null);
    const result = await fetchProviderCatalog();
    if (!result.success) {
      setCatalogError(result.error);
      return;
    }
    setCatalog(result.data.providers);
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const presets = catalog ?? [];
  const existingIds = profiles.map((profile) => profile.id);
  const catalogReady = catalog !== null;

  const openPicker = () => {
    setPendingTargetId(null);
    setView({ kind: "pick" });
  };

  const handlePickProvider = (presetId: string) => {
    if (pendingTargetId !== null) {
      setView({ kind: "edit", profileId: pendingTargetId, presetId });
      setPendingTargetId(null);
      return;
    }
    setView({ kind: "create", presetId });
  };

  const openEdit = (profileId: string) => {
    if (!catalogReady) return;
    const profile = profiles.find((item) => item.id === profileId);
    if (profile === undefined) return;
    if (profile.provider === undefined || profile.provider === "") {
      setPendingTargetId(profileId);
      setView({ kind: "pick" });
      return;
    }
    setView({ kind: "edit", profileId });
  };

  const editTarget =
    view.kind === "edit" ? profiles.find((profile) => profile.id === view.profileId) : undefined;

  return (
    <div id="runtime-profile-manager" className="scroll-mt-4">
      <div className="flex items-start justify-between gap-[12px] mb-3">
        <p className="text-ink-3 text-body leading-relaxed">
          {t("pages.controlCenter.profiles.sectionDescription")}
        </p>
        <button
          type="button"
          onClick={openPicker}
          className="shrink-0 border border-line bg-surface text-ink rounded-[3px] px-[16px] py-[6px] text-caption font-medium hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.controlCenter.profiles.addProviderButton")}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-[12px] items-start">
        {/* Left: configured providers */}
        <aside className="bg-surface border border-line-2 rounded-[6px] overflow-hidden">
          <div className="px-[12px] py-[8px] bg-paper-2 border-b border-line-2 font-mono text-caption uppercase tracking-[0.04em] text-ink-4">
            {t("pages.controlCenter.profiles.configuredTitle")}
          </div>
          {profiles.length === 0 ? (
            <p className="px-[12px] py-[16px] text-caption text-ink-4 italic leading-[1.5]">
              {t("pages.controlCenter.profiles.empty")}
            </p>
          ) : (
            <div>
              {profiles.map((profile) => {
                const isDefault = profile.id === defaultRuntimeId;
                const isRetired = profile.type === "openclaw";
                const selected = view.kind === "edit" && view.profileId === profile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => openEdit(profile.id)}
                    disabled={!catalogReady || isRetired}
                    title={
                      isRetired
                        ? t("pages.controlCenter.profiles.retiredReadOnly")
                        : !catalogReady
                          ? t("pages.controlCenter.profiles.catalogLoading")
                          : profile.id
                    }
                    className={cn(
                      "w-full text-left px-[12px] py-[8px] border-b border-line-2 last:border-b-0 flex items-start gap-[8px] transition-colors",
                      selected ? "bg-paper-2" : "bg-surface hover:bg-paper-2",
                      (!catalogReady || isRetired) && "opacity-60 cursor-not-allowed",
                    )}
                  >
                    <span
                      className={cn(readinessDotClasses(profile.readiness), "mt-[4px]")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-[5px] min-w-0">
                        <span className="min-w-0 text-caption text-ink truncate">
                          {profile.provider !== undefined && profile.provider !== ""
                            ? providerDisplayName(profile.provider)
                            : t("pages.controlCenter.profiles.unconfiguredProfile")}
                        </span>
                        {isDefault && (
                          <span className="shrink-0 text-caption font-mono px-[4px] py-[1px] rounded-[2px] bg-gov/10 text-gov border border-gov/22">
                            default
                          </span>
                        )}
                        {isRetired && (
                          <span className="shrink-0 text-caption font-mono px-[4px] py-[1px] rounded-[2px] bg-amber/10 text-amber border border-amber/22">
                            {t("pages.controlCenter.profiles.retiredBadge")}
                          </span>
                        )}
                      </span>
                      <span className="block font-mono text-caption text-ink-4 truncate">
                        {profile.model !== undefined && profile.model !== ""
                          ? profile.model
                          : profile.id}
                      </span>
                    </span>
                    {!isRetired && (
                      <span aria-hidden="true" className="shrink-0 text-caption text-ink-4 mt-[2px]">
                        ›
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Right: pick a provider, or edit the selected one */}
        <section className="min-w-0">
          {view.kind === "pick" && (
            <ProviderPicker
              presets={presets}
              loading={catalog === null && catalogError === null}
              error={catalogError}
              showAll={showAll}
              onToggleShowAll={() => setShowAll((value) => !value)}
              onSelect={handlePickProvider}
              onCustom={() => handlePickProvider(CUSTOM_PROVIDER_ID)}
              onRetry={() => void loadCatalog()}
            />
          )}

          {view.kind === "create" && (
            <ProviderProfileForm
              mode="create"
              presetId={view.presetId}
              presets={presets}
              existingIds={existingIds}
              onPersisted={onMutated}
              onClose={openPicker}
              onDeleted={() => {
                onMutated();
                openPicker();
              }}
              onBackToPicker={openPicker}
            />
          )}

          {view.kind === "edit" && editTarget !== undefined && (
            <ProviderProfileForm
              mode="edit"
              presetId={view.presetId ?? editTarget.provider ?? ""}
              initial={editTarget}
              presets={presets}
              existingIds={existingIds}
              onPersisted={onMutated}
              onClose={openPicker}
              onDeleted={() => {
                onMutated();
                openPicker();
              }}
              onBackToPicker={openPicker}
            />
          )}

          {view.kind === "edit" && editTarget === undefined && (
            <div className="bg-surface border border-line-2 rounded-[6px] px-[16px] py-[16px] text-caption text-ink-4 italic">
              {t("pages.controlCenter.profiles.profileNotFound")}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
