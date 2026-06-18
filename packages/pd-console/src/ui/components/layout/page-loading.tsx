import { Skeleton } from "../ui/skeleton.js";

/**
 * Reusable loading skeleton for full-page loading states.
 * Shows a title skeleton + N card skeletons with a subtle fade-in.
 * Replaces plain "Loading…" text across all pages for consistent perceived performance.
 *
 * Accessibility: the root container is a live region (role="status" aria-live="polite")
 * with a localized aria-label, so screen readers announce the loading state.
 * Callers MUST pass a localized `label` (e.g. t("common.loading")).
 */
export function PageLoading({
  cardCount = 3,
  label,
}: {
  cardCount?: number;
  label: string;
}) {
  return (
    <div
      className="animate-[pdFadeIn_200ms_ease-out]"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {/* Title skeleton */}
      <Skeleton className="h-8 w-[60%] rounded-[4px] mb-3" />
      <Skeleton className="h-4 w-[80%] rounded-sm mb-2" />
      <Skeleton className="h-4 w-[50%] rounded-sm mb-8" />

      {/* Card skeletons */}
      <div className="space-y-4">
        {Array.from({ length: cardCount }).map((_, i) => (
          <div
            key={i}
            className="bg-panel border border-line rounded-[var(--radius-md)] p-4"
          >
            <div className="flex items-center gap-2 mb-3">
              <Skeleton className="h-5 w-20 rounded-[2px]" />
              <Skeleton className="h-5 w-16 rounded-[2px]" />
            </div>
            <Skeleton className="h-4 w-full rounded-sm mb-2" />
            <Skeleton className="h-4 w-[75%] rounded-sm mb-4" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-24 rounded-sm" />
              <Skeleton className="h-3.5 w-20 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
