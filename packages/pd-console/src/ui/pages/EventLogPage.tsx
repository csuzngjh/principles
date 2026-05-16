import { useState, useEffect, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/page-header.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { Input } from '../components/ui/input.js';
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  RefreshCw,
  Link,
  Clock,
  AlertTriangle,
  Search,
} from 'lucide-react';
import { fetchEvents, fetchEventsGrouped, fetchRelatedEvents } from '../api.js';
import type { EventLogEntry } from '../api.js';
import { formatDate } from '../utils/format.js';

const EVENT_COLORS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pain_signal: 'destructive',
  gate_block: 'destructive',
  empathy_rollback: 'secondary',
};

const COMMON_EVENT_TYPES = [
  'all',
  'pain_signal',
  'gate_block',
  'diagnosis_task',
  'evolution_task',
  'principle_candidate',
  'rule_promotion',
  'empathy_rollback',
];

export function EventLogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(() => {
    const p = searchParams.get("page");
    return p ? Math.max(1, parseInt(p, 10) || 1) : 1;
  });
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [pageSize] = useState(50);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(() => {
    const typesParam = searchParams.get("types");
    if (typesParam) {
      return typesParam.split(",").filter((t) => COMMON_EVENT_TYPES.includes(t));
    }
    const typeParam = searchParams.get("type");
    return typeParam && COMMON_EVENT_TYPES.includes(typeParam) ? [typeParam] : [];
  });
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("search") ?? "");
  const [startDate, setStartDate] = useState(() => searchParams.get("start") ?? "");
  const [endDate, setEndDate] = useState(() => searchParams.get("end") ?? "");
  const [typeCounts, setTypeCounts] = useState<Record<string, number> | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [relatedEvents, setRelatedEvents] = useState<EventLogEntry[] | null>(null);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const loadEvents = async (newPage = 1) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchEvents({
        types: selectedTypes.length > 0 ? selectedTypes : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        searchQuery: searchQuery || undefined,
        page: newPage,
        pageSize,
      });
      if (!result.success) {
        setError(result.error || 'Failed to load events');
      } else if (result.data) {
        setEvents(result.data.events);
        setTotal(result.data.total);
        setTotalPages(result.data.totalPages);
        setPage(newPage);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const loadTypeCounts = async () => {
    try {
      const result = await fetchEventsGrouped();
      if (result.success && result.data) {
        setTypeCounts(result.data);
      }
    } catch {
      // ignore
    }
  };

  const loadRelatedEvents = async (eventId: string) => {
    setLoadingRelated(true);
    try {
      const result = await fetchRelatedEvents(eventId, 10);
      if (result.success && result.data) {
        setRelatedEvents(result.data.events);
      }
    } catch {
      // ignore
    } finally {
      setLoadingRelated(false);
    }
  };

  useEffect(() => {
    loadEvents();
    loadTypeCounts();
  }, []);

  useEffect(() => {
    setPage(1);
    loadEvents(1);
  }, [selectedTypes, searchQuery, startDate, endDate]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedTypes.length > 0) params.set("types", selectedTypes.join(","));
    if (searchQuery) params.set("search", searchQuery);
    if (startDate) params.set("start", startDate);
    if (endDate) params.set("end", endDate);
    if (page > 1) params.set("page", String(page));
    setSearchParams(params, { replace: true });
  }, [selectedTypes, searchQuery, startDate, endDate, page, setSearchParams]);

  const handleTypeToggle = (type: string) => {
    if (type === 'all') {
      setSelectedTypes([]);
    } else {
      if (selectedTypes.includes(type)) {
        setSelectedTypes(selectedTypes.filter(t => t !== type));
      } else {
        setSelectedTypes([...selectedTypes, type]);
      }
    }
  };

  const handleEventClick = (event: EventLogEntry) => {
    if (selectedEventId === event.id) {
      setSelectedEventId(null);
      setRelatedEvents(null);
    } else {
      setSelectedEventId(event.id);
      loadRelatedEvents(event.id);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("pages:eventLog.title")}
        description={t("pages:eventLog.description")}
        onRefresh={() => loadEvents(page)}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex justify-between items-center">
            <CardTitle className="text-base">{t("pages:eventLog.filter")}</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="w-4 h-4 mr-2" />
              {showFilters ? t("pages:eventLog.collapse") : t("pages:eventLog.expand")}
            </Button>
          </div>
        </CardHeader>
        {showFilters && (
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{t("pages:eventLog.eventType")}</p>
              <div className="flex flex-wrap gap-2">
                {COMMON_EVENT_TYPES.map(type => (
                  <Badge
                    key={type}
                    variant={
                      type === 'all'
                        ? selectedTypes.length === 0
                          ? 'default'
                          : 'outline'
                        : selectedTypes.includes(type)
                        ? EVENT_COLORS[type] || 'default'
                        : 'outline'
                    }
                    className="cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleTypeToggle(type)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleTypeToggle(type); } }}
                  >
                    {type}
                    {typeCounts && typeCounts[type] !== undefined && (
                      <span className="ml-1">({typeCounts[type]})</span>
                    )}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="start-date" className="text-sm text-muted-foreground mb-1 block">{t("pages:eventLog.startDate")}</label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setStartDate(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="end-date" className="text-sm text-muted-foreground mb-1 block">{t("pages:eventLog.endDate")}</label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="event-search" className="text-sm text-muted-foreground mb-1 block">{t("common:search")}</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="event-search"
                      type="text"
                      placeholder={t("pages:eventLog.searchPlaceholder")}
                      value={searchQuery}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                      className="h-9 pl-8"
                    />
                  </div>
                  <Button onClick={() => setSearchQuery('')} variant="ghost">
                    {t("pages:eventLog.clear")}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setSelectedTypes([]);
                  setSearchQuery('');
                  setStartDate('');
                  setEndDate('');
                  setSearchParams({}, { replace: true });
                }}
                variant="ghost"
              >
                {t("pages:eventLog.reset")}
              </Button>
              <Button
                onClick={() => loadEvents(page)}
                className="ml-2"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {t("pages:eventLog.apply")}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {error && (
        <Card className="border-destructive/20 bg-destructive/10">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-4 h-4" />
              <p>{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              显示 {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} / {total}
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => loadEvents(page - 1)}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="py-2 px-3 text-sm">{page} / {totalPages || 1}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => loadEvents(page + 1)}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="h-[600px] overflow-y-auto">
                {loading && !events.length ? (
                  <div className="p-8 text-center">
                    <div className="animate-pulse text-muted-foreground">{t("pages:eventLog.loading")}</div>
                  </div>
                ) : events.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    {t("pages:eventLog.noMatchingEvents")}
                  </div>
                ) : (
                  <div className="divide-y">
                    {events.map((event) => (
                      <div
                        key={event.id}
                        className={`p-4 hover:bg-muted/50 cursor-pointer transition-colors ${
                          selectedEventId === event.id ? 'bg-muted' : ''
                        }`}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleEventClick(event)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleEventClick(event); } }}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant={EVENT_COLORS[event.type] || 'default'}>
                              {event.type}
                            </Badge>
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDate(event.ts)}
                            </span>
                          </div>
                          {event.category && (
                            <Badge variant="outline">{event.category}</Badge>
                          )}
                        </div>
                        {event.data && (
                          <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                            {JSON.stringify(event.data, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-1">
          {selectedEventId && relatedEvents && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Link className="w-4 h-4" />
                  {t("pages:eventLog.relatedEvents")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {loadingRelated ? (
                  <div className="text-sm text-muted-foreground animate-pulse">
                    {t("pages:eventLog.loading")}
                  </div>
                ) : relatedEvents.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    {t("pages:eventLog.noRelatedEvents")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {relatedEvents.map((event) => (
                      <div
                        key={event.id}
                        className={`p-2 rounded text-sm ${
                          event.id === selectedEventId ? 'bg-primary/10' : 'bg-muted'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={EVENT_COLORS[event.type] || 'outline'} className="text-xs">
                            {event.type}
                          </Badge>
                          {event.id === selectedEventId && (
                            <Badge variant="default" className="text-xs">{t("pages:eventLog.current")}</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(event.ts)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {typeCounts && (
            <Card className="mt-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t("pages:eventLog.eventStats")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Badge variant={EVENT_COLORS[type] || 'outline'} className="text-xs">
                        {type}
                      </Badge>
                    </span>
                    <span className="font-mono">{count}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
