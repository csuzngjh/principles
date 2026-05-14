import * as React from "react";
import { cn } from "../../../lib/utils.js";

interface ProgressBarProps {
  value: number;
  max?: number;
  showLabel?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

function getColorClass(value: number, max: number): string {
  const percentage = Math.min((value / max) * 100, 100);
  if (percentage > 70) return "bg-green-500";
  if (percentage > 40) return "bg-amber-500";
  return "bg-red-500";
}

function getTextColorClass(value: number, max: number): string {
  const percentage = Math.min((value / max) * 100, 100);
  if (percentage > 70) return "text-green-600 dark:text-green-400";
  if (percentage > 40) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

const sizeClasses = {
  sm: "h-1.5",
  md: "h-2.5",
  lg: "h-4",
};

export const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ value, max = 100, showLabel = false, size = "md", className }, ref) => {
    const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
    const colorClass = getColorClass(value, max);
    const textColorClass = getTextColorClass(value, max);

    return (
      <div ref={ref} className={cn("flex items-center gap-2", className)}>
        <div className={cn("flex-1 bg-muted rounded-full overflow-hidden", sizeClasses[size])}>
          <div
            className={cn("h-full rounded-full transition-all duration-300", colorClass)}
            style={{ width: `${percentage}%` }}
          />
        </div>
        {showLabel && (
          <span className={cn("text-xs font-medium tabular-nums min-w-[3ch]", textColorClass)}>
            {percentage.toFixed(0)}%
          </span>
        )}
      </div>
    );
  }
);
ProgressBar.displayName = "ProgressBar";

interface ValueScoreBarProps {
  valueScore: number;
  className?: string;
}

export function ValueScoreBar({ valueScore, className }: ValueScoreBarProps) {
  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={valueScore} max={100} size="sm" className="flex-1" />
      <span className={cn("text-xs font-medium tabular-nums", getTextColorClass(valueScore, 100))}>
        {valueScore.toFixed(1)}
      </span>
    </div>
  );
}

interface AdherenceBarProps {
  adherenceRate: number;
  className?: string;
}

export function AdherenceBar({ adherenceRate, className }: AdherenceBarProps) {
  const percentage = adherenceRate * 100;
  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={percentage} max={100} size="sm" className="flex-1" />
      <span className={cn("text-xs font-medium tabular-nums", getTextColorClass(percentage, 100))}>
        {percentage.toFixed(0)}%
      </span>
    </div>
  );
}
