import { useTranslation } from "react-i18next";
import type { ProviderCapability } from "./provider-presets.js";

interface ProviderCapabilityChipsProps {
  capabilities: ProviderCapability[];
}

/**
 * Catalog-derived capability labels (reasoning / long context). Rendered in
 * both the picker cards and the selected-provider header so the same provider
 * looks the same in both places.
 */
export function ProviderCapabilityChips({ capabilities }: ProviderCapabilityChipsProps) {
  const { t } = useTranslation();
  if (capabilities.length === 0) return null;

  return (
    <span className="flex flex-wrap gap-[4px]">
      {capabilities.map((capability) => (
        <span
          key={capability}
          className="shrink-0 text-caption px-[6px] py-[1px] rounded-[2px] border border-line-2 bg-paper-2 text-ink-4"
        >
          {capability === "reasoning"
            ? t("pages.controlCenter.profiles.capabilityReasoning")
            : t("pages.controlCenter.profiles.capabilityLongContext")}
        </span>
      ))}
    </span>
  );
}
