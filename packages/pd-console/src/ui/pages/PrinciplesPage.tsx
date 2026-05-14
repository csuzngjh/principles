import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { fetchPrinciples, fetchPrincipleDetail } from "../api.js";
import type { PrincipleListItem, PrincipleDetail, RuleItem } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Button } from "../components/ui/button.js";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Shield,
  Zap,
  Eye,
  X,
} from "lucide-react";

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
        <div className={`text-2xl font-bold ${color}`}>{value}</div>
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
        <Badge variant="outline" className={`text-xs ${ENFORCEMENT_COLORS[rule.enforcement] ?? ""}`}>
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

function PrincipleRow({
  principle,
  expanded,
  onToggle,
  detail,
  detailLoading,
}: {
  principle: PrincipleListItem;
  expanded: boolean;
  onToggle: () => void;
  detail: PrincipleDetail | null;
  detailLoading: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="border-b border-border last:border-0">
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
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
            <Badge variant="outline" className={`text-xs ${STATUS_COLORS[principle.status]}`}>
              {principle.status}
            </Badge>
            <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[principle.priority]}`}>
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
          <p className="text-xs text-muted-foreground line-clamp-2">
            {principle.text}
          </p>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              {t("pages:principles.valueScore")}: {principle.valueScore.toFixed(1)}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {t("pages:principles.adherence")}: {(principle.adherenceRate * 100).toFixed(0)}%
            </span>
            <span>
              {t("pages:principles.painPrevented")}: {principle.painPreventedCount}
            </span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground flex-shrink-0">
          {principle.updatedAt ? new Date(principle.updatedAt).toLocaleDateString() : ""}
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
                <div className={`p-2 rounded-md ${STATUS_BG[principle.status]}`}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.triggerPattern")}</div>
                  <div className="text-xs font-medium mt-0.5">{principle.triggerPattern || "—"}</div>
                </div>
                <div className={`p-2 rounded-md ${STATUS_BG[principle.status]}`}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.action")}</div>
                  <div className="text-xs font-medium mt-0.5">{principle.action || "—"}</div>
                </div>
                <div className={`p-2 rounded-md ${STATUS_BG[principle.status]}`}>
                  <div className="text-xs text-muted-foreground">{t("pages:principles.evaluability")}</div>
                  <div className="text-xs font-medium mt-0.5">{principle.evaluability}</div>
                </div>
                <div className={`p-2 rounded-md ${STATUS_BG[principle.status]}`}>
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

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [principleDetails, setPrincipleDetails] = useState<Record<string, PrincipleDetail>>({});
  const [loadingDetails, setLoadingDetails] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadData();
  }, []);

  function loadData() {
    setLoading(true);
    setError("");
    fetchPrinciples()
      .then((result) => {
        if (result.success && result.data) {
          setData(result.data);
        } else if (!result.success) {
          setError(result.error);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

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
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
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
  }, [data, statusFilter, scopeFilter, priorityFilter, evaluabilityFilter, searchQuery, sortBy]);

  async function toggleExpand(principleId: string) {
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
  }

  function clearFilters() {
    setSearchQuery("");
    setStatusFilter("all");
    setScopeFilter("all");
    setPriorityFilter("all");
    setEvaluabilityFilter("all");
  }

  const hasActiveFilters =
    statusFilter !== "all" ||
    scopeFilter !== "all" ||
    priorityFilter !== "all" ||
    evaluabilityFilter !== "all" ||
    searchQuery.trim() !== "";

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
          <Button variant="outline" className="mt-4" onClick={loadData}>
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
        onRefresh={loadData}
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

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder={t("pages:principles.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 rounded-md border border-input bg-background text-sm"
              />
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">
              {t("pages:principles.principleList")} ({filteredPrinciples.length})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0 max-h-[calc(100vh-380px)] overflow-y-auto">
          {filteredPrinciples.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("components:zoneSection.empty")}
            </p>
          )}
          {filteredPrinciples.map((p) => (
            <PrincipleRow
              key={p.id}
              principle={p}
              expanded={expandedIds.has(p.id)}
              onToggle={() => toggleExpand(p.id)}
              detail={principleDetails[p.id] ?? null}
              detailLoading={loadingDetails.has(p.id)}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
