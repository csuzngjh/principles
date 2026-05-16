import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from './ui/badge.js';

type FreshnessLevel = 'fresh' | 'stale' | 'critical';

interface DataFreshnessIndicatorProps {
  lastUpdateTime: string | null | undefined;
  label: string;
  thresholdMinutes?: { stale: number; critical: number };
}

function formatTimeAgo(timestamp: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  const now = new Date();
  const time = new Date(timestamp);
  const diffMs = now.getTime() - time.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return t('components:dataFreshness.justNow');
  if (diffMin < 60) return t('components:pageHeader.minutesAgo', { count: diffMin });
  if (diffHour < 24) return t('components:pageHeader.hoursAgo', { count: diffHour });
  return t('components:pageHeader.daysAgo', { count: diffDay });
}

export function DataFreshnessIndicator({
  lastUpdateTime,
  label,
  thresholdMinutes = { stale: 5, critical: 15 },
}: DataFreshnessIndicatorProps) {
  const { t } = useTranslation();
  const [freshness, setFreshness] = useState<FreshnessLevel>('fresh');
  const [timeAgo, setTimeAgo] = useState('');

  useEffect(() => {
    if (!lastUpdateTime) {
      setFreshness('critical');
      setTimeAgo(t('components:dataFreshness.never'));
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
      setTimeAgo(formatTimeAgo(lastUpdateTime, t));
    };

    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, [lastUpdateTime, thresholdMinutes, t]);

  const getBadgeVariant = (): 'default' | 'secondary' | 'destructive' => {
    switch (freshness) {
      case 'fresh': return 'default';
      case 'stale': return 'secondary';
      case 'critical': return 'destructive';
    }
  };

  const getStatusText = () => {
    switch (freshness) {
      case 'fresh': return t('components:dataFreshness.upToDate');
      case 'stale': return t('components:dataFreshness.slightlyDelayed');
      case 'critical': return t('components:dataFreshness.stale');
    }
  };

  return (
    <Badge variant={getBadgeVariant()}>
      {label}: {getStatusText()} ({timeAgo})
    </Badge>
  );
}
