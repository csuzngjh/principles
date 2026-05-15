import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TaskZones, TaskItem, TaskEvidence } from "../../types.js";
import { fetchTasks, fetchTaskEvidence, approveTask, rejectTask, cleanupTask, checkAuth } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Separator } from "../components/ui/separator.js";
import { ChevronRight, Trash2, Check, X, Undo2, AlertCircle } from "lucide-react";

interface UndoEntry {
  task: TaskItem;
  zone: keyof TaskZones;
  timer: ReturnType<typeof setTimeout>;
  action: "approve" | "reject";
  countdown: number;
}

const ZONE_CONFIG = [
  { key: "needsConfirmation" as const, label: "needsConfirmation", color: "bg-red-50 border-red-200", headerColor: "bg-red-100", badgeColor: "bg-red-500" },
  { key: "suggestedAttention" as const, label: "suggestedAttention", color: "bg-amber-50 border-amber-200", headerColor: "bg-amber-100", badgeColor: "bg-amber-500" },
  { key: "recentActivity" as const, label: "recentActivity", color: "bg-blue-50 border-blue-200", headerColor: "bg-blue-100", badgeColor: "bg-blue-500" },
];

const taskKindToAgent: Record<string, { id: string; label: string }> = {
  diagnostician: { id: 'diagnostician', label: '诊断者' },
  sleep_reflection: { id: 'nocturnal-reflection', label: '夜间反思' },
  keyword_optimization: { id: 'correction-observer', label: '纠正观察者' },
  principle_candidate_intake: { id: 'diagnostician', label: '诊断者' },
};

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}

