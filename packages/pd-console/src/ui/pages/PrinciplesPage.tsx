import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchPrinciples, fetchPrincipleDetail } from "../api.js";
import type { PrincipleListItem, PrincipleDetail, RuleItem } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Button } from "../components/ui/button.js";
import { ValueScoreBar, AdherenceBar } from "../components/ui/progress-bar.js";
import { DonutChartWithLegend, HorizontalBarChart, CoverageIndicator, Histogram, computeValueBuckets } from "../components/ui/charts.js";
import { CompareView } from "../components/compare-view.js";
import { TruncatedText } from "../components/ui/markdown.js";
import { useDebounce } from "../hooks/useDebounce.js";
import { useKeyboardNavigation, useFocusSearch } from "../hooks/useKeyboardNavigation.js";
import { useBookmarks } from "../hooks/useBookmarks.js";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Shield,
  FileSearch,
  Inbox,
  X,
  ExternalLink,
  BarChart3,
  Bookmark,
  BookmarkCheck,
  CheckSquare,
  Square,
  Download,
  GitCompare,
} from "lucide-react";
import { cn } from "../../lib/utils.js";

type PrincipleStatus = PrincipleListItem["status"];
type PrinciplePriority = PrincipleListItem["priority"];
type PrincipleScope = PrincipleListItem["scope"];
type PrincipleEvaluability = PrincipleListItem["evaluability"];

const STATUS_COLORS: Record<PrincipleStatus, string> = {
  candidate: "text-amber-500",
  probation: "text-blue-500",
  active: "text-primary",
  deprecated: "text-destructive",
  archived: "text-muted-foreground",
};

const STATUS_BG: Record<PrincipleStatus, string> = {
  candidate: "bg-amber-50 dark:bg-amber-950/20",
  probation: "bg-blue-50 dark:bg-blue-950/20",
  active: "bg-primary/10",
  deprecated: "bg-destructive/10",
  archived: "bg-muted",
};

const PRIORITY_COLORS: Record<PrinciplePriority, string> = {
  P0: "text-destructive",
  P1: "text-amber-500",
  P2: "text-muted-foreground",
};

const ENFORCEMENT_COLORS: Record<string, string> = {
  block: "text-destructive",
  warn: "text-amber-500",
  log: "text-muted-foreground",
};

const RULE_TYPE_LABELS: Record<string, string> = {
  hook: "Hook",
  gate: "Gate",
  skill: "Skill",
  lora: "LoRA",
  test: "Test",
  prompt: "Prompt",
};

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Card className="transition-all duration-200 hover:shadow-md">
      <CardContent className="p-4 text-center">
        <div className={cn("text-2xl font-bold", color)}>{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{label}</div>
      </CardContent>
    </Card>
  );
}

function RuleCard({ rule }: { rule: RuleItem }) {
  const { t } = useTranslation();
  return (
    <div className="p-3 rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 mb-2">
        <Badge variant="outline" className="text-xs">
          {RULE_TYPE_LABELS[rule.type] ?? rule.type}
        </Badge>
        <Badge variant="outline" className={cn("text-xs", ENFORCEMENT_COLORS[rule.enforcement] ?? "")}>
          {rule.enforcement.toUpperCase()}
        </Badge>
        <Badge variant="secondary" className="text-xs">
          {rule.status}
        </Badge>
        <span className="text-sm font-medium ml-auto">{rule.name || rule.id}</span>
      </div>
      {rule.triggerCondition && (
        <div className="text-xs text-muted-foreground mb-1">
          <span className="font-medium">{t("pages:principles.triggerCondition")}:</span> {rule.triggerCondition}
        </div>
      )}
      {rule.action && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{t("pages:principles.action")}:</span> {rule.action}
        </div>
      )}
    </div>
  );
}

interface PrincipleRowProps {
  principle: PrincipleListItem;
  expanded: boolean;
  onToggle: () => void;
  detail: PrincipleDetail | null;
  detailLoading: boolean;
  isSelected: boolean;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  selectionMode: boolean;
  isChecked: boolean;
  onToggleCheck: () => void;
}

