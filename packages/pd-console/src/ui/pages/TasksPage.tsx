import { useState, useEffect, useRef } from "react";
import type { TaskZones, TaskItem, TaskEvidence } from "../../types.js";
import { fetchTasks, fetchTaskEvidence, approveTask, rejectTask, cleanupTask, getToken } from "../api.js";
import { zoneTitle } from "../i18n.js";
import { ZoneSection } from "../components/ZoneSection.js";
import { TaskCard } from "../components/TaskCard.js";
import { COLORS, LOADING_STYLE, ERROR_STYLE, REFRESH_BAR, BUTTON_APPROVE } from "../styles/constants.js";

interface UndoEntry {
  task: TaskItem;
  zone: keyof TaskZones;
  timer: ReturnType<typeof setTimeout>;
  action: "approve" | "reject";
  countdown: number;
}

const ZONE_CONFIG = [
  { key: "needsConfirmation" as const, bg: COLORS.zoneRed, border: COLORS.zoneRedBorder, headerBg: COLORS.zoneRedHeaderBg },
  { key: "suggestedAttention" as const, bg: COLORS.zoneYellow, border: COLORS.zoneYellowBorder, headerBg: COLORS.zoneYellowHeaderBg },
  { key: "recentActivity" as const, bg: COLORS.zoneWhite, border: COLORS.zoneWhiteBorder, headerBg: COLORS.zoneWhiteHeaderBg },
];

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}

function TasksPageInner() {
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
      undoMapRef.current.forEach(entry => clearTimeout(entry.timer));
    };
  }, []);

  useEffect(() => {
    if (undoMap.size === 0) return;
    const interval = setInterval(() => {
      setUndoMap(prev => {
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
    if (result.success && result.data) {
      setZones(result.data);
      setLastUpdated(new Date());
      setError(null);
    } else {
      setError(result.error ?? "加载失败");
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
    return () => { cancelled = true; clearInterval(intervalId); };
  }, []);

  async function handleToggleExpand(id: string) {
    const nextExpanded = new Set(expandedIds);
    if (nextExpanded.has(id)) {
      nextExpanded.delete(id);
    } else {
      nextExpanded.add(id);
      if (!evidenceCache.has(id) && !loadingEvidenceIds.has(id)) {
        setLoadingEvidenceIds(prev => { const n = new Set(prev); n.add(id); return n; });
        const result = await fetchTaskEvidence(id);
        if (result.success && result.data) {
          setEvidenceCache(prev => { const n = new Map(prev); n.set(id, result.data!); return n; });
        }
        setLoadingEvidenceIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      }
    }
    setExpandedIds(nextExpanded);
  }

  function handleApprove(taskId: string, zone: keyof TaskZones) {
    const task = zones[zone].find(t => t.id === taskId);
    if (!task) return;
    setZones(prev => ({ ...prev, [zone]: prev[zone].filter(t => t.id !== taskId) }));
    const timer = setTimeout(() => {
      approveTask(taskId);
      setUndoMap(prev => { const n = new Map(prev); n.delete(taskId); return n; });
    }, 5000);
    setUndoMap(prev => { const n = new Map(prev); n.set(taskId, { task, zone, timer, action: "approve", countdown: 5 }); return n; });
  }

  function handleReject(taskId: string, zone: keyof TaskZones) {
    const task = zones[zone].find(t => t.id === taskId);
    if (!task) return;
    setZones(prev => ({ ...prev, [zone]: prev[zone].filter(t => t.id !== taskId) }));
    const timer = setTimeout(() => {
      rejectTask(taskId);
      setUndoMap(prev => { const n = new Map(prev); n.delete(taskId); return n; });
    }, 5000);
    setUndoMap(prev => { const n = new Map(prev); n.set(taskId, { task, zone, timer, action: "reject", countdown: 5 }); return n; });
  }

  function handleUndo(taskId: string) {
    const entry = undoMap.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    setZones(prev => ({ ...prev, [entry.zone]: [entry.task, ...prev[entry.zone]] }));
    setUndoMap(prev => { const n = new Map(prev); n.delete(taskId); return n; });
  }

  async function handleBatchCleanup() {
    const cleanupTasks = zones.suggestedAttention.filter(t => t.kind === "cleanup");
    for (const t of cleanupTasks) {
      const result = await cleanupTask(t.id);
      if (result.success) {
        setZones(prev => ({
          ...prev,
          suggestedAttention: prev.suggestedAttention.filter(st => st.id !== t.id),
        }));
      }
    }
  }

  if (loading) return <div style={LOADING_STYLE}>加载中...</div>;
  if (error) return <div style={ERROR_STYLE}>{error}</div>;

  return (
    <div>
      <div style={REFRESH_BAR}>
        <h1 style={{ margin: 0 }}>待办事项</h1>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          {lastUpdated && (
            <span style={{ fontSize: "12px", color: "#999" }}>
              最后更新: {timeAgo(lastUpdated)}
            </span>
          )}
          <button style={BUTTON_APPROVE} onClick={loadData}>刷新</button>
        </div>
      </div>
      {ZONE_CONFIG.map(zone => {
        const tasks = zones[zone.key];
        const hasCleanupTasks = tasks.some(t => t.kind === "cleanup");
        return (
          <ZoneSection
            key={zone.key}
            title={zoneTitle(zone.key)}
            count={tasks.length}
            bgColor={zone.bg}
            borderColor={zone.border}
            headerBgColor={zone.headerBg}
          >
            {tasks.map(task => {
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
                      setZones(prev => ({ ...prev, [zone.key]: prev[zone.key].filter(t => t.id !== task.id) }));
                    }
                  }}
                  undoState={undo?.action ?? null}
                  undoTimer={undo?.countdown ?? null}
                  onUndo={() => handleUndo(task.id)}
                />
              );
            })}
            {zone.key === "suggestedAttention" && hasCleanupTasks && (
              <div style={{ marginTop: "8px" }}>
                <button
                  style={{ ...BUTTON_APPROVE, backgroundColor: "#faad14" }}
                  onClick={handleBatchCleanup}
                >
                  批量清理
                </button>
              </div>
            )}
          </ZoneSection>
        );
      })}
    </div>
  );
}

export function TasksPage() {
  const [hasToken] = useState(() => !!getToken());

  if (!hasToken) {
    return (
      <div style={{ padding: "60px 24px", textAlign: "center" }}>
        <h2 style={{ marginBottom: "12px", color: "#333" }}>请先设置访问令牌</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          前往 <a href="#/settings" style={{ color: "#1677ff", fontWeight: 500 }}>设置页面</a> 输入令牌后即可使用
        </p>
      </div>
    );
  }

  return <TasksPageInner />;
}
