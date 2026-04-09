import React from 'react';

/**
 * StatusBadge - 统一颜色的状态徽章
 */

type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

interface StatusBadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const BADGE_COLORS: Record<BadgeVariant, { bg: string; text: string }> = {
  success: { bg: 'rgba(74, 124, 111, 0.12)', text: 'var(--success)' },
  warning: { bg: 'rgba(184, 134, 11, 0.12)', text: 'var(--warning)' },
  error: { bg: 'rgba(196, 92, 74, 0.12)', text: 'var(--error)' },
  info: { bg: 'rgba(91, 139, 160, 0.12)', text: 'var(--info)' },
  neutral: { bg: 'var(--bg-sunken)', text: 'var(--text-secondary)' },
};

export function StatusBadge({ variant, children, className = '' }: StatusBadgeProps) {
  const { bg, text } = BADGE_COLORS[variant];
  return (
    <span
      className={`badge ${variant !== 'neutral' ? variant : ''} ${className}`}
      style={variant !== 'neutral' ? undefined : { background: bg, color: text }}
    >
      {children}
    </span>
  );
}

/**
 * EmptyState - 空状态插图组件
 */

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="8" y="12" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2"/>
          <path d="M16 20h16M16 26h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="38" cy="10" r="6" fill="var(--bg-sunken)" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M36 10h4M38 8v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/**
 * Sparkline - 轻量级迷你趋势图
 * 用于 KPI 卡片展示趋势
 */

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  showDots?: boolean;
  animated?: boolean;
}

