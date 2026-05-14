import { useState, useEffect } from 'react';
import { Badge } from './ui/badge.js';

type FreshnessLevel = 'fresh' | 'stale' | 'critical';

interface DataFreshnessIndicatorProps {
  lastUpdateTime: string | null | undefined;
  label: string;
  thresholdMinutes?: { stale: number; critical: number };
}

function formatTimeAgo(timestamp: string): string {
  const now = new Date();
  const time = new Date(timestamp);
  const diffMs = now.getTime() - time.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

export function DataFreshnessIndicator({
  lastUpdateTime,
  label,
  thresholdMinutes = { stale: 5, critical: 15 },
}: DataFreshnessIndicatorProps) {
  const [freshness, setFreshness] = useState<FreshnessLevel>('fresh');
  const [timeAgo, setTimeAgo] = useState('');

  useEffect(() => {
    if (!lastUpdateTime) {
      setFreshness('critical');
      setTimeAgo('never');
      return;
    }

    const update = () => {
      const now = new Date();
      const time = new Date(lastUpdateTime);
      const diffMs = now.getTime() - time.getTime();
      const diffMin = diffMs / (1000 * 60);

      let level: FreshnessLevel = 'fresh';
      if (diffMin > thresholdMinutes.critical) level = 'critical';
      else if (diffMin > thresholdMinutes.stale) level = 'stale';

      setFreshness(level);
      setTimeAgo(formatTimeAgo(lastUpdateTime));
    };

    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, [lastUpdateTime, thresholdMinutes]);

  const getBadgeVariant = (): 'default' | 'secondary' | 'destructive' => {
    switch (freshness) {
      case 'fresh': return 'default';
      case 'stale': return 'secondary';
      case 'critical': return 'destructive';
    }
  };

  const getStatusText = () => {
    switch (freshness) {
      case 'fresh': return 'up to date';
      case 'stale': return 'slightly delayed';
      case 'critical': return 'stale';
    }
  };

  return (
    <Badge variant={getBadgeVariant()}>
      {label}: {getStatusText()} ({timeAgo})
    </Badge>
  );
}
