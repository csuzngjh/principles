import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import { providerLogoFile } from "./provider-logos.js";
import {
  CUSTOM_PROVIDER_ID,
  providerDisplayName,
  providerMonogram,
} from "./provider-presets.js";

type LogoSize = "sm" | "md" | "lg";

const TILE_SIZE: Record<LogoSize, string> = {
  sm: "w-[26px] h-[26px] rounded-[4px]",
  md: "w-[34px] h-[34px] rounded-[6px]",
  lg: "w-[44px] h-[44px] rounded-[6px]",
};

const GLYPH_SIZE: Record<LogoSize, string> = {
  sm: "w-[16px] h-[16px]",
  md: "w-[22px] h-[22px]",
  lg: "w-[28px] h-[28px]",
};

const MONOGRAM_SIZE: Record<LogoSize, string> = {
  sm: "text-caption",
  md: "text-caption",
  lg: "text-body",
};

interface ProviderLogoProps {
  providerId: string;
  size?: LogoSize;
  className?: string;
}

/**
 * Provider identity tile.
 *
 * - Bundled official mark (Simple Icons) when one exists, served same-origin
 *   from `/assets/providers/` so the console renders offline.
 * - Otherwise a neutral monogram tile with the provider name beside it — never
 *   an invented lookalike, never an empty box.
 * - `CUSTOM_PROVIDER_ID` and the unconfigured bootstrap profile get a neutral
 *   outline glyph instead of a fake brand.
 *
 * The Simple Icons glyphs are monochrome (default black). The tile keeps a
 * neutral surface in both themes and the glyph is inverted in dark mode, which
 * preserves the official shape without recoloring the asset by hand.
 */
export function ProviderLogo({ providerId, size = "md", className }: ProviderLogoProps) {
  const { t } = useTranslation();
  const tileClass = cn("shrink-0 inline-flex items-center justify-center border", TILE_SIZE[size], className);
  const file = providerLogoFile(providerId);

  if (file !== undefined) {
    return (
      <span className={cn(tileClass, "bg-paper-2 border-line-2")}>
        <img
          src={`/assets/providers/${file}`}
          alt={t("pages.controlCenter.profiles.logoAlt", { name: providerDisplayName(providerId) })}
          className={cn("object-contain dark:invert", GLYPH_SIZE[size])}
          width={28}
          height={28}
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }

  const monogram =
    providerId === CUSTOM_PROVIDER_ID || providerId === "" ? "" : providerMonogram(providerId);
  const label =
    providerId === CUSTOM_PROVIDER_ID
      ? t("pages.controlCenter.profiles.logoCustomAlt")
      : providerId === ""
        ? t("pages.controlCenter.profiles.logoUnconfiguredAlt")
        : t("pages.controlCenter.profiles.logoFallbackAlt", {
            name: providerDisplayName(providerId),
          });

  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        tileClass,
        "bg-paper-2 border-line-2 text-ink-3 font-mono",
        MONOGRAM_SIZE[size],
      )}
    >
      {monogram !== "" ? (
        <span aria-hidden="true">{monogram}</span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className={GLYPH_SIZE[size]}
        >
          <rect x="4" y="4" width="16" height="16" rx="3" />
          {providerId === CUSTOM_PROVIDER_ID ? (
            <path d="M12 8v8M8 12h8" />
          ) : (
            <path d="M8 12h8" />
          )}
        </svg>
      )}
    </span>
  );
}
