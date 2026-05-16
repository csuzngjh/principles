import { cn } from "../../../lib/utils.js";

interface DonutChartItem {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  items: DonutChartItem[];
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function DonutChart({ items, size = 120, strokeWidth = 20, className }: DonutChartProps) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) {
    return (
      <div className={cn("flex items-center justify-center", className)} style={{ width: size, height: size }}>
        <span className="text-xs text-muted-foreground">No data</span>
      </div>
    );
  }

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let accumulatedOffset = 0;

  const segments = items.map((item) => {
    const percentage = item.value / total;
    const dashLength = circumference * percentage;
    const gap = circumference - dashLength;
    const offset = -accumulatedOffset;

    accumulatedOffset += dashLength;

    return {
      ...item,
      percentage,
      dashLength,
      gap,
      offset,
    };
  });

  return (
    <div className={cn("relative", className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.map((segment, index) => (
          <circle
            key={index}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={segment.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${segment.dashLength} ${segment.gap}`}
            strokeDashoffset={segment.offset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${center} ${center})`}
            className="transition-[stroke-dashoffset,stroke-dasharray] duration-500 motion-reduce:transition-none"
          />
        ))}
      </svg>
    </div>
  );
}

interface DonutChartWithLegendProps {
  items: DonutChartItem[];
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function DonutChartWithLegend({ items, size = 120, strokeWidth = 20, className }: DonutChartWithLegendProps) {
  const total = items.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className={cn("flex items-center gap-4", className)}>
      <DonutChart items={items} size={size} strokeWidth={strokeWidth} />
      <div className="space-y-1.5">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {item.label}
            </span>
            <span className="text-xs font-medium tabular-nums">
              {item.value}
            </span>
            {total > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                ({((item.value / total) * 100).toFixed(0)}%)
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface BarChartItem {
  label: string;
  value: number;
  color: string;
}

interface BarChartProps {
  items: BarChartItem[];
  maxValue?: number;
  className?: string;
}

export function HorizontalBarChart({ items, maxValue, className }: BarChartProps) {
  const max = maxValue ?? Math.max(...items.map((i) => i.value), 1);

  return (
    <div className={cn("space-y-2", className)}>
      {items.map((item) => (
        <div key={item.label} className="space-y-0.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <span className="text-xs font-medium tabular-nums">{item.value}</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
              style={{
                width: `${Math.min((item.value / max) * 100, 100)}%`,
                backgroundColor: item.color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface CoverageIndicatorProps {
  covered: number;
  total: number;
  className?: string;
}

export function CoverageIndicator({ covered, total, className }: CoverageIndicatorProps) {
  const percentage = total > 0 ? (covered / total) * 100 : 0;
  const color =
    percentage >= 80 ? "bg-primary" : percentage >= 50 ? "bg-amber-500" : "bg-destructive";

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {covered} / {total}
        </span>
        <span className="text-xs font-medium tabular-nums">{percentage.toFixed(0)}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", color)}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

interface HistogramProps {
  buckets: { label: string; count: number }[];
  className?: string;
}

export function Histogram({ buckets, className }: HistogramProps) {
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div className={cn("flex items-end gap-1", className)} style={{ height: 80 }}>
      {buckets.map((bucket) => {
        const height = (bucket.count / maxCount) * 100;
        return (
          <div key={bucket.label} className="flex-1 flex flex-col items-center gap-1">
            <div
              className="w-full bg-primary/70 rounded-t transition-[height] duration-500 hover:bg-primary motion-reduce:transition-none"
              style={{ height: `${Math.max(height, 2)}%` }}
              title={`${bucket.label}: ${bucket.count}`}
            />
            <span className="text-[10px] text-muted-foreground truncate w-full text-center">
              {bucket.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function computeValueBuckets(
  principles: { valueScore: number }[],
  bucketCount = 5
): { label: string; count: number }[] {
  if (principles.length === 0) {
    return Array.from({ length: bucketCount }, (_, i) => ({
      label: `${i * 20}`,
      count: 0,
    }));
  }

  const maxScore = Math.max(...principles.map((p) => p.valueScore), 1);
  const bucketSize = maxScore / bucketCount;

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    label: `${(i * bucketSize).toFixed(0)}`,
    count: 0,
  }));

  for (const p of principles) {
    const bucketIndex = Math.min(
      Math.floor(p.valueScore / bucketSize),
      bucketCount - 1
    );
    buckets[bucketIndex].count++;
  }

  return buckets;
}
