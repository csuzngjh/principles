import { useState, useEffect, type ChangeEvent } from 'react';
import { PageHeader } from '../components/page-header.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
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

const EVENT_COLORS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pain_signal: 'destructive',
  gate_block: 'destructive',
  empathy_rollback: 'secondary',
};

const COMMON_EVENT_TYPES = [
  'all',
  'pain_signal',
  'gate_block',
  'task_created',
  'diagnostician_run',
  'candidate_generated',
  'principle_added',
  'empathy_rollback',
];

export function EventLogPage() {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [pageSize] = useState(50);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
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

  const formatDate = (ts: string) => {
    const date = new Date(ts);
    return date.toLocaleString();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="事件日志"
        description="查看和分析系统事件记录"
        onRefresh={() => loadEvents(page)}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex justify-between items-center">
            <CardTitle className="text-base">过滤器</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="w-4 h-4 mr-2" />
              {showFilters ? '收起' : '展开'}
            </Button>
          </div>
        </CardHeader>
        {showFilters && (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">事件类型</p>
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
                    onClick={() => handleTypeToggle(type)}
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
                <p className="text-sm text-muted-foreground mb-1">开始日期</p>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setStartDate(e.target.value)}
                  className="w-full h-9 px-3 py-1 text-sm border border-input bg-background rounded-md"
                />
              </div>
              <div className="flex-1 min-w-[200px]">
                <p className="text-sm text-muted-foreground mb-1">结束日期</p>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
                  className="w-full h-9 px-3 py-1 text-sm border border-input bg-background rounded-md"
                />
              </div>
              <div className="flex-1 min-w-[200px]">
                <p className="text-sm text-muted-foreground mb-1">搜索</p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="搜索事件内容..."
                      value={searchQuery}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                      className="w-full h-9 pl-8 pr-3 py-1 text-sm border border-input bg-background rounded-md"
                    />
                  </div>
                  <Button onClick={() => setSearchQuery('')} variant="ghost">
                    清除
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
                }}
                variant="ghost"
              >
                重置
              </Button>
              <Button
                onClick={() => loadEvents(page)}
                className="ml-2"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                应用
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:bg-red-950">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
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
                    <div className="animate-pulse text-muted-foreground">加载中...</div>
                  </div>
                ) : events.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    没有匹配的事件
                  </div>
                ) : (
                  <div className="divide-y">
                    {events.map((event) => (
                      <div
                        key={event.id}
                        className={`p-4 hover:bg-muted/50 cursor-pointer transition-colors ${
                          selectedEventId === event.id ? 'bg-muted' : ''
                        }`}
                        onClick={() => handleEventClick(event)}
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
                  相关事件
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {loadingRelated ? (
                  <div className="text-sm text-muted-foreground animate-pulse">
                    加载中...
                  </div>
                ) : relatedEvents.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    没有相关事件
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
                            <Badge variant="default" className="text-xs">当前</Badge>
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
                <CardTitle className="text-base">事件统计</CardTitle>
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