export function Sparkline({
  data,
  width = 60,
  height = 24,
  color = 'var(--accent)',
  fillOpacity = 0.15,
  showDots = false,
  animated = true,
}: SparklineProps) {
  if (!data || data.length < 2) {
    return <span className="sparkline-empty">-</span>;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min;
  // If all values are the same, draw a flat line in the middle
  const isFlat = range === 0;

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = isFlat ? height / 2 : height - ((value - min) / range) * height;
    return `${x},${y}`;
  });

  const linePoints = points.join(' ');
  const areaPoints = `0,${height} ${linePoints} ${width},${height}`;

  return (
    <svg
      className={`sparkline ${animated ? 'sparkline-animated' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {/* 填充区域 */}
      <polygon
        points={areaPoints}
        fill={color}
        fillOpacity={fillOpacity}
        className="sparkline-area"
      />
      {/* 线条 */}
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="sparkline-line"
      />
      {/* 数据点 */}
      {showDots && data.map((value, index) => {
        const x = (index / (data.length - 1)) * width;
        const y = isFlat ? height / 2 : height - ((value - min) / range!) * height;
        return (
          <circle
            key={index}
            cx={x}
            cy={y}
            r={2}
            fill={color}
            className="sparkline-dot"
          />
        );
      })}
    </svg>
  );
}

/**
 * MiniBarChart - 迷你柱状图
 * 用于展示对比数据
 */

interface MiniBarChartProps {
  data: number[];
  labels?: string[];
  width?: number;
  height?: number;
  color?: string;
  barWidth?: number;
  gap?: number;
}

export function MiniBarChart({
  data,
  labels,
  width = 100,
  height = 40,
  color = 'var(--accent)',
  barWidth = 6,
  gap = 4,
}: MiniBarChartProps) {
  if (!data || data.length === 0) {
    return <span className="chart-empty">-</span>;
  }

  const max = Math.max(...data, 1);
  const totalWidth = data.length * (barWidth + gap) - gap;
  const startX = (width - totalWidth) / 2;

  return (
    <svg
      className="mini-bar-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {data.map((value, index) => {
        const barHeight = (value / max) * (height - 4);
        const x = startX + index * (barWidth + gap);
        const y = height - barHeight - 2;
        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            fill={color}
            rx={2}
            className="bar"
          >
            {labels && (
              <title>{labels[index]}: {value}</title>
            )}
          </rect>
        );
      })}
    </svg>
  );
}

/**
 * DonutChart - 环形图
 * 用于展示比例数据
 */

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  showLabels?: boolean;
}

export function DonutChart({
  segments,
  size = 80,
  strokeWidth = 8,
  showLabels = true,
}: DonutChartProps) {
  if (!segments || segments.length === 0) {
    return <span className="chart-empty">-</span>;
  }

  const total = Math.abs(segments.reduce((sum, s) => sum + s.value, 0));
  
  // Handle zero total case
  if (total === 0) {
    return <span className="chart-empty">No data</span>;
  }

  const radius = (size - strokeWidth) / 2;
  const center = size / 2;

  let currentAngle = -90; // 从顶部开始

  const paths = segments.map((segment, index) => {
    const percentage = Math.abs(segment.value) / Math.abs(total);
    const angle = percentage * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;

    // 转换为弧度
    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;

    // 计算弧线端点
    const x1 = center + radius * Math.cos(startRad);
    const y1 = center + radius * Math.sin(startRad);
    const x2 = center + radius * Math.cos(endRad);
    const y2 = center + radius * Math.sin(endRad);

    // 大弧标志
    const largeArc = angle > 180 ? 1 : 0;

    const path = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;

    currentAngle = endAngle;

    return {
      ...segment,
      path,
      percentage,
      key: index,
    };
  });

  return (
    <div className="donut-chart-wrapper">
      <svg
        className="donut-chart"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        {/* 背景圆环 */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeWidth}
        />
        {/* 数据弧线 */}
        {paths.map((segment) => (
          <path
            key={segment.key}
            d={segment.path}
            fill="none"
            stroke={segment.color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            className="donut-segment"
          >
            <title>{segment.label}: {segment.value} ({(segment.percentage * 100).toFixed(1)}%)</title>
          </path>
        ))}
        {/* 中心数值 */}
        <text
          x={center}
          y={center - 4}
          textAnchor="middle"
          className="donut-total"
        >
          {total}
        </text>
        <text
          x={center}
          y={center + 12}
          textAnchor="middle"
          className="donut-label"
        >
          total
        </text>
      </svg>
      {showLabels && (
        <div className="donut-legend">
          {paths.map((segment) => (
            <div key={segment.key} className="legend-item">
              <span
                className="legend-color"
                style={{ background: segment.color }}
              />
              <span className="legend-label">{segment.label}</span>
              <span className="legend-value">{segment.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * TrendIndicator - 趋势指示器
 * 展示数值变化方向
 */

interface TrendIndicatorProps {
  value: number;
  previousValue: number;
  showPercent?: boolean;
}

export function TrendIndicator({
  value,
  previousValue,
  showPercent = true,
}: TrendIndicatorProps) {
  if (previousValue === 0) {
    return <span className="trend-neutral">-</span>;
  }

  const change = value - previousValue;
  const percentChange = (change / previousValue) * 100;

  const isPositive = change > 0;
  const isNegative = change < 0;

  const direction = isPositive ? '↑' : isNegative ? '↓' : '→';
  const percentText = showPercent ? `${Math.abs(percentChange).toFixed(1)}%` : '';

  return (
    <span
      className={`trend-indicator ${
        isPositive ? 'trend-up' : isNegative ? 'trend-down' : 'trend-neutral'
      }`}
      aria-label={`${isPositive ? 'Increase' : isNegative ? 'Decrease' : 'No change'} of ${percentText}`}
    >
      <span className="trend-direction">{direction}</span>
      {percentText && <span className="trend-percent">{percentText}</span>}
    </span>
  );
}

/**
 * StatCard - 统计卡片（带趋势图）
 */

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: number[];
  trendLabel?: string;
  status?: 'success' | 'warning' | 'error' | 'info';
}

export function StatCard({
  label,
  value,
  trend,
  trendLabel,
  status = 'info',
}: StatCardProps) {
  const statusColors: Record<string, string> = {
    success: 'var(--success)',
    warning: 'var(--warning)',
    error: 'var(--error)',
    info: 'var(--accent)',
  };

  return (
    <div className={`stat-card stat-card--${status}`}>
      <div className="stat-content">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
        {trendLabel && <span className="stat-trend-label">{trendLabel}</span>}
      </div>
      {trend && trend.length >= 2 && (
        <div className="stat-sparkline">
          <Sparkline
            data={trend}
            width={50}
            height={20}
            color={statusColors[status]}
          />
        </div>
      )}
    </div>
  );
}

/**
 * TimeRangeSelector - 时间范围选择器
 * 用于控制图表数据的时间范围
 */

interface TimeRangeSelectorProps {
  value: number;
  onChange: (days: number) => void;
  options?: number[];
}

export function TimeRangeSelector({
  value,
  onChange,
  options = [7, 14, 30],
}: TimeRangeSelectorProps) {
  return (
    <div className="time-range-selector">
      {options.map((days) => (
        <button
          key={days}
          className={`time-range-option ${value === days ? 'active' : ''}`}
          onClick={() => onChange(days)}
        >
          {days}天
        </button>
      ))}
    </div>
  );
}

/**
 * GroupedBarChart - 分组柱状图
 * 用于展示多组对比数据（如 created vs completed）
 */

interface GroupedBarChartProps {
  data: Array<{
    label: string;
    values: number[];
  }>;
  colors?: string[];
  width?: number;
  height?: number;
  barWidth?: number;
  groupGap?: number;
}

export function GroupedBarChart({
  data,
  colors = ['var(--accent)', 'var(--earth-tan)'],
  width = 280,
  height = 60,
  barWidth = 4,
  groupGap = 8,
}: GroupedBarChartProps) {
  if (!data || data.length === 0) {
    return <span className="chart-empty">-</span>;
  }

  // 找出最大值
  const maxValue = Math.max(...data.flatMap((d) => d.values), 1);
  const numBars = data[0]?.values.length || 1;
  const groupWidth = numBars * barWidth + (numBars - 1) * 2;
  const totalWidth = data.length * groupWidth + (data.length - 1) * groupGap;
  const startX = (width - totalWidth) / 2;

  return (
    <svg
      className="grouped-bar-chart"
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {data.map((group, groupIndex) => {
        const groupX = startX + groupIndex * (groupWidth + groupGap);
        return group.values.map((value, barIndex) => {
          const barHeight = (value / maxValue) * (height - 8);
          const x = groupX + (barIndex + 1) * (barWidth + 2);
          const y = height - barHeight - 4;
          return (
            <rect
              key={`${groupIndex}-${barIndex}`}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              fill={colors[barIndex] || colors[0]}
              rx={2}
              className="bar"
            >
              <title>{group.label}: {value}</title>
            </rect>
          );
        });
      })}
    </svg>
  );
}

/**
 * CollapsiblePanel - 可折叠面板
 */

import { ChevronDown, ChevronUp } from 'lucide-react';

interface CollapsiblePanelProps {
  title: string;
  badge?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function CollapsiblePanel({
  title,
  badge,
  defaultCollapsed = false,
  children,
  className = '',
}: CollapsiblePanelProps) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  return (
    <section className={`panel collapsible-panel ${collapsed ? 'collapsed' : ''} ${className}`}>
      <div
        className="panel-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="panel-header-left">
          <h3>{title}</h3>
          {badge}
        </div>
        <button className="collapse-toggle" onClick={(e) => { e.stopPropagation(); }}>
          {collapsed ? (
            <ChevronDown strokeWidth={1.75} size={18} />
          ) : (
            <ChevronUp strokeWidth={1.75} size={18} />
          )}
        </button>
      </div>
      {!collapsed && <div className="panel-content">{children}</div>}
    </section>
  );
}

/**
 * BulletChart - 子弹图（Performance vs Target）
 * 用于展示 GFI vs 阈值，带安全/警告/危险分区
 */

interface BulletChartProps {
  value: number;
  target: number;
  peak?: number;
  max?: number;
  width?: number;
  height?: number;
  unit?: string;
}

export function BulletChart({
  value,
  target,
  peak,
  max = 150,
  width = 200,
  height = 28,
  unit = '',
}: BulletChartProps) {
  const pct = Math.min(value / max, 1);
  const targetPct = Math.min(target / max, 1);
  const peakPct = peak ? Math.min(peak / max, 1) : 0;

  // Zones
  const safeEnd = 0.47;  // 70/150
  const warnEnd = 0.73;  // 110/150

  const barH = height * 0.5;
  const barY = (height - barH) / 2;

  return (
    <div className="bullet-chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {/* Background zones */}
        <rect x={0} y={barY} width={width * safeEnd} height={barH} fill="var(--success)" opacity={0.15} rx={3} />
        <rect x={width * safeEnd} y={barY} width={width * (warnEnd - safeEnd)} height={barH} fill="var(--warning)" opacity={0.15} />
        <rect x={width * warnEnd} y={barY} width={width * (1 - warnEnd)} height={barH} fill="var(--error)" opacity={0.15} rx={3} />

        {/* Value bar */}
        <rect
          x={0} y={barY}
          width={Math.max(width * pct, 2)}
          height={barH}
          fill={value >= target ? 'var(--error)' : value >= target * 0.7 ? 'var(--warning)' : 'var(--success)'}
          rx={3}
        >
          <title>{`GFI: ${value}${unit} | 阈值: ${target}${unit}`}{peak ? ` | 今日峰值: ${peak}${unit}` : ''}</title>
        </rect>

        {/* Target marker */}
        <line
          x1={width * targetPct} y1={barY - 2}
          x2={width * targetPct} y2={barY + barH + 2}
          stroke="var(--text-primary)" strokeWidth={2} opacity={0.7}
        />

        {/* Peak marker */}
        {peakPct > pct && (
          <circle cx={width * peakPct} cy={height / 2} r={3} fill="var(--warning)" opacity={0.8} />
        )}
      </svg>
      <div className="bullet-labels" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
        <span>0</span>
        <span style={{ position: 'relative', left: `-${width * targetPct * 0.3}px` }}>阈值 {target}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

/**
 * GaugeChart - 半圆仪表盘
 * 用于展示 Trust Score (0-100)
 */

interface GaugeChartProps {
  value: number;
  max?: number;
  label: string;
  sublabel?: string;
  size?: number;
  segments?: Array<{ label: string; color: string; max: number }>;
}

export function GaugeChart({
  value,
  max = 100,
  label,
  sublabel,
  size = 100,
  segments = [
    { label: 'Observer', color: 'var(--text-secondary)', max: 30 },
    { label: 'Editor', color: 'var(--info)', max: 60 },
    { label: 'Developer', color: 'var(--accent)', max: 80 },
    { label: 'Architect', color: 'var(--success)', max: 100 },
  ],
}: GaugeChartProps) {
  const pct = Math.min(value / max, 1);
  const radius = (size - 16) / 2;
  const center = size / 2;
  const circumference = Math.PI * radius;
  const arcLength = circumference * pct;

  // Find current segment
  const currentSeg = segments.find(s => value <= s.max) ?? segments[segments.length - 1];

  return (
    <div className="gauge-chart" style={{ textAlign: 'center' }}>
      <svg width={size} height={size / 2 + 20} viewBox={`0 0 ${size} ${size / 2 + 20}`}>
        {/* Background arc */}
        <path
          d={`M ${center - radius} ${center} A ${radius} ${radius} 0 0 1 ${center + radius} ${center}`}
          fill="none"
          stroke="var(--bg-sunken)"
          strokeWidth={8}
          strokeLinecap="round"
        />
        {/* Value arc */}
        <path
          d={`M ${center - radius} ${center} A ${radius} ${radius} 0 0 1 ${center + radius} ${center}`}
          fill="none"
          stroke={currentSeg.color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`}
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
        {/* Value text */}
        <text
          x={center} y={center - 4}
          textAnchor="middle"
          fontSize="18"
          fontWeight="600"
          fill="var(--text-primary)"
        >
          {value}
        </text>
      </svg>
      <div style={{ fontSize: '0.75rem', color: currentSeg.color, fontWeight: 500 }}>{label}</div>
      {sublabel && <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{sublabel}</div>}
    </div>
  );
}

