import React from 'react';

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
  const range = max - min || 1;

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - ((value - min) / range) * height;
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
        const y = height - ((value - min) / range) * height;
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

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let currentAngle = -90; // 从顶部开始

  const paths = segments.map((segment, index) => {
    const percentage = segment.value / total;
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

  return (
    <span
      className={`trend-indicator ${
        isPositive ? 'trend-up' : isNegative ? 'trend-down' : 'trend-neutral'
      }`}
    >
      {isPositive && '↑'}
      {isNegative && '↓'}
      {!isPositive && !isNegative && '→'}
      {showPercent && (
        <span className="trend-percent">
          {Math.abs(percentChange).toFixed(1)}%
        </span>
      )}
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
  width = 200,
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
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {data.map((group, groupIndex) => {
        const groupX = startX + groupIndex * (groupWidth + groupGap);
        return group.values.map((value, barIndex) => {
          const barHeight = (value / maxValue) * (height - 8);
          const x = groupX + barIndex * (barWidth + 2);
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
        <button className="collapse-toggle" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
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
