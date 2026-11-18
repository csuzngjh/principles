import { useTranslation } from "react-i18next";
import type { ProviderPreset } from "../../api.js";
import { ProviderCapabilityChips } from "./ProviderCapabilityChips.js";
import { ProviderLogo } from "./ProviderLogo.js";
import {
  CUSTOM_PROVIDER_ID,
  MAIN_PROVIDER_ID_SET,
  MAIN_PROVIDER_IDS,
  providerCapabilities,
  providerDisplayName,
} from "./provider-presets.js";

interface ProviderPickerProps {
  presets: ProviderPreset[];
  loading: boolean;
  error: string | null;
  showAll: boolean;
  /** Providers that already have a runtime profile, shown as a badge. */
  configuredProviderIds: ReadonlySet<string>;
  onToggleShowAll: () => void;
  onSelect: (providerId: string) => void;
  onCustom: () => void;
  onRetry: () => void;
}

interface ProviderCardProps {
  preset: ProviderPreset;
  configured: boolean;
  onSelect: (providerId: string) => void;
}

function ProviderCard({ preset, configured, onSelect }: ProviderCardProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onSelect(preset.id)}
      className="group flex h-full flex-col justify-between gap-[8px] text-left bg-surface border border-line rounded-[6px] px-[12px] py-[10px] hover:border-line-2 hover:bg-panel transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
    >
      <span className="flex items-center gap-[10px] min-w-0">
        <ProviderLogo providerId={preset.id} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-[6px] min-w-0">
            <span className="min-w-0 text-body font-medium text-ink truncate">
              {providerDisplayName(preset.id)}
            </span>
            {configured && (
              <span className="shrink-0 text-caption font-mono px-[4px] py-[1px] rounded-[2px] bg-green/10 text-green border border-green/22">
                {t("pages.controlCenter.profiles.configuredBadge")}
              </span>
            )}
          </span>
          <span className="block text-caption text-ink-4 font-mono truncate">
            {t("pages.controlCenter.profiles.providerModelCount", {
              count: preset.models.length,
            })}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-ink-4 group-hover:text-ink-2 transition-colors"
        >
          ›
        </span>
      </span>
      <ProviderCapabilityChips capabilities={providerCapabilities(preset)} />
    </button>
  );
}

/**
 * Provider card grid — the main path. Models and endpoints are catalog data;
 * the user only picks a supplier here.
 *
 * Layout: `auto-fill` with a 232px floor instead of fixed breakpoints, so the
 * grid collapses to a single readable column before cards can be squeezed.
 */
export function ProviderPicker({
  presets,
  loading,
  error,
  showAll,
  configuredProviderIds,
  onToggleShowAll,
  onSelect,
  onCustom,
  onRetry,
}: ProviderPickerProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="bg-surface border border-line-2 rounded-[6px] px-[16px] py-[16px] text-caption text-ink-4 italic">
        {t("pages.controlCenter.profiles.catalogLoading")}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="bg-surface border border-line-2 rounded-[6px] px-[16px] py-[16px]">
        <p className="text-caption text-danger font-mono">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-[10px] border border-line bg-surface text-ink-3 rounded-[3px] px-[12px] py-[5px] text-caption hover:border-line-2 hover:text-ink transition-colors"
        >
          {t("pages.controlCenter.profiles.catalogRetry")}
        </button>
      </div>
    );
  }

  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  const main = MAIN_PROVIDER_IDS.map((id) => byId.get(id)).filter(
    (preset): preset is ProviderPreset => preset !== undefined,
  );
  const other = presets
    .filter((preset) => !MAIN_PROVIDER_ID_SET.has(preset.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  return (
    <div>
      <div className="mb-3">
        <h4 className="text-body font-semibold text-ink">
          {t("pages.controlCenter.profiles.pickerTitle")}
        </h4>
        <p className="mt-[3px] text-caption text-ink-4 leading-[1.5]">
          {t("pages.controlCenter.profiles.pickerDescription")}
        </p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-[8px]">
        {main.map((preset) => (
          <ProviderCard
            key={preset.id}
            preset={preset}
            configured={configuredProviderIds.has(preset.id)}
            onSelect={onSelect}
          />
        ))}
        <button
          type="button"
          onClick={onCustom}
          className="group flex h-full flex-col justify-between gap-[8px] text-left bg-surface border border-dashed border-line-2 rounded-[6px] px-[12px] py-[10px] hover:border-ink-4 hover:bg-panel transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          <span className="flex items-center gap-[10px] min-w-0">
            <ProviderLogo providerId={CUSTOM_PROVIDER_ID} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-ink truncate">
                {t("pages.controlCenter.profiles.customProvider")}
              </span>
              <span className="block text-caption text-ink-4 truncate">
                {t("pages.controlCenter.profiles.customProviderHint")}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="shrink-0 text-ink-4 group-hover:text-ink-2 transition-colors"
            >
              ›
            </span>
          </span>
        </button>
      </div>

      {other.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onToggleShowAll}
            className="text-caption text-ink-4 hover:text-ink-2 transition-colors"
          >
            {showAll
              ? t("pages.controlCenter.profiles.hideAllProviders")
              : t("pages.controlCenter.profiles.showAllProviders", { count: other.length })}
          </button>
          {showAll && (
            <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-[8px]">
              {other.map((preset) => (
                <ProviderCard
                  key={preset.id}
                  preset={preset}
                  configured={configuredProviderIds.has(preset.id)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