function TaskCard({
  task,
  expanded,
  evidence,
  evidenceLoading,
  onToggleExpand,
  onApprove,
  onReject,
  onCleanup,
  undoState,
  undoTimer,
  onUndo,
}: {
  task: TaskItem;
  expanded: boolean;
  evidence: TaskEvidence | null;
  evidenceLoading: boolean;
  onToggleExpand: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCleanup: () => void;
  undoState: "approve" | "reject" | null;
  undoTimer: number | null;
  onUndo: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Card className="mb-3 transition-all duration-200 hover:shadow-sm">
      <CardContent className="p-4">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex items-start justify-between cursor-pointer w-full text-left"
          onClick={onToggleExpand}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-xs">
                {task.kind}
              </Badge>
              {taskKindToAgent[task.title] && (
                <a
                  href={`#/agents/${taskKindToAgent[task.title].id}`}
                  className="text-xs text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {taskKindToAgent[task.title].label}
                </a>
              )}
              <span className="text-xs text-muted-foreground">
                {timeAgo(new Date(task.createdAt))}
              </span>
            </div>
            <p className="font-medium text-sm truncate">{task.title}</p>
            <p className="text-xs text-muted-foreground mt-1">{task.sourceSummary}</p>
          </div>
          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          />
        </button>

        <div
          className={`overflow-hidden transition-all duration-300 ${expanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"}`}
        >
          <Separator className="my-3" />
          {evidenceLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : evidence ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("components:evidencePanel.summary")}
                </p>
                <p className="text-sm">{evidence.summary}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("components:evidencePanel.why")}
                </p>
                <p className="text-sm">{evidence.why}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("components:evidencePanel.whatHappens")}
                </p>
                <p className="text-sm">{evidence.whatHappensIf}</p>
              </div>
            </div>
          ) : null}
          <Separator className="my-3" />
          <div className="flex items-center gap-2">
            {undoState ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onUndo();
                }}
                className="flex items-center gap-1"
              >
                <Undo2 className="h-3 w-3" />
                {t("components:taskCard.undo")} ({undoTimer}s)
              </Button>
            ) : (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprove();
                  }}
                  className="flex items-center gap-1"
                >
                  <Check className="h-3 w-3" />
                  {t("components:taskCard.approve")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReject();
                  }}
                  className="flex items-center gap-1"
                >
                  <X className="h-3 w-3" />
                  {t("components:taskCard.reject")}
                </Button>
                {task.kind === "cleanup" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCleanup();
                    }}
                    className="flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t("components:taskCard.cleanup")}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-8 w-32" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      {ZONE_CONFIG.map((zone) => (
        <Card key={zone.key} className={`${zone.color} mb-6`}>
          <CardHeader className={zone.headerColor}>
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-4 w-24 mb-2" />
                  <Skeleton className="h-4 w-full mb-2" />
                  <Skeleton className="h-4 w-3/4" />
                </CardContent>
              </Card>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TasksPageInner() {
  const { t } = useTranslation();
  const [zones, setZones] = useState<TaskZones>({
    needsConfirmation: [],
    suggestedAttention: [],
    recentActivity: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [evidenceCache, setEvidenceCache] = useState<Map<string, TaskEvidence>>(new Map());
  const [loadingEvidenceIds, setLoadingEvidenceIds] = useState<Set<string>>(new Set());
  const [undoMap, setUndoMap] = useState<Map<string, UndoEntry>>(new Map());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const undoMapRef = useRef(undoMap);
  undoMapRef.current = undoMap;

  useEffect(() => {
    return () => {
      undoMapRef.current.forEach((entry) => clearTimeout(entry.timer));
    };
  }, []);

  useEffect(() => {
    if (undoMap.size === 0) return;
    const interval = setInterval(() => {
      setUndoMap((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const [id, entry] of next) {
          const newCountdown = entry.countdown - 1;
          if (newCountdown <= 0) continue;
          next.set(id, { ...entry, countdown: newCountdown });
          changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [undoMap.size]);

  async function loadData() {
    const result = await fetchTasks();
    if (!result.success) {
      setError(result.error ?? "加载失败");
    } else {
      setZones(result.data);
      setLastUpdated(new Date());
      setError(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (cancelled) return;
      await loadData();
    }
    load();
    const intervalId = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  async function handleToggleExpand(id: string) {
    const nextExpanded = new Set(expandedIds);
    if (nextExpanded.has(id)) {
      nextExpanded.delete(id);
    } else {
      nextExpanded.add(id);
      if (!evidenceCache.has(id) && !loadingEvidenceIds.has(id)) {
        setLoadingEvidenceIds((prev) => {
          const n = new Set(prev);
          n.add(id);
          return n;
        });
        const result = await fetchTaskEvidence(id);
        if (result.success && result.data) {
          setEvidenceCache((prev) => {
            const n = new Map(prev);
            n.set(id, result.data!);
            return n;
          });
        }
        setLoadingEvidenceIds((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }
    }
    setExpandedIds(nextExpanded);
  }

  function handleApprove(taskId: string, zone: keyof TaskZones) {
    const task = zones[zone].find((t) => t.id === taskId);
    if (!task) return;
    setZones((prev) => ({ ...prev, [zone]: prev[zone].filter((t) => t.id !== taskId) }));
    const timer = setTimeout(async () => {
      setUndoMap((prev) => {
        const n = new Map(prev);
        n.delete(taskId);
        return n;
      });
      const result = await approveTask(taskId);
      if (!result.success) {
        setZones((prev) => ({ ...prev, [zone]: [task, ...prev[zone]] }));
        setError(`操作失败: ${result.error ?? "未知错误"}`);
      }
    }, 5000);
    setUndoMap((prev) => {
      const n = new Map(prev);
      n.set(taskId, { task, zone, timer, action: "approve", countdown: 5 });
      return n;
    });
  }

  function handleReject(taskId: string, zone: keyof TaskZones) {
    const task = zones[zone].find((t) => t.id === taskId);
    if (!task) return;
    setZones((prev) => ({ ...prev, [zone]: prev[zone].filter((t) => t.id !== taskId) }));
    const timer = setTimeout(async () => {
      setUndoMap((prev) => {
        const n = new Map(prev);
        n.delete(taskId);
        return n;
      });
      const result = await rejectTask(taskId);
      if (!result.success) {
        setZones((prev) => ({ ...prev, [zone]: [task, ...prev[zone]] }));
        setError(`操作失败: ${result.error ?? "未知错误"}`);
      }
    }, 5000);
    setUndoMap((prev) => {
      const n = new Map(prev);
      n.set(taskId, { task, zone, timer, action: "reject", countdown: 5 });
      return n;
    });
  }

  function handleUndo(taskId: string) {
    const entry = undoMap.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    setZones((prev) => ({ ...prev, [entry.zone]: [entry.task, ...prev[entry.zone]] }));
    setUndoMap((prev) => {
      const n = new Map(prev);
      n.delete(taskId);
      return n;
    });
  }

  async function handleBatchCleanup() {
    const cleanupTasks = zones.suggestedAttention.filter((t) => t.kind === "cleanup");
    let failed = 0;
    for (const t of cleanupTasks) {
      const result = await cleanupTask(t.id);
      if (result.success) {
        setZones((prev) => ({
          ...prev,
          suggestedAttention: prev.suggestedAttention.filter((st) => st.id !== t.id),
        }));
      } else {
        failed++;
      }
    }
    if (failed > 0) {
      setError(`批量清理完成，${failed}/${cleanupTasks.length} 项失败`);
    }
  }

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-destructive">{error}</p>
          </div>
          <Button variant="outline" className="mt-4" onClick={loadData}>
            {t("common:refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const zoneLabels: Record<string, string> = {
    needsConfirmation: t("pages:tasks.needsConfirmation"),
    suggestedAttention: t("pages:tasks.suggestedAttention"),
    recentActivity: t("pages:tasks.recentActivity"),
  };

  return (
    <div>
      <PageHeader
        title={t("pages:tasks.title")}
        description={t("pages:tasks.description")}
        onRefresh={loadData}
        lastUpdated={lastUpdated ?? undefined}
      />

      {ZONE_CONFIG.map((zone) => {
        const tasks = zones[zone.key];
        const hasCleanupTasks = tasks.some((t) => t.kind === "cleanup");

        return (
          <Card key={zone.key} className={`${zone.color} border-l-4 mb-6`}>
            <CardHeader className={zone.headerColor}>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-medium">
                  {zoneLabels[zone.label]}
                </CardTitle>
                <Badge className={zone.badgeColor}>{tasks.length}</Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {t("components:zoneSection.empty")}
                </p>
              ) : (
                tasks.map((task) => {
                  const undo = undoMap.get(task.id);
                  return (
                    <TaskCard
                      key={task.id}
                      task={task}
                      expanded={expandedIds.has(task.id)}
                      evidence={evidenceCache.get(task.id) ?? null}
                      evidenceLoading={loadingEvidenceIds.has(task.id)}
                      onToggleExpand={() => handleToggleExpand(task.id)}
                      onApprove={() => handleApprove(task.id, zone.key)}
                      onReject={() => handleReject(task.id, zone.key)}
                      onCleanup={async () => {
                        const result = await cleanupTask(task.id);
                        if (result.success) {
                          setZones((prev) => ({
                            ...prev,
                            [zone.key]: prev[zone.key].filter((t) => t.id !== task.id),
                          }));
                        }
                      }}
                      undoState={undo?.action ?? null}
                      undoTimer={undo?.countdown ?? null}
                      onUndo={() => handleUndo(task.id)}
                    />
                  );
                })
              )}
              {zone.key === "suggestedAttention" && hasCleanupTasks && (
                <div className="mt-4 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBatchCleanup}
                    className="bg-amber-100 hover:bg-amber-200 border-amber-300 text-amber-700"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    {t("pages:tasks.batchCleanup")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function TasksPage() {
  const { t } = useTranslation();
  const [hasToken, setHasToken] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    checkAuth().then((valid) => {
      setHasToken(valid);
      setChecking(false);
    });
  }, []);

  if (checking) {
    return (
      <Card className="max-w-md mx-auto mt-12">
        <CardContent className="p-8 text-center">
          <div className="animate-pulse">Checking authentication...</div>
        </CardContent>
      </Card>
    );
  }

  if (!hasToken) {
    return (
      <Card className="max-w-md mx-auto mt-12">
        <CardContent className="p-8 text-center">
          <AlertCircle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
          <CardTitle className="text-xl mb-2">
            {t("pages:tasks.noToken")}
          </CardTitle>
          <CardDescription className="mb-4">
            {t("pages:tasks.noToken")}
          </CardDescription>
          <Button asChild>
            <a href="#/settings">{t("common:settings")}</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <TasksPageInner />;
}
