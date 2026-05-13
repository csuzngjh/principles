import { useState, useEffect, useCallback, useRef } from "react";

interface AutoRefreshState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  lastUpdated: string | null;
}

export function useAutoRefresh<T>(
  fetcher: () => Promise<{ success: boolean; data?: T; error?: string }>,
  intervalMs = 30000,
  enabled = true,
): AutoRefreshState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (result.success && result.data !== undefined) {
          setData(result.data);
          setError(null);
        } else {
          setError(result.error ?? "Unknown error");
        }
        setLastUpdated(new Date().toISOString());
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Network error");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();

    timerRef.current = setInterval(refresh, intervalMs);

    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, intervalMs, refresh]);

  return { data, error, loading, refresh, lastUpdated };
}