function PrincipleRow({ principle, expanded, onToggle, detail, detailLoading, isSelected, isBookmarked, onToggleBookmark, selectionMode, isChecked, onToggleCheck }: PrincipleRowProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "border-b border-border last:border-0 transition-colors",
        isSelected && "bg-accent/70"
      )}
    >
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={selectionMode ? onToggleCheck : onToggle}
      >
        {selectionMode && (
          <div className="mt-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <button onClick={onToggleCheck} className="text-muted-foreground hover:text-foreground">
              {isChecked ? (
                <CheckSquare className="h-4 w-4 text-primary" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
          </div>
        )}
        <div className="mt-0.5 flex-shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-medium text-sm">{principle.id}</span>
            <Link
              to={`/principles/${principle.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title={t("pages:principles.viewDetail")}
            >
              <ExternalLink className="h-3 w-3" />
            </Link>
            <Badge variant="outline" className={cn("text-xs", STATUS_COLORS[principle.status])}>
              {principle.status}
            </Badge>
            <Badge variant="outline" className={cn("text-xs", PRIORITY_COLORS[principle.priority])}>
              {principle.priority}
            </Badge>
            {principle.scope === "domain" && principle.domain && (
              <Badge variant="secondary" className="text-xs">
                {principle.domain}
              </Badge>
            )}
            {principle.ruleCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                <Shield className="h-3 w-3 mr-1" />
                {principle.ruleCount} {t("pages:principles.rules")}
              </Badge>
            )}
          </div>
          <TruncatedText text={principle.text} maxLines={2} className="text-xs text-muted-foreground" />
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{t("pages:principles.valueScore")}:</span>
              <ValueScoreBar valueScore={principle.valueScore} className="flex-1" />
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{t("pages:principles.adherence")}:</span>
              <AdherenceBar adherenceRate={principle.adherenceRate} className="flex-1" />
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {t("pages:principles.painPrevented")}: {principle.painPreventedCount}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleBookmark(); }}
            className={cn(
              "p-1 rounded transition-colors",
              isBookmarked ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
            title={isBookmarked ? t("pages:principles.removeBookmark") : t("pages:principles.addBookmark")}
          >
            {isBookmarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
          </button>
          <span className="text-xs text-muted-foreground">
            {principle.updatedAt ? new Date(principle.updatedAt).toLocaleDateString() : ""}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pl-11">
          {detailLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className={cn("p-2 rounded-md", STATUS_BG[principle.status])}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.triggerPattern")}</div>
                  <div className="text-xs font-medium mt-0.5">{principle.triggerPattern || "—"}</div>
                </div>
                <div className={cn("p-2 rounded-md", STATUS_BG[principle.status])}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.action")}</div>
                  <div className="text-xs font-medium mt-0.5">{principle.action || "—"}</div>
                </div>
                <div className={cn("p-2 rounded-md", STATUS_BG[principle.status])}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.evaluability")}</div>
                  <div className="text-xs font-medium mt-0.5">{principle.evaluability}</div>
                </div>
                <div className={cn("p-2 rounded-md", STATUS_BG[principle.status])}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.scope")}</div>
                  <div className="text-xs font-medium mt-0.5">
                    {principle.scope}{principle.domain ? ` / ${principle.domain}` : ""}
                  </div>
                </div>
              </div>

              {detail.conflictsWithPrincipleIds.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  {t("pages:principles.conflictsWith")}: {detail.conflictsWithPrincipleIds.join(", ")}
                </div>
              )}

              {detail.rules.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">
                    {t("pages:principles.associatedRules")} ({detail.rules.length})
                  </h4>
                  <div className="space-y-2">
                    {detail.rules.map((rule) => (
                      <RuleCard key={rule.id} rule={rule} />
                    ))}
                  </div>
                </div>
              )}

              {detail.rules.length === 0 && (
                <div className="text-xs text-muted-foreground italic">
                  {t("pages:principles.noRules")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
        {hasFilters ? (
          <FileSearch className="h-8 w-8 text-muted-foreground" />
        ) : (
          <Inbox className="h-8 w-8 text-muted-foreground" />
        )}
      </div>
      <h3 className="text-lg font-medium mb-2">
        {hasFilters ? t("pages:principles.noResults") : t("pages:principles.noPrinciples")}
      </h3>
      <p className="text-sm text-muted-foreground text-center mb-4 max-w-md">
        {hasFilters
          ? t("pages:principles.noResultsDescription")
          : t("pages:principles.noPrinciplesDescription")}
      </p>
      {hasFilters && (
        <Button variant="outline" onClick={onClear}>
          {t("common:clear")}
        </Button>
      )}
    </div>
  );
}

export function PrinciplesPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ principles: PrincipleListItem[]; summary: Record<string, number> } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [evaluabilityFilter, setEvaluabilityFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("valueScore");
  const [showBookmarkedOnly, setShowBookmarkedOnly] = useState(false);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [principleDetails, setPrincipleDetails] = useState<Record<string, PrincipleDetail>>({});
  const [loadingDetails, setLoadingDetails] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  const { bookmarks, toggleBookmark, isBookmarked } = useBookmarks();

  useFocusSearch({ enabled: true });

  const filteredPrinciples = useMemo(() => {
    if (!data) return [];
    let items = data.principles;

    if (statusFilter !== "all") {
      items = items.filter((p) => p.status === statusFilter);
    }
    if (scopeFilter !== "all") {
      items = items.filter((p) => p.scope === scopeFilter);
    }
    if (priorityFilter !== "all") {
      items = items.filter((p) => p.priority === priorityFilter);
    }
    if (evaluabilityFilter !== "all") {
      items = items.filter((p) => p.evaluability === evaluabilityFilter);
    }
    if (showBookmarkedOnly) {
      items = items.filter((p) => isBookmarked(p.id));
    }
    if (debouncedSearchQuery.trim()) {
      const q = debouncedSearchQuery.toLowerCase();
      items = items.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          p.text.toLowerCase().includes(q) ||
          p.triggerPattern.toLowerCase().includes(q) ||
          p.action.toLowerCase().includes(q) ||
          (p.domain ?? "").toLowerCase().includes(q),
      );
    }

    items = [...items].sort((a, b) => {
      switch (sortBy) {
        case "valueScore":
          return b.valueScore - a.valueScore;
        case "adherenceRate":
          return b.adherenceRate - a.adherenceRate;
        case "painPreventedCount":
          return b.painPreventedCount - a.painPreventedCount;
        case "updatedAt":
          return b.updatedAt.localeCompare(a.updatedAt);
        case "createdAt":
          return b.createdAt.localeCompare(a.createdAt);
        default:
          return 0;
      }
    });

    return items;
  }, [data, statusFilter, scopeFilter, priorityFilter, evaluabilityFilter, debouncedSearchQuery, sortBy, showBookmarkedOnly, isBookmarked]);

  const { resetSelection } = useKeyboardNavigation({
    itemCount: filteredPrinciples.length,
    onSelect: setSelectedIndex,
    enabled: true,
  });

  useEffect(() => {
    if (selectedIndex >= filteredPrinciples.length) {
      setSelectedIndex(filteredPrinciples.length - 1);
    } else if (selectedIndex < 0 && filteredPrinciples.length > 0) {
      setSelectedIndex(-1);
    }
  }, [filteredPrinciples.length]);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal);
    return () => controller.abort();
  }, []);

  function loadData(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    fetchPrinciples()
      .then((result) => {
        if (signal?.aborted) return;
        if (result.success && result.data) {
          setData(result.data);
        } else if (!result.success) {
          setError(result.error);
        }
      })
      .catch((err) => {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }

  function refreshData() {
    loadData();
  }

  const toggleExpand = useCallback(
    async (principleId: string) => {
      const next = new Set(expandedIds);
      if (next.has(principleId)) {
        next.delete(principleId);
      } else {
        next.add(principleId);
        if (!principleDetails[principleId]) {
          setLoadingDetails((prev) => new Set(prev).add(principleId));
          try {
            const result = await fetchPrincipleDetail(principleId);
            if (result.success && result.data) {
              setPrincipleDetails((prev) => ({
                ...prev,
                [principleId]: result.data.principle,
              }));
            }
          } catch {
            // ignore detail load errors
          } finally {
            setLoadingDetails((prev) => {
              const next = new Set(prev);
              next.delete(principleId);
              return next;
            });
          }
        }
      }
      setExpandedIds(next);
    },
    [expandedIds, principleDetails]
  );

  function handleRowClick(principleId: string) {
    const index = filteredPrinciples.findIndex((p) => p.id === principleId);
    if (index !== -1) {
      setSelectedIndex(index);
    }
    toggleExpand(principleId);
  }

  function clearFilters() {
    setSearchQuery("");
    setStatusFilter("all");
    setScopeFilter("all");
    setPriorityFilter("all");
    setEvaluabilityFilter("all");
    setShowBookmarkedOnly(false);
    resetSelection();
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleExport() {
    const exportData = selectionMode && selectedIds.size > 0
      ? filteredPrinciples.filter((p) => selectedIds.has(p.id))
      : filteredPrinciples;
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `principles-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCompare() {
    const ids = Array.from(selectedIds);
    if (ids.length === 2) {
      setCompareIds([ids[0], ids[1]]);
    }
  }

  const hasActiveFilters =
    statusFilter !== "all" ||
    scopeFilter !== "all" ||
    priorityFilter !== "all" ||
    evaluabilityFilter !== "all" ||
    searchQuery.trim() !== "" ||
    showBookmarkedOnly;

  if (loading && !data) {
    return (
      <div>
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="flex gap-3 mb-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-10 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-10 w-full mb-4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={refreshData}>
            {t("components:errorBoundary.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("pages:principles.title")}
        description={t("pages:principles.description")}
        onRefresh={refreshData}
      />

      {summary && (
        <div className="flex gap-3 mb-4 flex-wrap">
          <StatCard label={t("pages:principles.active")} value={summary.active} color={STATUS_COLORS.active} />
          <StatCard label={t("pages:principles.candidate")} value={summary.candidate} color={STATUS_COLORS.candidate} />
          <StatCard label={t("pages:principles.probation")} value={summary.probation} color={STATUS_COLORS.probation} />
          <StatCard label={t("pages:principles.deprecated")} value={summary.deprecated} color={STATUS_COLORS.deprecated} />
          <StatCard label={t("pages:principles.total")} value={summary.total} color="text-foreground" />
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5" />
                {t("pages:principles.statusDistribution")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DonutChartWithLegend
                items={[
                  { label: t("pages:principles.active"), value: data.summary.active, color: "hsl(147, 50%, 38%)" },
                  { label: t("pages:principles.candidate"), value: data.summary.candidate, color: "hsl(45, 93%, 47%)" },
                  { label: t("pages:principles.probation"), value: data.summary.probation, color: "hsl(217, 91%, 60%)" },
                  { label: t("pages:principles.deprecated"), value: data.summary.deprecated, color: "hsl(0, 84%, 60%)" },
                  { label: t("pages:principles.archived"), value: data.summary.archived, color: "hsl(0, 0%, 60%)" },
                ].filter((item) => item.value > 0)}
                size={100}
                strokeWidth={16}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5" />
                {t("pages:principles.priorityBreakdown")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <HorizontalBarChart
                items={[
                  { label: "P0", value: data.principles.filter((p) => p.priority === "P0").length, color: "hsl(0, 84%, 60%)" },
                  { label: "P1", value: data.principles.filter((p) => p.priority === "P1").length, color: "hsl(45, 93%, 47%)" },
                  { label: "P2", value: data.principles.filter((p) => p.priority === "P2").length, color: "hsl(0, 0%, 60%)" },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                <Shield className="h-3.5 w-3.5" />
                {t("pages:principles.ruleCoverage")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("pages:principles.withRules")}</div>
                <CoverageIndicator
                  covered={data.principles.filter((p) => p.ruleCount > 0).length}
                  total={data.principles.length}
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("pages:principles.avgRulesPerPrinciple")}</div>
                <div className="text-2xl font-bold">
                  {data.principles.length > 0
                    ? (data.principles.reduce((sum, p) => sum + p.ruleCount, 0) / data.principles.length).toFixed(1)
                    : "0"}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5" />
                {t("pages:principles.valueDistribution")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Histogram buckets={computeValueBuckets(data.principles)} />
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                data-search-input
                type="text"
                placeholder={t("pages:principles.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-10 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2 py-2 rounded-md border border-input bg-background text-xs"
            >
              <option value="all">{t("pages:principles.allStatuses")}</option>
              <option value="active">Active</option>
              <option value="candidate">Candidate</option>
              <option value="probation">Probation</option>
              <option value="deprecated">Deprecated</option>
              <option value="archived">Archived</option>
            </select>

            <select
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
              className="px-2 py-2 rounded-md border border-input bg-background text-xs"
            >
              <option value="all">{t("pages:principles.allScopes")}</option>
              <option value="general">General</option>
              <option value="domain">Domain</option>
            </select>

            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="px-2 py-2 rounded-md border border-input bg-background text-xs"
            >
              <option value="all">{t("pages:principles.allPriorities")}</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
            </select>

            <select
              value={evaluabilityFilter}
              onChange={(e) => setEvaluabilityFilter(e.target.value)}
              className="px-2 py-2 rounded-md border border-input bg-background text-xs"
            >
              <option value="all">{t("pages:principles.allEvaluabilities")}</option>
              <option value="deterministic">Deterministic</option>
              <option value="weak_heuristic">Weak Heuristic</option>
              <option value="manual_only">Manual Only</option>
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-2 py-2 rounded-md border border-input bg-background text-xs"
            >
              <option value="valueScore">{t("pages:principles.sortByValue")}</option>
              <option value="adherenceRate">{t("pages:principles.sortByAdherence")}</option>
              <option value="painPreventedCount">{t("pages:principles.sortByPainPrevented")}</option>
              <option value="updatedAt">{t("pages:principles.sortByUpdated")}</option>
              <option value="createdAt">{t("pages:principles.sortByCreated")}</option>
            </select>

            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-4 w-4 mr-1" />
                {t("common:clear")}
              </Button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant={showBookmarkedOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setShowBookmarkedOnly(!showBookmarkedOnly)}
            >
              <Bookmark className="h-3.5 w-3.5 mr-1" />
              {t("pages:principles.bookmarked")} ({bookmarks.length})
            </Button>
            <Button
              variant={selectionMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setSelectionMode(!selectionMode);
                if (selectionMode) {
                  setSelectedIds(new Set());
                }
              }}
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1" />
              {t("pages:principles.select")}
            </Button>
            {selectionMode && selectedIds.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">
                  {selectedIds.size} {t("pages:principles.selected")}
                </span>
                <Button variant="outline" size="sm" onClick={handleExport}>
                  <Download className="h-3.5 w-3.5 mr-1" />
                  {t("pages:principles.export")}
                </Button>
                {selectedIds.size === 2 && (
                  <Button variant="outline" size="sm" onClick={handleCompare}>
                    <GitCompare className="h-3.5 w-3.5 mr-1" />
                    {t("pages:principles.compare")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                >
                  {t("pages:principles.deselectAll")}
                </Button>
              </>
            )}
            {!selectionMode && (
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="h-3.5 w-3.5 mr-1" />
                {t("pages:principles.exportAll")}
              </Button>
            )}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {t("pages:principles.keyboardHint")}
          </div>
        </CardContent>
      </Card>

      {compareIds && data && (
        <CompareView
          principles={filteredPrinciples.filter((p) => compareIds.includes(p.id))}
          onClose={() => {
            setCompareIds(null);
            setSelectedIds(new Set());
          }}
        />
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">
              {t("pages:principles.principleList")} ({filteredPrinciples.length})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0 max-h-[calc(100vh-420px)] overflow-y-auto">
          {filteredPrinciples.length === 0 ? (
            <EmptyState hasFilters={hasActiveFilters} onClear={clearFilters} />
          ) : (
            filteredPrinciples.map((p, index) => (
              <PrincipleRow
                key={p.id}
                principle={p}
                expanded={expandedIds.has(p.id)}
                onToggle={() => handleRowClick(p.id)}
                detail={principleDetails[p.id] ?? null}
                detailLoading={loadingDetails.has(p.id)}
                isSelected={index === selectedIndex}
                isBookmarked={isBookmarked(p.id)}
                onToggleBookmark={() => toggleBookmark(p.id)}
                selectionMode={selectionMode}
                isChecked={selectedIds.has(p.id)}
                onToggleCheck={() => toggleSelect(p.id)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
