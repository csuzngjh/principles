import { useEffect, useRef, useState, useCallback } from 'react';

interface UseAutoRefreshOptions {
  intervalMs: number;
  enabled?: boolean;
}

export function useAutoRefresh(refreshFn: () => void | Promise<void>, options: UseAutoRefreshOptions) {
  const { intervalMs, enabled = true } = options;
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshFnRef = useRef(refreshFn);

  useEffect(() => {
    refreshFnRef.current = refreshFn;
  }, [refreshFn]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshFnRef.current();
      setLastRefresh(new Date());
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const timer = setInterval(() => {
      refresh();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs, enabled, refresh]);

  return { lastRefresh, isRefreshing, refresh };
}
