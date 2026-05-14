import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { fetchEvolutionStats, fetchEvolutionTasks, fetchEvolutionPrinciples, fetchEvolutionQueue } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";

interface EvolutionStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  stageDistribution: Array<{ stage: string; count: number }>;
}

interface EvolutionTaskItem {
  taskId: string;
  taskKind: string;
  status: string;
  createdAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface EvolutionTasksData {
  items: EvolutionTaskItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface PrincipleLifecycleSummary {
  candidate: number;
  probation: number;
  active: number;
  deprecated: number;
  archived: number;
  total: number;
}

interface PrincipleTransition {
  principleId: string;
  status: string;
  text: string;
  triggerPattern: string;
  action: string;
  evaluability: string;
  createdAt: string;
  updatedAt: string;
}

interface EvolutionPrinciplesData {
  summary: PrincipleLifecycleSummary;
  recent: PrincipleTransition[];
}

interface QueueHealthData {
  pendingCount: number;
  retryWaitCount: number;
  countsByTaskKind: Record<string, number>;
  countsByChannel: Record<string, number>;
  invalidMetadataCount: number;
  blockedCount: number;
  dependencyFailedCount: number;
  readyTaskCount: number;
  noReadyTasksReason: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "text-amber-500",
  leased: "text-blue-500",
  succeeded: "text-primary",
  retry_wait: "text-purple-500",
  failed: "text-destructive",
};

const PRINCIPLE_STATUS_COLORS: Record<string, string> = {
  candidate: "text-amber-500",
  probation: "text-blue-500",
  active: "text-primary",
  deprecated: "text-destructive",
  archived: "text-muted-foreground",
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

export function EvolutionPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<EvolutionStats | null>(null);
  const [tasks, setTasks] = useState<EvolutionTasksData | null>(null);
  const [principles, setPrinciples] = useState<EvolutionPrinciplesData | null>(null);
  const [queue, setQueue] = useState<QueueHealthData | null>(null);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    Promise.all([
      fetchEvolutionStats(),
      fetchEvolutionPrinciples(),
      fetchEvolutionQueue(),
    ]).then(([statsRes, principlesRes, queueRes]) => {
      if (statsRes.success) setStats(statsRes.data);
      if (principlesRes.success) setPrinciples(principlesRes.data);
      if (queueRes.success) setQueue(queueRes.data);
      setError("");
    }).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    fetchEvolutionTasks(statusFilter, page).then((result) => {
      if (result.success) {
        setTasks(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, [statusFilter, page]);

  const refreshAll = async () => {
    const [statsRes, principlesRes, queueRes] = await Promise.all([
      fetchEvolutionStats(),
      fetchEvolutionPrinciples(),
      fetchEvolutionQueue(),
    ]);
    if (statsRes.success) setStats(statsRes.data);
    if (principlesRes.success) setPrinciples(principlesRes.data);
    if (queueRes.success) setQueue(queueRes.data);
    const tasksRes = await fetchEvolutionTasks(statusFilter, page);
    if (tasksRes.success) setTasks(tasksRes.data);
  };

  if (error && !stats) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => window.location.reload()}>
            {t("components:errorBoundary.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return (
      <div>
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="flex gap-3 mb-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-10 w-20" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("pages:evolution.title")}
        description={t("pages:evolution.description")}
        onRefresh={refreshAll}
      />

      <div className="flex gap-3 mb-6 flex-wrap">
        <StatCard label={t("common:pending")} value={stats.pending} color={STATUS_COLORS.pending} />
        <StatCard label="In Progress" value={stats.inProgress} color={STATUS_COLORS.leased} />
        <StatCard label={t("common:completed")} value={stats.completed} color={STATUS_COLORS.succeeded} />
        <StatCard label={t("common:failed")} value={stats.failed} color={STATUS_COLORS.failed} />
      </div>

      {principles && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{t("pages:evolution.principleLifecycle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mb-4 flex-wrap">
                {Object.entries(principles.summary)
                  .filter(([k]) => k !== "total")
                  .map(([key, value]) => (
                    <Badge key={key} variant="outline" className={PRINCIPLE_STATUS_COLORS[key] ?? ""}>
                      {key}: <strong className="ml-1">{value}</strong>
                    </Badge>
                  ))}
                <Badge variant="secondary">
                  total: <strong className="ml-1">{principles.summary.total}</strong>
                </Badge>
              </div>
              {principles.recent.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">
                    Recent Transitions
                  </h4>
                  {principles.recent.slice(0, 5).map((p, i) => (
                    <div
                      key={`${p.principleId}-${i}`}
                      className="py-2 border-b border-border last:border-0"
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-xs">{p.principleId}</span>
                          <Badge variant="outline" className="text-xs">
                            {p.status}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(p.updatedAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                        {(p.text ?? "").slice(0, 100)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {queue && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">{t("pages:evolution.queueHealth")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-950/20">
                    <div className="text-xl font-bold text-amber-600 dark:text-amber-400">
                      {queue.pendingCount}
                    </div>
                    <div className="text-xs text-muted-foreground">{t("common:pending")}</div>
                  </div>
                  <div className="p-3 rounded-md bg-primary/10">
                    <div className="text-xl font-bold text-primary">{queue.readyTaskCount}</div>
                    <div className="text-xs text-muted-foreground">Ready</div>
                  </div>
                  <div className="p-3 rounded-md bg-purple-50 dark:bg-purple-950/20">
                    <div className="text-xl font-bold text-purple-600 dark:text-purple-400">
                      {queue.retryWaitCount}
                    </div>
                    <div className="text-xs text-muted-foreground">Retry Wait</div>
                  </div>
                  <div className="p-3 rounded-md bg-destructive/10">
                    <div className="text-xl font-bold text-destructive">{queue.blockedCount}</div>
                    <div className="text-xs text-muted-foreground">Blocked</div>
                  </div>
                </div>

                {queue.noReadyTasksReason && (
                  <div className="mt-3 p-2 rounded-md bg-destructive/10 text-xs text-destructive">
                    No ready tasks: {queue.noReadyTasksReason}
                  </div>
                )}

                {Object.keys(queue.countsByTaskKind).length > 0 && (
                  <div className="mt-3">
                    <h4 className="text-xs font-medium text-muted-foreground mb-2">By Task Kind</h4>
                    {Object.entries(queue.countsByTaskKind).map(([kind, count]) => (
                      <div key={kind} className="flex justify-between text-xs py-1">
                        <span className="text-muted-foreground">{kind}</span>
                        <strong>{count}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {stats.stageDistribution.length > 0 && (
        <Card className="mb-6">
          <CardContent className="p-4">
            <h3 className="text-sm font-medium mb-3">Stage Distribution</h3>
            <div className="flex gap-2 flex-wrap">
              {stats.stageDistribution.map((stage) => (
                <Badge key={stage.stage} variant="outline">
                  <span className={STATUS_COLORS[stage.stage] ?? ""}>{stage.stage}</span>: {stage.count}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex justify-between items-center">
            <CardTitle className="text-sm">{t("pages:evolution.taskList")}</CardTitle>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">{t("common:status")}:</label>
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                className="px-2 py-1 rounded-md border border-input bg-background text-xs"
              >
                <option value="all">{t("common:all")}</option>
                <option value="pending">{t("common:pending")}</option>
                <option value="leased">Leased</option>
                <option value="succeeded">{t("common:completed")}</option>
                <option value="retry_wait">Retry Wait</option>
                <option value="failed">{t("common:failed")}</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="max-h-[400px] overflow-y-auto">
          {tasks && tasks.items.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("components:zoneSection.empty")}
            </p>
          )}
          {tasks && tasks.items.map((task) => (
            <div key={task.taskId} className="py-2 border-b border-border last:border-0">
              <div className="flex justify-between items-center">
                <div>
                  <span className={`font-medium text-xs ${STATUS_COLORS[task.status] ?? ""}`}>
                    {task.taskId.slice(0, 16)}...
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">{task.taskKind}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {task.status}
                  </Badge>
                  {task.leaseOwner && (
                    <span className="text-xs text-muted-foreground">
                      leased by {task.leaseOwner.slice(0, 8)}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {new Date(task.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </CardContent>
        {tasks && tasks.pagination.totalPages > 1 && (
          <div className="flex justify-center items-center gap-3 p-3 border-t border-border">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {tasks.pagination.page} / {tasks.pagination.totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= tasks.pagination.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