/**
 * PrincipleStack - 原则状态堆叠
 * 展示原则分布
 */

interface PrincipleStackProps {
  candidate: number;
  probation: number;
  active: number;
  deprecated: number;
}

export function PrincipleStack({ candidate, probation, active, deprecated }: PrincipleStackProps) {
  const total = candidate + probation + active + deprecated;
  const segs = [
    { label: 'Active', value: active, color: 'var(--success)' },
    { label: 'Probation', value: probation, color: 'var(--warning)' },
    { label: 'Candidate', value: candidate, color: 'var(--info)' },
    { label: 'Deprecated', value: deprecated, color: 'var(--text-secondary)' },
  ].filter(s => s.value > 0);

  if (total === 0) {
    return (
      <div className="principle-stack" style={{ textAlign: 'center', padding: 'var(--space-3)', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        No principles yet
      </div>
    );
  }

  return (
    <div className="principle-stack">
      {/* Stacked bar */}
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
        {segs.map(seg => (
          <div
            key={seg.label}
            style={{
              width: `${(seg.value / total) * 100}%`,
              backgroundColor: seg.color,
              transition: 'width 0.3s ease',
            }}
            title={`${seg.label}: ${seg.value}`}
          />
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: '0.7rem' }}>
        {segs.map(seg => (
          <span key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: seg.color, display: 'inline-block' }} />
            <span style={{ color: 'var(--text-secondary)' }}>{seg.label}</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{seg.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * QueueBar - 队列状态条
 * 展示 pending/in-progress/completed
 */

interface QueueBarProps {
  pending: number;
  inProgress: number;
  completed: number;
}

export function QueueBar({ pending, inProgress, completed }: QueueBarProps) {
  const total = pending + inProgress + completed;
  const items = [
    { label: 'Pending', value: pending, color: 'var(--warning)' },
    { label: 'In Progress', value: inProgress, color: 'var(--info)' },
    { label: 'Completed', value: completed, color: 'var(--success)' },
  ];

  if (total === 0) {
    return (
      <div className="queue-bar" style={{ textAlign: 'center', padding: 'var(--space-3)', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        Queue empty
      </div>
    );
  }

  return (
    <div className="queue-bar">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: item.color, flexShrink: 0 }} />
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', minWidth: 55 }}>{item.label}</span>
            <div style={{ flex: 1, height: 6, backgroundColor: 'var(--bg-sunken)', borderRadius: 3, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${(item.value / total) * 100}%`,
                  height: '100%',
                  backgroundColor: item.color,
                  borderRadius: 3,
                  minWidth: item.value > 0 ? 4 : 0,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)', minWidth: 20, textAlign: 'right' }}>{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
